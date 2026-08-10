import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { basename, dirname, join } from "path";
import { homedir, tmpdir } from "os";
import { gunzipSync } from "zlib";
import db from "./db.js";
import { pickTitle } from "./title.js";
import { archivePathFor, archiveSession } from "./archive.js";
import { tallyUnknownRecordTypes, parseJsonlLines } from "./canary.js";
import { isSummaryStale } from "./summary-staleness.js";
import {
  extractFileReferences,
  projectHeader,
  projectMessages,
  type ProjectedRow,
  type ProjectionSource,
} from "./projection.js";
import { buildTraceFromFile, shapeTraceForResponse } from "./trace/index.js";

// ── Config ─────────────────────────────────────────────────────────

const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

// ── Types ─────────────────────────────────────────────────────────

export interface IngestProgress {
  total: number;
  ingested: number;
  skipped: number;
  running: boolean;
}

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Decode a Claude projects directory name to a workspace path.
 * The encoding replaces `/` with `-`, so `-Users-blake-...` => `/Users/blake/...`
 *
 * Since folder names can contain dashes, we greedily match from left to right,
 * picking the longest existing directory segment at each level.
 */
function decodeDirName(dirName: string): string | null {
  // The dir name starts with `-` representing the leading `/`
  if (!dirName.startsWith("-")) return null;

  const rest = dirName.slice(1); // remove leading `-`
  const segments = rest.split("-");

  let currentPath = "/";
  let i = 0;

  while (i < segments.length) {
    // Try greedy: longest match first
    let matched = false;
    for (let end = segments.length; end > i; end--) {
      const candidate = segments.slice(i, end).join("-");
      const testPath = join(currentPath, candidate);
      try {
        if (existsSync(testPath) && statSync(testPath).isDirectory()) {
          currentPath = testPath;
          i = end;
          matched = true;
          break;
        }
      } catch {
        // permission denied or similar
      }
    }
    if (!matched) {
      // Can't resolve further — join remaining as single segment
      const remaining = segments.slice(i).join("-");
      currentPath = join(currentPath, remaining);
      break;
    }
  }

  return currentPath;
}

const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"];

/** Screenshots/images pasted into a session are excluded from session_files
 * — they're not "created files" worth tracking. Extended beyond png/jpg so
 * gif/webp/svg pastes don't leak into file search/listing either. */
function isImageFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function displayName(workspacePath: string): string {
  const parts = workspacePath.split("/").filter(Boolean);
  // Return last 2-3 meaningful segments
  if (parts.length <= 2) return parts.join("/");

  // If path contains .claude/worktrees, include the worktree name + parent project
  const worktreeIdx = parts.indexOf(".claude");
  if (worktreeIdx >= 1 && parts[worktreeIdx + 1] === "worktrees") {
    const projectName = parts[worktreeIdx - 1];
    const worktreeName = parts[worktreeIdx + 2];
    return worktreeName ? `${projectName}/${worktreeName}` : projectName;
  }

  // Otherwise last 2 segments
  return parts.slice(-2).join("/");
}

// Title-picking (isTitleWorthy, stripAnsiCodes, pickTitle) lives in ./title.ts
// — pure, DB-free, and unit-tested there.

// ── Cheap header read ──────────────────────────────────────────────

/** How many bytes off the front of a transcript `readSessionHeader` reads.
 *  Generous enough to hold several real records (a Claude Code JSONL line is
 *  typically well under 8 KB) and small enough that reading it off a 47 MB
 *  transcript is free. */
const HEADER_READ_BYTES = 64 * 1024;
/** How many leading records to inspect for a `cwd`. */
const HEADER_SCAN_RECORDS = 20;

/**
 * Read a transcript's workspace path (`cwd`) by JSON-parsing only the first
 * few records. Used solely to resolve a never-seen project directory to a
 * workspace — the one place ingest needs a single header field and nothing
 * else.
 *
 * This replaces a full `stripSession` (now: a full vendored parse) of up to
 * three files per unknown directory. Parsing a 47 MB transcript to read one
 * string is the kind of cost that used to make every ~30s tick expensive.
 *
 * Returns `{ cwd: null }` for anything unreadable, empty, or headerless —
 * callers fall back to decoding the directory name.
 */
export function readSessionHeader(jsonlPath: string): { cwd: string | null } {
  let fd: number | null = null;
  try {
    fd = openSync(jsonlPath, "r");
    const buffer = Buffer.alloc(HEADER_READ_BYTES);
    const bytesRead = readSync(fd, buffer, 0, HEADER_READ_BYTES, 0);
    const lines = buffer.subarray(0, bytesRead).toString("utf-8").split("\n");
    // The last line is a partial record whenever the read hit the byte cap
    // rather than EOF — dropping it avoids a guaranteed JSON.parse failure.
    if (bytesRead === HEADER_READ_BYTES) lines.pop();

    for (const line of lines.slice(0, HEADER_SCAN_RECORDS)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const record = JSON.parse(trimmed) as { cwd?: unknown };
        if (typeof record.cwd === "string" && record.cwd) return { cwd: record.cwd };
      } catch {
        // malformed line — try the next one
      }
    }
  } catch {
    // unreadable file — caller falls back to decodeDirName
  } finally {
    if (fd !== null) closeSync(fd);
  }
  return { cwd: null };
}

