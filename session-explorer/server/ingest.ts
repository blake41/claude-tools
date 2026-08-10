import { readdirSync, statSync, existsSync, readFileSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";
import db from "./db.js";
import { stripSession } from "./strip.js";
import { pickTitle } from "./title.js";
import { archiveSession } from "./archive.js";
import { tallyUnknownRecordTypes, parseJsonlLines } from "./canary.js";
import { isSummaryStale } from "./summary-staleness.js";

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
const sessionFileSize = db.prepare(`SELECT file_size FROM sessions WHERE id = ?`);

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
  INSERT INTO sessions (id, workspace_id, source_path, started_at, ended_at, git_branch, title, message_count, user_message_count, file_size, ingested_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertMessage = db.prepare(`
  INSERT INTO messages (session_id, role, content, timestamp, sequence, message_type, source, tool_use_id, tool_name, tool_input)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

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
const deleteSessionTags = db.prepare(`DELETE FROM session_tags WHERE session_id = ?`);
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
 * Independently tally raw JSONL record types (duplicates a lightweight
 * version of strip.ts's line-parsing since strip.ts is out of scope to
 * modify/export from) and record any type strip.ts neither handles nor
 * deliberately skips. Logs once per newly-discovered type per process
 * lifetime; persists the full per-session tally whenever the session row
 * exists (it may not yet, e.g. a first-ingest parse failure).
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
        `[canary] new unknown JSONL record type "${type}" (session ${sessionId}, ${tally[type]} occurrence${tally[type] === 1 ? "" : "s"}) — strip.ts does not handle or skip it; data of this type is being silently dropped.`
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

function ingestSession(
  jsonlPath: string,
  workspaceId: number,
  forceReingest: boolean
): boolean {
  const sessionId = basename(jsonlPath, ".jsonl");

  const alreadyExists = !!sessionExists.get(sessionId);

  // Auto-reingest if file size has changed (session grew since last ingest)
  let needsReingest = forceReingest;
  if (alreadyExists && !forceReingest) {
    try {
      const stored = sessionFileSize.get(sessionId) as { file_size: number } | undefined;
      const currentSize = statSync(jsonlPath).size;
      if (stored && stored.file_size !== currentSize) {
        needsReingest = true;
      }
    } catch {
      // stat failed, skip size check
    }
  }

  if (alreadyExists && !needsReingest) {
    return false;
  }

  // Keep the raw-archive fallback fresh regardless of whether stripSession
  // can parse the file below — it's a byte-for-byte gzip copy independent of
  // parsing, so even a broken/unparseable session still gets archived before
  // Claude Code eventually prunes the original. See server/archive.ts for
  // the skip-if-unchanged manifest check (cheap stat-only comparison).
  archiveSession(sessionId, jsonlPath);

  // Parse BEFORE touching any existing rows. A parse failure must leave the
  // old session+messages+files fully intact — previously the delete ran
  // first and a subsequent parse failure silently destroyed the session.
  let result;
  try {
    result = stripSession(jsonlPath);
  } catch (err) {
    console.error(`  [SKIP] Failed to strip ${sessionId}: ${err}`);
    // Best-effort schema-drift signal even on parse failure — a new/renamed
    // record type strip.ts can't handle is a plausible cause. Only persists
    // if the (untouched) session row already exists.
    recordUnknownTypesForSession(sessionId, jsonlPath, alreadyExists);
    return false;
  }

  const { header, messages, files, toolCalls } = result;
  if (messages.length === 0) {
    // Still worth a canary check: a session whose every record is an
    // unrecognized type would strip down to zero messages here.
    recordUnknownTypesForSession(sessionId, jsonlPath, alreadyExists);
    return false;
  }

  // Preserve LLM-derived columns across reingest so we don't trigger
  // unnecessary resummarization/re-extraction (see sessionDerivedData above).
  // Read BEFORE the delete+reinsert transaction below — parsing has already
  // succeeded at this point, so it's now safe to plan the destructive part.
  let preserved: PreservedDerivedData | null = null;
  if (alreadyExists && needsReingest) {
    preserved =
      (sessionDerivedData.get(sessionId) as PreservedDerivedData | undefined) ??
      null;
  }

  const userMessages = messages.filter((m) => m.role === "user");
  const title = pickTitle(userMessages);
  const startedAt = messages[0]?.timestamp || null;
  const endedAt = messages[messages.length - 1]?.timestamp || null;

  // Get file size for change detection
  let fileSize: number | null = null;
  try {
    fileSize = statSync(jsonlPath).size;
  } catch {
    // file may have been removed between strip and stat
  }

  // Delete (if reingesting) and reinsert atomically in ONE transaction —
  // now that parsing has already succeeded, a crash mid-transaction can't
  // leave the DB in a deleted-but-not-reinserted state either.
  const ingestTx = db.transaction(() => {
    if (alreadyExists && needsReingest) {
      deleteSessionFiles.run(sessionId);
      deleteSessionMessages.run(sessionId);
      // Preserve session_tags — tags are user data, not derived from JSONL
      deleteSession.run(sessionId);
    }

    insertSession.run(
      sessionId,
      workspaceId,
      jsonlPath,
      startedAt,
      endedAt,
      header.branch || null,
      title,
      messages.length,
      userMessages.length,
      fileSize,
      new Date().toISOString()
    );

    for (const msg of messages) {
      insertMessage.run(
        sessionId,
        msg.role,
        msg.content,
        msg.timestamp,
        msg.sequence,
        msg.messageType || 'text',
        'parent',
        msg.toolUseId ?? null,
        msg.toolName ?? null,
        msg.toolInput ?? null
      );
    }

    for (const file of files) {
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

    // Ingest subagent sessions — merge their messages/files into the parent
    const subagentDir = join(
      jsonlPath.replace(/\.jsonl$/, ""),
      "subagents"
    );
    if (existsSync(subagentDir)) {
      let subagentFiles: string[];
      try {
        subagentFiles = readdirSync(subagentDir).filter((f) =>
          f.endsWith(".jsonl")
        );
      } catch {
        subagentFiles = [];
      }

      let seqOffset = messages.length + files.length + toolCalls.length;
      for (const sf of subagentFiles) {
        try {
          const subResult = stripSession(join(subagentDir, sf));
          for (const msg of subResult.messages) {
            // Tag subagent user text messages as 'subagent_prompt' so they're
            // excluded from queries that filter on message_type = 'text'
            const messageType = (msg.role === 'user' && (msg.messageType || 'text') === 'text')
              ? 'subagent_prompt'
              : msg.messageType || 'text';
            insertMessage.run(
              sessionId,
              msg.role,
              msg.content,
              msg.timestamp,
              seqOffset + msg.sequence,
              messageType,
              'subagent',
              msg.toolUseId ?? null,
              msg.toolName ?? null,
              msg.toolInput ?? null
            );
          }
          for (const file of subResult.files) {
            if (isImageFile(file.filePath)) continue;
            insertFile.run(
              sessionId,
              file.filePath,
              file.fileName,
              file.operation,
              file.timestamp,
              seqOffset + file.sequence
            );
          }
          seqOffset += subResult.messages.length + subResult.files.length + subResult.toolCalls.length;
        } catch {
          // skip broken subagent files
        }
      }
    }
  });

  ingestTx();

  // Session row is guaranteed to exist now — persist the canary tally.
  recordUnknownTypesForSession(sessionId, jsonlPath, true);

  // Update counts to include subagent messages BEFORE computing summary
  // staleness below, so that check uses the final authoritative count.
  const subagentDir = join(jsonlPath.replace(/\.jsonl$/, ""), "subagents");
  let finalMessageCount = messages.length;
  if (existsSync(subagentDir)) {
    updateSessionCounts.run(sessionId, sessionId, sessionId);
    const row = getMessageCount.get(sessionId) as { message_count: number } | undefined;
    if (row) finalMessageCount = row.message_count;
  }

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

export function reingestSession(sourcePath: string, workspaceId: number): boolean {
  return ingestSession(sourcePath, workspaceId, true);
}

export async function runIngestion(
  options: { force?: boolean } = {},
  onProgress?: (progress: IngestProgress) => void
): Promise<IngestProgress> {
  const forceReingest = !!options.force;

  if (!existsSync(CLAUDE_PROJECTS_DIR)) {
    throw new Error(`Claude projects directory not found: ${CLAUDE_PROJECTS_DIR}`);
  }

  const projectDirs = readdirSync(CLAUDE_PROJECTS_DIR).filter((d) => {
    const fullPath = join(CLAUDE_PROJECTS_DIR, d);
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
    const projectDir = join(CLAUDE_PROJECTS_DIR, dirName);

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
      // Resolve workspace path from first session's cwd, falling back to dir name decode
      workspacePath = null;
      for (const f of jsonlFiles.slice(0, 3)) {
        try {
          const { header } = stripSession(join(projectDir, f));
          if (header.cwd) {
            workspacePath = header.cwd;
            break;
          }
        } catch {
          // try next file
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

  let totalIngested = 0;
  let totalSkipped = 0;

  const progress: IngestProgress = { total: totalFiles, ingested: 0, skipped: 0, running: true };
  onProgress?.(progress);

  for (const { dirName, jsonlFiles, workspacePath, workspaceId } of workspaceDirs) {
    const projectDir = join(CLAUDE_PROJECTS_DIR, dirName);
    let dirIngested = 0;

    for (const f of jsonlFiles) {
      const fullPath = join(projectDir, f);
      const ingested = ingestSession(fullPath, workspaceId, forceReingest);
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

  console.log(
    `\nDone. Ingested ${totalIngested} new sessions, skipped ${totalSkipped}.`
  );

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