// ── Prepared Statements ────────────────────────────────────────────

const getWorkspace = db.prepare(`SELECT id FROM workspaces WHERE path = ?`);
const getWorkspaceByDirName = db.prepare(
  `SELECT id, path FROM workspaces WHERE dir_name = ?`
);

const insertWorkspace = db.prepare(`
  INSERT INTO workspaces (path, dir_name, display_name) VALUES (?, ?, ?)
`);

const updateWorkspaceStats = db.prepare(`
  UPDATE workspaces SET
    session_count = (SELECT COUNT(*) FROM sessions WHERE workspace_id = ?),
    last_activity = (SELECT MAX(ended_at) FROM sessions WHERE workspace_id = ?)
  WHERE id = ?
`);

const sessionExists = db.prepare(`SELECT 1 FROM sessions WHERE id = ?`);
const sessionFileStat = db.prepare(
  `SELECT file_size, file_mtime FROM sessions WHERE id = ?`
);

/**
 * The reingest predicate (D10): a session is stale when its file's size OR its
 * mtime differs from what was recorded at the last ingest. Size alone missed
 * in-place rewrites that landed on the same byte count.
 *
 * `storedMtime === null` (every row written before the `file_mtime` column
 * existed) deliberately falls back to size-only. Treating NULL as "differs"
 * would mark all ~3,300 legacy sessions stale at once and make the next 30s
 * tick try to re-parse the entire 14 GB corpus. The planned force-reingest
 * (plan U8) is the controlled way to backfill those rows.
 *
 * Pure so the trigger and any future health/pending count share one
 * definition (plan U6 depends on that).
 */
export function needsReingestForStat(
  stored: { file_size: number | null; file_mtime: number | null },
  current: { size: number; mtimeMs: number }
): boolean {
  if (stored.file_size !== current.size) return true;
  if (stored.file_mtime === null || stored.file_mtime === undefined) return false;
  return stored.file_mtime !== Math.round(current.mtimeMs);
}

// ── Ingest Health (plan U6) ────────────────────────────────────────
// Truthful health surface for `GET /api/ingest/status`: in-memory only, no
// new tables. `lastTickAt` marks when a `runIngestion` tick last RESOLVED —
// not set if a tick throws, since a tick that never finished isn't "the last
// completed one". `recentFailures` is a capped ring buffer fed from
// `ingestSession`'s catch/skip paths that represent a REAL failure (bytes
// that couldn't be found or parsed) — deliberately NOT the routine
// "unchanged, nothing to do" skip that ~all sessions hit on ~every tick.

export interface IngestFailure {
  sessionId: string;
  message: string;
  timestamp: string;
}

/** ~20 per the plan — enough recent history to be useful, small enough that
 * a bad run can't grow this without bound. */
export const MAX_RECENT_FAILURES = 20;

let lastTickAt: string | null = null;
const recentFailures: IngestFailure[] = [];

function recordIngestFailure(sessionId: string, message: string): void {
  recentFailures.push({ sessionId, message, timestamp: new Date().toISOString() });
  if (recentFailures.length > MAX_RECENT_FAILURES) {
    recentFailures.splice(0, recentFailures.length - MAX_RECENT_FAILURES);
  }
}

const getAllSessionsWithSourcePath = db.prepare(
  `SELECT id, source_path, file_size, file_mtime FROM sessions WHERE source_path IS NOT NULL`
);

/**
 * Number of ingested sessions whose on-disk transcript has changed since the
 * last ingest — i.e. what the next auto-ingest tick would pick up. Runs the
 * SAME `needsReingestForStat` predicate `ingestSession`'s own auto-reingest
 * gate (above) uses, so the health count and the trigger can never drift
 * apart (plan U6's whole point). A session whose file no longer exists on
 * disk is NOT "pending" — there's nothing to stat against, and the archive
 * fallback (a separate mechanism) is what covers that case.
 */
export function getPendingCount(): number {
  const rows = getAllSessionsWithSourcePath.all() as Array<{
    id: string;
    source_path: string;
    file_size: number | null;
    file_mtime: number | null;
  }>;

  let pending = 0;
  for (const row of rows) {
    try {
      const stat = statSync(row.source_path);
      if (needsReingestForStat({ file_size: row.file_size, file_mtime: row.file_mtime }, stat)) {
        pending++;
      }
    } catch {
      // File gone — nothing on disk to compare against.
    }
  }
  return pending;
}

export interface IngestHealth {
  lastTickAt: string | null;
  pendingCount: number;
  recentFailures: IngestFailure[];
}

/** Never throws — a status endpoint reporting on ingest health must not
 * itself become a new way for ingest health to be unreportable. */
export function getIngestHealth(): IngestHealth {
  let pendingCount = 0;
  try {
    pendingCount = getPendingCount();
  } catch {
    // A DB hiccup here shouldn't take the whole status endpoint down with it.
  }
  return {
    lastTickAt,
    pendingCount,
    recentFailures: [...recentFailures],
  };
}

/** Test-only. The state above is a process-lifetime singleton — correct for
 * production, but `bun test` runs many independent cases in one process, so
 * tests need a way to zero it between cases. Not used by any production
 * code path. */
export function __resetIngestHealthForTesting(): void {
  lastTickAt = null;
  recentFailures.length = 0;
}

// Reingest (triggered by a file-size change) deletes and reinserts the
// session row, which would otherwise silently wipe every LLM-derived column
// — not just `summary` (the old bug), but `summary_short` and the
// insights/events extraction flags too. Preserve all of them so a session
// growing on disk never re-triggers redundant LLM work. summary_retry_count
// and summary_failed_at are intentionally NOT preserved here — reingest is a
// reasonable point to give a previously-stuck summary a fresh attempt (and
// insertSession's fresh row naturally defaults both back to 0/NULL anyway).
//
// summary/summary_short/summarized_message_count are the exception: they're
// only restored when the summary isn't stale (see isSummaryStale in
// summary-staleness.ts) — a session that grew a lot since it was summarized
// gets its summary dropped instead, so the next auto-summarize tick redoes
// it once rather than keeping a permanently-stale summary forever.
// insights_extracted/events_extracted stay preserved unconditionally
// (expensive Sonnet work — deliberate).
interface PreservedDerivedData {
  summary: string | null;
  summary_short: string | null;
  summarized_message_count: number | null;
  summarized_at: string | null;
  insights_extracted: number;
  events_extracted: number;
}

const sessionDerivedData = db.prepare(`
  SELECT summary, summary_short, summarized_message_count, summarized_at, insights_extracted, events_extracted
  FROM sessions WHERE id = ?
`);
const restoreInsightsAndEvents = db.prepare(`
  UPDATE sessions SET insights_extracted = ?, events_extracted = ? WHERE id = ?
`);
const restoreSummaryFields = db.prepare(`
  UPDATE sessions
  SET summary = ?, summary_short = ?, summarized_message_count = ?, summarized_at = ?
  WHERE id = ?
`);
const getMessageCount = db.prepare(`SELECT message_count FROM sessions WHERE id = ?`);

const insertSession = db.prepare(`
  INSERT INTO sessions (id, workspace_id, source_path, started_at, ended_at, git_branch, title, message_count, user_message_count, file_size, file_mtime, trace_meta, ingested_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

// `title`/`workspace` are the FTS facet columns (D4): external-content FTS5
// reads each indexed column from the SAME-NAMED column of `messages`, so
// faceted search only works if every row carries them. `record_uuid` is the
// join key into `raw_records` (D2).
const insertMessage = db.prepare(`
  INSERT INTO messages (session_id, role, content, timestamp, sequence, message_type, source, tool_use_id, tool_name, tool_input, record_uuid, title, workspace)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

// One row per RAW JSONL record, verbatim (D2) — the full-fidelity half of
// "clean projection + raw payload side by side".
const insertRawRecord = db.prepare(`
  INSERT INTO raw_records (session_id, uuid, seq, raw) VALUES (?, ?, ?, ?)
`);

// One row per lean trace chunk (D3), so `GET /api/sessions/:id/trace` becomes
// a pure SQL read instead of a per-request re-parse of the original JSONL.
const insertTraceChunk = db.prepare(`
  INSERT INTO trace_chunks (session_id, chunk_seq, chunk_type, started_at, ended_at, payload)
  VALUES (?, ?, ?, ?, ?, ?)
`);

// The `workspace` facet stores the workspace's display name (what the UI and
// a faceted `workspace: terra` MATCH both show), not its numeric id.
const getWorkspaceDisplayName = db.prepare(
  `SELECT display_name FROM workspaces WHERE id = ?`
);

const insertFile = db.prepare(`
  INSERT INTO session_files (session_id, file_path, file_name, operation, timestamp, sequence)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const updateSessionCounts = db.prepare(`
  UPDATE sessions SET
    message_count = (SELECT COUNT(*) FROM messages WHERE session_id = ?),
    user_message_count = (SELECT COUNT(*) FROM messages WHERE session_id = ? AND role = 'user')
  WHERE id = ?
`);

const deleteSessionFiles = db.prepare(`DELETE FROM session_files WHERE session_id = ?`);
const deleteSessionMessages = db.prepare(`DELETE FROM messages WHERE session_id = ?`);
const deleteSessionRawRecords = db.prepare(`DELETE FROM raw_records WHERE session_id = ?`);
const deleteSessionTraceChunks = db.prepare(`DELETE FROM trace_chunks WHERE session_id = ?`);
const deleteSession = db.prepare(`DELETE FROM sessions WHERE id = ?`);

// ── Schema-Drift Canary ────────────────────────────────────────────
// See server/canary.ts for the pure tally logic. This section is the
// stateful wiring: per-session persistence + a process-lifetime "have we
// already warned about this type" set, bootstrapped from whatever's already
// on disk so a server restart doesn't re-warn about long-known drift.

const updateUnknownRecordTypes = db.prepare(
  `UPDATE sessions SET unknown_record_types = ? WHERE id = ?`
);

const seenUnknownTypes = new Set<string>();
try {
  const existingRows = db
    .prepare(
      `SELECT unknown_record_types FROM sessions WHERE unknown_record_types IS NOT NULL`
    )
    .all() as Array<{ unknown_record_types: string }>;
  for (const row of existingRows) {
    try {
      const tally = JSON.parse(row.unknown_record_types) as Record<string, number>;
      for (const type of Object.keys(tally)) seenUnknownTypes.add(type);
    } catch {
      // malformed JSON in an existing row — ignore, not worth crashing startup over
    }
  }
} catch {
  // unknown_record_types column not present yet somehow — treat as "nothing seen"
}

/**
 * Independently tally raw JSONL record types (a lightweight line-parse of its
 * own, deliberately not routed through the vendored parser — a canary that
 * shares the parser it is watching cannot see that parser go blind) and record
 * any type the parse step neither handles nor deliberately skips. Logs once
 * per newly-discovered type per process lifetime; persists the full
 * per-session tally whenever the session row exists (it may not yet, e.g. a
 * first-ingest parse failure).
 */
function recordUnknownTypesForSession(
  sessionId: string,
  jsonlPath: string,
  sessionRowExists: boolean
): void {
  let raw: string;
  try {
    raw = readFileSync(jsonlPath, "utf-8");
  } catch {
    return;
  }

  const tally = tallyUnknownRecordTypes(parseJsonlLines(raw));
  const types = Object.keys(tally);
  if (types.length === 0) return;

  for (const type of types) {
    if (!seenUnknownTypes.has(type)) {
      seenUnknownTypes.add(type);
      console.warn(
        `[canary] new unknown JSONL record type "${type}" (session ${sessionId}, ${tally[type]} occurrence${tally[type] === 1 ? "" : "s"}) — the vendored parser does not handle or skip it; data of this type is being silently dropped.`
      );
    }
  }

  if (sessionRowExists) {
    updateUnknownRecordTypes.run(JSON.stringify(tally), sessionId);
  }
}

// ── Main ───────────────────────────────────────────────────────────

function getOrCreateWorkspace(
  workspacePath: string,
  dirName: string
): number {
  const existing = getWorkspace.get(workspacePath) as
    | { id: number }
    | undefined;
  if (existing) return existing.id;

  const result = insertWorkspace.run(
    workspacePath,
    dirName,
    displayName(workspacePath)
  );
  return Number(result.lastInsertRowid);
}

// ── Parse-source resolution (archive fallback) ─────────────────────

interface ParseSource {
  /** Absolute path of the file to hand the vendored parser. */
  filePath: string;
  /** Encoded `~/.claude/projects` directory name, or null when the bytes came
   *  from the gzip archive (no `subagents/` sibling directory exists there, so
   *  subagent linking is skipped — a parent-only trace, not a failure). */
  projectId: string | null;
  /** Removes the temp file, if one was created. No-op otherwise. */
  cleanup: () => void;
}

/**
 * Resolve the bytes to parse for a session: the original transcript when it is
 * still on disk, otherwise `data/archive/<id>.jsonl.gz` gunzipped to a temp
 * file. This is what makes the archive LOAD-BEARING (plan R4) — before this,
 * once Claude Code pruned a transcript the session could never be reingested
 * and its lossy rows were all that remained forever.
 *
 * Mirrors the temp-file pattern in `server/trace/index.ts`'s
 * `resolveTranscript`. Returns null when neither source exists, which the
 * caller treats exactly like a parse failure: old rows stay untouched.
 */
function resolveParseSource(sessionId: string, jsonlPath: string): ParseSource | null {
  if (existsSync(jsonlPath)) {
    // `<projects>/<projectId>/<sessionId>.jsonl` — the directory name IS the
    // projectId the vendored SubagentResolver needs to find sibling subagents.
    return { filePath: jsonlPath, projectId: basename(dirname(jsonlPath)), cleanup: () => {} };
  }

  const archivePath = archivePathFor(sessionId);
  if (!existsSync(archivePath)) return null;

  try {
    const tempDir = mkdtempSync(join(tmpdir(), "session-explorer-ingest-"));
    const tempFile = join(tempDir, `${sessionId}.jsonl`);
    writeFileSync(tempFile, gunzipSync(readFileSync(archivePath)));
    return {
      filePath: tempFile,
      projectId: null,
      cleanup: () => {
        try {
          rmSync(tempDir, { recursive: true, force: true });
        } catch {
          // best-effort cleanup
        }
      },
    };
  } catch {
    // corrupt/unreadable archive — same contract as a parse failure
    return null;
  }
}

/** A projected row plus which transcript it came from (the `messages.source`
 *  column). The projection itself is source-agnostic apart from the
 *  subagent_prompt override, which it already applies. */
interface SourcedRow {
  row: ProjectedRow;
  source: ProjectionSource;
}

function isoOrNull(value: unknown): string | null {
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString() : null;
}

/**
 * Ingest (or re-ingest) one session: run the vendored parser ONCE and write
 * every derived representation from that single parse — the clean projection
 * (`messages`), the verbatim records (`raw_records`), and the materialized
 * trace (`trace_chunks` + `sessions.trace_meta`).
 *
 * The ordering below is load-bearing; see the numbered comments.
 */
export async function ingestSession(
  jsonlPath: string,
  workspaceId: number,
  forceReingest: boolean
): Promise<boolean> {
  const sessionId = basename(jsonlPath, ".jsonl");

  const alreadyExists = !!sessionExists.get(sessionId);

  // 1. Auto-reingest if the file's size OR mtime changed since the last ingest
  // (D10) — see needsReingestForStat for why a NULL mtime falls back to size.
  let needsReingest = forceReingest;
  if (alreadyExists && !forceReingest) {
    try {
      const stored = sessionFileStat.get(sessionId) as
        | { file_size: number | null; file_mtime: number | null }
        | undefined;
      const stat = statSync(jsonlPath);
      if (stored && needsReingestForStat(stored, stat)) {
        needsReingest = true;
      }
    } catch {
      // stat failed, skip the staleness check
    }
  }

  if (alreadyExists && !needsReingest) {
    return false;
  }

  // 2. Keep the raw-archive fallback fresh regardless of whether the parse
  // below succeeds — it's a byte-for-byte gzip copy independent of parsing, so
  // even a broken/unparseable session still gets archived before Claude Code
  // eventually prunes the original. See server/archive.ts for the
  // skip-if-unchanged manifest check (cheap stat-only comparison).
  archiveSession(sessionId, jsonlPath);

  // 3. Resolve what to parse: the original file, or the archive gunzipped to a
  // temp file when Claude Code has already pruned it.
  const parseSource = resolveParseSource(sessionId, jsonlPath);
  if (!parseSource) {
    console.error(`  [SKIP] No transcript or archive for ${sessionId}`);
    recordUnknownTypesForSession(sessionId, jsonlPath, alreadyExists);
    recordIngestFailure(sessionId, "No transcript or archive found");
    return false;
  }

  // 4. Parse BEFORE touching any existing rows. A parse failure must leave the
  // old session+messages+files fully intact — previously the delete ran
  // first and a subsequent parse failure silently destroyed the session.
  //
  // ONE parse feeds everything downstream (R1): `detail` carries the full
  // per-message model AND the raw line behind each record, and `lean` is the
  // pure reshape the trace UI consumes.
  let detail;
  let lean;
  try {
    detail = await buildTraceFromFile(parseSource.filePath, parseSource.projectId, sessionId);
    lean = shapeTraceForResponse(detail);
  } catch (err) {
    console.error(`  [SKIP] Failed to parse ${sessionId}: ${err}`);
    // Best-effort schema-drift signal even on parse failure — a new/renamed
    // record type the parser can't handle is a plausible cause. Only persists
    // if the (untouched) session row already exists.
    recordUnknownTypesForSession(sessionId, jsonlPath, alreadyExists);
    recordIngestFailure(sessionId, `Failed to parse: ${err}`);
    return false;
  } finally {
    parseSource.cleanup();
  }

  // 5. Project. Subagent messages come from the RESOLVER's output, not from a
  // second parser pass over `subagents/*.jsonl` — that second pass was the
  // duplicate-parser problem this migration exists to remove. The
  // `subagent_prompt` override for subagent user text lives in the projection
  // (server/projection.ts), which is why only the source hint is passed here.
  const sourcedRows: SourcedRow[] = [];
  for (const row of projectMessages(detail.messages, "parent")) {
    sourcedRows.push({ row, source: "parent" });
  }
  for (const process of detail.processes) {
    for (const row of projectMessages(process.messages, "subagent")) {
      sourcedRows.push({ row, source: "subagent" });
    }
  }

  if (sourcedRows.length === 0) {
    // Still worth a canary check: a session whose every record is an
    // unrecognized type would project to zero rows here.
    recordUnknownTypesForSession(sessionId, jsonlPath, alreadyExists);
    recordIngestFailure(sessionId, "Parsed to zero message rows");
    return false;
  }

  // File references are extracted over parent + subagent messages in one call
  // so the dedupe key (`filePath|operation`) and the sequence numbering are
  // global, not per-transcript.
  const fileReferences = extractFileReferences([
    ...detail.messages,
    ...detail.processes.flatMap((p) => p.messages),
  ]);

  const header = projectHeader(detail.messages);

  // 6. Preserve LLM-derived columns across reingest so we don't trigger
  // unnecessary resummarization/re-extraction (see sessionDerivedData above).
  // Read BEFORE the delete+reinsert transaction below — parsing has already
  // succeeded at this point, so it's now safe to plan the destructive part.
  let preserved: PreservedDerivedData | null = null;
  if (alreadyExists && needsReingest) {
    preserved =
      (sessionDerivedData.get(sessionId) as PreservedDerivedData | undefined) ??
      null;
  }

  const parentRows = sourcedRows.filter((r) => r.source === "parent").map((r) => r.row);
  const title = pickTitle(parentRows.filter((r) => r.role === "user"));
  const userRowCount = sourcedRows.filter((r) => r.row.role === "user").length;
  const parentTimestamps = parentRows
    .map((r) => r.timestamp)
    .filter((t): t is string => typeof t === "string" && t.length > 0);
  const startedAt = parentTimestamps[0] ?? null;
  const endedAt = parentTimestamps[parentTimestamps.length - 1] ?? null;

  // FTS facet values (D4), denormalized onto every message row of this session.
  const workspaceRow = getWorkspaceDisplayName.get(workspaceId) as
    | { display_name: string }
    | undefined;
  const workspaceName = workspaceRow?.display_name ?? null;

  // The LeanSessionDetail envelope minus its chunks — the chunks become rows,
  // the rest becomes one JSON column the trace endpoint reassembles around
  // them (D3).
  const { chunks: leanChunks, ...traceMeta } = lean;

  // Size + mtime, the two halves of the reingest trigger (D10). Both are read
  // AFTER the parse so they describe the bytes that were actually parsed.
  // Both stay NULL for an archive-sourced ingest: there is no file to stat,
  // and a fabricated value would make the next tick think it was current.
  let fileSize: number | null = null;
  let fileMtime: number | null = null;
  try {
    const stat = statSync(jsonlPath);
    fileSize = stat.size;
    fileMtime = Math.round(stat.mtimeMs);
  } catch {
    // file may have been removed between parse and stat, or was never there
    // (archive-sourced ingest)
  }

  // 7. Delete (if reingesting) and reinsert atomically in ONE transaction —
  // now that parsing has already succeeded, a crash mid-transaction can't
  // leave the DB in a deleted-but-not-reinserted state either.
  const ingestTx = db.transaction(() => {
    // Unconditional, not gated on `alreadyExists`: `raw_records` and
    // `trace_chunks` are keyed by (session_id, uuid) / (session_id, chunk_seq),
    // so ANY orphan row left behind by an earlier partial state would make the
    // insert below fail with SQLITE_CONSTRAINT_PRIMARYKEY and abort the whole
    // ingest. On a genuine first ingest all five statements are no-ops.
    deleteSessionFiles.run(sessionId);
    deleteSessionMessages.run(sessionId);
    deleteSessionRawRecords.run(sessionId);
    deleteSessionTraceChunks.run(sessionId);
    // Preserve session_tags — tags are user data, not derived from JSONL
    deleteSession.run(sessionId);

    insertSession.run(
      sessionId,
      workspaceId,
      // The canonical on-disk location, even when the bytes came from the
      // archive: the file may reappear, and the stale sweep keys off this.
      jsonlPath,
      startedAt,
      endedAt,
      header.branch || null,
      title,
      sourcedRows.length,
      userRowCount,
      fileSize,
      fileMtime,
      JSON.stringify(traceMeta),
      new Date().toISOString()
    );

    let sequence = 0;
    for (const { row, source } of sourcedRows) {
      insertMessage.run(
        sessionId,
        row.role,
        row.content,
        row.timestamp,
        sequence++,
        row.messageType,
        source,
        row.toolUseId,
        row.toolName,
        row.toolInput,
        row.recordUuid,
        title,
        workspaceName
      );
    }

    // Verbatim raw lines for every record that survived the active-path
    // filter, parent and subagent alike. Map iteration order is file order.
    let rawSeq = 0;
    for (const [uuid, raw] of detail.rawLinesByUuid) {
      insertRawRecord.run(sessionId, uuid, rawSeq++, raw);
    }

    leanChunks.forEach((chunk, index) => {
      insertTraceChunk.run(
        sessionId,
        index,
        chunk.chunkType,
        isoOrNull(chunk.startTime),
        isoOrNull(chunk.endTime),
        JSON.stringify(chunk)
      );
    });

    for (const file of fileReferences) {
      if (isImageFile(file.filePath)) continue;
      insertFile.run(
        sessionId,
        file.filePath,
        file.fileName,
        file.operation,
        file.timestamp,
        file.sequence
      );
    }
  });

  ingestTx();

  // 8. Session row is guaranteed to exist now — persist the canary tally.
  recordUnknownTypesForSession(sessionId, jsonlPath, true);

  // Recompute counts from the rows actually written BEFORE computing summary
  // staleness below, so that check uses the final authoritative count.
  // (Previously conditional on a `subagents/` directory existing; subagent
  // rows now arrive through the resolver, so there is no directory to test.)
  updateSessionCounts.run(sessionId, sessionId, sessionId);
  const countRow = getMessageCount.get(sessionId) as { message_count: number } | undefined;
  const finalMessageCount = countRow?.message_count ?? sourcedRows.length;

  // Restore LLM-derived columns wiped by the delete+reinsert above.
  if (preserved) {
    // insights/events extraction is expensive Sonnet work — always preserved.
    restoreInsightsAndEvents.run(
      preserved.insights_extracted,
      preserved.events_extracted,
      sessionId
    );

    const stale = isSummaryStale({
      storedSummarizedCount: preserved.summarized_message_count,
      freshMessageCount: finalMessageCount,
      storedSummarizedAt: preserved.summarized_at,
      now: Date.now(),
    });

    if (!stale) {
      restoreSummaryFields.run(
        preserved.summary,
        preserved.summary_short,
        preserved.summarized_message_count,
        preserved.summarized_at,
        sessionId
      );
    }
    // else: deliberately skip restoring summary/summary_short/
    // summarized_message_count — insertSession's fresh row already left
    // them at their defaults (NULL), so the next auto-summarize tick
    // (WHERE summary IS NULL) re-summarizes this session exactly once.
  }

  return true;
}

// ── Stale Session Detection ──────────────────────────────────────

const getAllSessionsWithSize = db.prepare(
  `SELECT id, source_path, workspace_id, file_size FROM sessions WHERE source_path IS NOT NULL AND file_size IS NOT NULL`
);

export function getStaleSessionsNeedingReingest(
  idleHoursThreshold: number
): Array<{ sessionId: string; sourcePath: string; workspaceId: number }> {
  const rows = getAllSessionsWithSize.all() as Array<{
    id: string;
    source_path: string;
    workspace_id: number;
    file_size: number;
  }>;

  const cutoff = Date.now() - idleHoursThreshold * 60 * 60 * 1000;
  const stale: Array<{ sessionId: string; sourcePath: string; workspaceId: number }> = [];

  for (const row of rows) {
    try {
      const stat = statSync(row.source_path);
      if (stat.mtimeMs < cutoff && stat.size !== row.file_size) {
        stale.push({
          sessionId: row.id,
          sourcePath: row.source_path,
          workspaceId: row.workspace_id,
        });
      }
    } catch {
      // File no longer exists — skip
    }
  }

  return stale;
}

export function reingestSession(
  sourcePath: string,
  workspaceId: number
): Promise<boolean> {
  return ingestSession(sourcePath, workspaceId, true);
}

// ── Force-mode archive sweep (plan U8, D13) ────────────────────────
//
// `runIngestion`'s disk walk only ever visits files that still exist under
// `~/.claude/projects` — once Claude Code prunes a transcript, that session
// is invisible to the walk forever, even though `ingestSession`'s own
// `resolveParseSource` already knows how to fall back to
// `data/archive/<id>.jsonl.gz` when handed a `jsonlPath` that no longer
// exists (see the archive-fallback comment above `resolveParseSource`). This
// is the second sweep the force run needs: enumerate every DB session whose
// recorded `source_path` is gone, and hand each one straight back into
// `ingestSession` so that existing fallback does the reingest.

const getAllSessionsWithSourcePathForSweep = db.prepare(
  `SELECT id, source_path, workspace_id FROM sessions WHERE source_path IS NOT NULL`
);

/**
 * Deliberately does NOT pre-filter on archive existence — a session with
 * neither the original file nor an archive is included here too, and
 * `ingestSession` itself is what decides its fate (its own
 * `resolveParseSource` returns null for that case, which is logged as a
 * `[SKIP] No transcript or archive for ...` and counted as a normal ingest
 * failure via `recordIngestFailure`). Keeping that single decision point in
 * `ingestSession` means this sweep can never disagree with it about which
 * sessions are truly unrecoverable.
 *
 * Pure DB-plus-`existsSync` read, no writes — safe to call from tests and
 * from `runIngestion`'s progress-total calculation alike.
 */
export function getPrunedSessionsForArchiveSweep(): Array<{
  sessionId: string;
  sourcePath: string;
  workspaceId: number;
}> {
  const rows = getAllSessionsWithSourcePathForSweep.all() as Array<{
    id: string;
    source_path: string;
    workspace_id: number;
  }>;
  return rows
    .filter((row) => !existsSync(row.source_path))
    .map((row) => ({
      sessionId: row.id,
      sourcePath: row.source_path,
      workspaceId: row.workspace_id,
    }));
}

export async function runIngestion(
  // `projectsDir` defaults to the real `~/.claude/projects` in production;
  // tests point it at a synthetic fixture tree so a unit test never scans
  // (or depends on the contents of) whatever real transcripts happen to
  // exist on the machine running it.
  options: { force?: boolean; projectsDir?: string } = {},
  onProgress?: (progress: IngestProgress) => void
): Promise<IngestProgress> {
  const forceReingest = !!options.force;
  const projectsDir = options.projectsDir ?? CLAUDE_PROJECTS_DIR;

  if (!existsSync(projectsDir)) {
    throw new Error(`Claude projects directory not found: ${projectsDir}`);
  }

  const projectDirs = readdirSync(projectsDir).filter((d) => {
    const fullPath = join(projectsDir, d);
    try {
      return statSync(fullPath).isDirectory();
    } catch {
      return false;
    }
  });

  console.log(`Found ${projectDirs.length} project directories`);
  if (forceReingest) {
    console.log(`Force mode: re-ingesting all sessions (clearing existing data)`);
  }

  // Count total JSONL files for progress reporting
  let totalFiles = 0;
  const workspaceDirs: Array<{ dirName: string; jsonlFiles: string[]; workspacePath: string; workspaceId: number }> = [];

  for (const dirName of projectDirs) {
    const projectDir = join(projectsDir, dirName);

    let jsonlFiles: string[];
    try {
      jsonlFiles = readdirSync(projectDir).filter(
        (f) => f.endsWith(".jsonl")
      );
    } catch {
      continue;
    }

    if (jsonlFiles.length === 0) continue;

    // The workspace for this dir_name is already known once ingested once —
    // don't re-parse a JSONL file just to resolve cwd again. Without this,
    // every ~30s auto-ingest tick JSON-parsed the first ~3 sessions of all
    // ~240 project dirs purely to recompute a value that never changes.
    const known = getWorkspaceByDirName.get(dirName) as
      | { id: number; path: string }
      | undefined;

    let workspacePath: string | null;
    let workspaceId: number;

    if (known) {
      workspacePath = known.path;
      workspaceId = known.id;
    } else {
      // Resolve workspace path from the first session's cwd, falling back to
      // dir name decode. `readSessionHeader` JSON-parses only the first few
      // records — a full parse here would run the whole vendored pipeline over
      // (potentially) a 47 MB transcript to read one string.
      workspacePath = null;
      for (const f of jsonlFiles.slice(0, 3)) {
        const { cwd } = readSessionHeader(join(projectDir, f));
        if (cwd) {
          workspacePath = cwd;
          break;
        }
      }

      if (!workspacePath) {
        workspacePath = decodeDirName(dirName);
      }

      if (!workspacePath) {
        console.log(`  [SKIP] Could not resolve path for: ${dirName}`);
        continue;
      }

      workspaceId = getOrCreateWorkspace(workspacePath, dirName);
    }

    totalFiles += jsonlFiles.length;
    workspaceDirs.push({ dirName, jsonlFiles, workspacePath, workspaceId });
  }

  // D13: discovered up front (independent of the disk walk above) so the
  // progress total accounts for the archive-only sweep from the very first
  // `onProgress` call, instead of jumping partway through the run.
  const prunedSessions = forceReingest ? getPrunedSessionsForArchiveSweep() : [];
  if (forceReingest) {
    console.log(
      `Archive sweep: ${prunedSessions.length} DB session(s) whose source file is gone from disk`
    );
  }

  let totalIngested = 0;
  let totalSkipped = 0;

  const progress: IngestProgress = {
    total: totalFiles + prunedSessions.length,
    ingested: 0,
    skipped: 0,
    running: true,
  };
  onProgress?.(progress);

  for (const { dirName, jsonlFiles, workspacePath, workspaceId } of workspaceDirs) {
    const projectDir = join(projectsDir, dirName);
    let dirIngested = 0;

    for (const f of jsonlFiles) {
      const fullPath = join(projectDir, f);
      // `await` is load-bearing now that ingestSession is async: without it
      // every file's delete+reinsert transaction would be started in parallel
      // and the progress counters below would advance before any work landed.
      const ingested = await ingestSession(fullPath, workspaceId, forceReingest);
      if (ingested) {
        dirIngested++;
        totalIngested++;
        progress.ingested = totalIngested;
      } else {
        totalSkipped++;
        progress.skipped = totalSkipped;
      }
      onProgress?.(progress);
    }

    if (dirIngested > 0) {
      updateWorkspaceStats.run(workspaceId, workspaceId, workspaceId);
      console.log(
        `  ${displayName(workspacePath)}: ingested ${dirIngested} sessions (${jsonlFiles.length - dirIngested} skipped)`
      );
    }
  }

  // D13 archive sweep, second pass: sessions the disk walk above could never
  // see because their original file is gone. `ingestSession` already
  // implements the archive fallback (`resolveParseSource`) — this loop's
  // only job is to hand it sessions it wouldn't otherwise be called with.
  // Passing `true` for `forceReingest` unconditionally (not the outer
  // `forceReingest` variable, which is always true here anyway, since
  // `prunedSessions` is empty unless force mode) mirrors the disk walk: a
  // pruned session with `alreadyExists=true` needs its `needsReingest` gate
  // forced open the same way a still-present file does under `--force`.
  let archiveReingested = 0;
  let neitherFileNorArchive = 0;
  for (const { sessionId, sourcePath, workspaceId } of prunedSessions) {
    const hadArchive = existsSync(archivePathFor(sessionId));
    const ingested = await ingestSession(sourcePath, workspaceId, true);
    if (ingested) {
      archiveReingested++;
      totalIngested++;
      progress.ingested = totalIngested;
    } else {
      // `ingestSession` itself already logged/recorded WHY this session was
      // skipped (missing archive vs. a parse failure against a present
      // archive) — this tally only distinguishes the "truly unrecoverable,
      // old lossy rows kept as-is" case for the post-run checklist (plan U8:
      // "log a count, never destroy").
      if (!hadArchive) neitherFileNorArchive++;
      totalSkipped++;
      progress.skipped = totalSkipped;
    }
    onProgress?.(progress);
  }
  if (prunedSessions.length > 0) {
    console.log(
      `Archive sweep done: reingested ${archiveReingested} session(s) from archive; ` +
        `${neitherFileNorArchive} had neither the original file nor an archive and were left untouched (old rows preserved).`
    );
  }

  console.log(
    `\nDone. Ingested ${totalIngested} new sessions, skipped ${totalSkipped}.`
  );

  // Plan U6: only set once the tick has actually resolved — a tick that
  // throws above never reaches here, so it correctly does NOT count as
  // "last completed".
  lastTickAt = new Date().toISOString();

  return { total: totalFiles, ingested: totalIngested, skipped: totalSkipped, running: false };
}

// ── CLI Entry Point ───────────────────────────────────────────────

const isDirectRun = process.argv[1] &&
  (process.argv[1].endsWith("/ingest.ts") || process.argv[1].endsWith("/ingest.js"));

if (isDirectRun) {
  const options = {
    force: process.argv.includes("--force"),
  };
  runIngestion(options)
    .then((result) => {
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
