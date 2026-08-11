/**
 * Trace adapter — resolves a Claude Code session id to its raw JSONL transcript(s)
 * and runs the vendored claude-devtools parsing + chunk/step analysis + subagent
 * linking pipeline against it, returning the full (lossless, unstripped) analysis
 * model.
 *
 * This is the architectural fix for "detail view renders from a destructively
 * stripped DB": the SQLite DB stays a search index (title/summary/message text for
 * fast lookup); rich rendering parses the original JSONL on demand, here.
 *
 * Resolution order for a session id:
 *   1. DB lookup (`sessions.source_path`, joined to `workspaces.dir_name`) — fast
 *      path, authoritative once a session has been ingested and the file is still
 *      on disk.
 *   2. Filesystem glob: `~/.claude/projects/*<session-id>.jsonl` — covers sessions
 *      not yet ingested, or a stale/missing DB row.
 *   3. Gzipped archive fallback: `data/archive/<session-id>.jsonl.gz` — covers
 *      sessions whose live JSONL has been pruned from `~/.claude/projects` after
 *      being archived. Subagent linkage is not attempted for archived sessions
 *      (their `subagents/` sibling directory is not preserved by the archiver),
 *      so this degrades gracefully to a parent-only trace.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { basename, dirname, join } from "path";
import { gunzipSync } from "zlib";

import { ChunkBuilder } from "./vendor/main/services/analysis/ChunkBuilder";
import { ProjectScanner } from "./vendor/main/services/discovery/ProjectScanner";
import { SubagentResolver } from "./vendor/main/services/discovery/SubagentResolver";
import { LocalFileSystemProvider } from "./vendor/main/services/infrastructure/LocalFileSystemProvider";
import { SessionParser } from "./vendor/main/services/parsing/SessionParser";
import { sanitizeDisplayContent } from "./vendor/shared/utils/contentSanitizer";
import { computeActivePath } from "./active-path";

import {
  isAIChunk,
  isCompactChunk,
  isSystemChunk,
  isUserChunk,
} from "./vendor/main/types/index";
import type {
  Chunk,
  EnhancedAIChunk,
  ParsedMessage,
  Process,
  SemanticStep,
  Session,
  SessionDetail,
  SessionMetrics,
} from "./vendor/main/types/index";

const PROJECTS_DIR = join(homedir(), ".claude", "projects");
const TODOS_DIR = join(homedir(), ".claude", "todos");
const DB_PATH = join(process.cwd(), "data", "sessions.db");
const ARCHIVE_DIR = join(process.cwd(), "data", "archive");

export type TraceErrorCode = "NOT_FOUND" | "PARSE_FAILED";

export class TraceError extends Error {
  code: TraceErrorCode;

  constructor(message: string, code: TraceErrorCode) {
    super(message);
    this.name = "TraceError";
    this.code = code;
  }
}

interface ResolvedTranscript {
  /** Encoded project directory name (claude-devtools "projectId"), or null when unknown (archive fallback). */
  projectId: string | null;
  /** Absolute path to the JSONL file to parse. */
  filePath: string;
}

/**
 * Look up a session's source path via the ingest DB. Read-only — opens its own
 * connection rather than importing `server/db.ts`, per the DB-safety contract for
 * this adapter (no writes, no coupling to the ingest module's schema-migration
 * lifecycle).
 */
function lookupFromDb(sessionId: string): ResolvedTranscript | null {
  if (!existsSync(DB_PATH)) return null;

  let db: Database | null = null;
  try {
    db = new Database(DB_PATH, { readonly: true });
    const row = db
      .query(
        `SELECT s.source_path AS sourcePath, w.dir_name AS dirName
         FROM sessions s
         LEFT JOIN workspaces w ON s.workspace_id = w.id
         WHERE s.id = ?`
      )
      .get(sessionId) as { sourcePath: string | null; dirName: string | null } | undefined;

    if (!row?.sourcePath || !existsSync(row.sourcePath)) return null;

    const projectId = row.dirName ?? basename(dirname(row.sourcePath));
    return { projectId, filePath: row.sourcePath };
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/** Scan `~/.claude/projects/*` for `<sessionId>.jsonl`, independent of DB state. */
function lookupByGlob(sessionId: string): ResolvedTranscript | null {
  if (!existsSync(PROJECTS_DIR)) return null;

  let entries;
  try {
    entries = readdirSync(PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = join(PROJECTS_DIR, entry.name, `${sessionId}.jsonl`);
    if (existsSync(candidate)) {
      return { projectId: entry.name, filePath: candidate };
    }
  }
  return null;
}

/** Gzipped archive convention: `data/archive/<sessionId>.jsonl.gz`. */
function lookupArchivePath(sessionId: string): string | null {
  const gz = join(ARCHIVE_DIR, `${sessionId}.jsonl.gz`);
  return existsSync(gz) ? gz : null;
}

function buildStubSession(sessionId: string, projectId: string | null, filePath: string): Session {
  return {
    id: sessionId,
    projectId: projectId ?? "",
    projectPath: projectId ? "" : dirname(filePath),
    createdAt: Date.now(),
    hasSubagents: false,
    messageCount: 0,
  };
}

/**
 * Resolve a session id to a transcript on disk, decompressing the archived
 * fallback to a temp file if needed. Returns the resolved transcript plus a
 * cleanup callback (no-op unless a temp file was created).
 */
function resolveTranscript(sessionId: string): { resolved: ResolvedTranscript; cleanup: () => void } {
  const fromDb = lookupFromDb(sessionId);
  if (fromDb) return { resolved: fromDb, cleanup: () => {} };

  const fromGlob = lookupByGlob(sessionId);
  if (fromGlob) return { resolved: fromGlob, cleanup: () => {} };

  const archivePath = lookupArchivePath(sessionId);
  if (archivePath) {
    const decompressed = gunzipSync(readFileSync(archivePath));
    const tempDir = mkdtempSync(join(tmpdir(), "session-explorer-trace-"));
    const tempFile = join(tempDir, `${sessionId}.jsonl`);
    writeFileSync(tempFile, decompressed);
    return {
      resolved: { projectId: null, filePath: tempFile },
      cleanup: () => {
        try {
          rmSync(tempDir, { recursive: true, force: true });
        } catch {
          // best-effort cleanup
        }
      },
    };
  }

  throw new TraceError(`No transcript found for session ${sessionId}`, "NOT_FOUND");
}

/**
 * Pre-filter a transcript to its active path (drop abandoned rewind
 * branches) before handing it to the vendored pipeline, which parses in
 * file order and has no branch semantics of its own. When nothing is
 * dropped the original file is parsed directly — no temp-file cost.
 * Subagent sibling files are deliberately NOT pre-filtered (the resolver
 * reads them from the project dir; rewinds inside subagent runs are rare).
 *
 * Also returns `rawLinesByUuid`: the verbatim original line for every
 * surviving record, keyed by its `uuid`. This is the one place in the
 * pipeline that has both the raw text and the record's identity — the
 * vendored `ParsedMessage` drops the original line, and re-reading the file
 * later to recover it would be a second full pass. Records the filter
 * dropped are deliberately absent: they're abandoned branches, and the gzip
 * archive keeps them.
 *
 * `computeActivePath` (rather than `filterActivePath`) is used so the file is
 * JSON-parsed exactly once; the keep/pass-through logic below mirrors
 * `filterActivePath` line for line, including rule #5 (records with no
 * usable uuid always pass through in place — they also can't be keyed, so
 * they contribute no raw-line entry).
 */
function materializeActivePath(
  filePath: string,
  sessionId: string
): { parsePath: string; cleanup: () => void; rawLinesByUuid: Map<string, string> } {
  const rawLines = readFileSync(filePath, "utf-8")
    .split("\n")
    .filter((l) => l.length > 0);

  const { parsed, keep } = computeActivePath(rawLines);
  const activeLines: string[] = [];
  const rawLinesByUuid = new Map<string, string>();
  for (const p of parsed) {
    const uuid = p.record?.uuid;
    if (typeof uuid !== "string" || uuid.length === 0) {
      activeLines.push(p.raw);
      continue;
    }
    if (!keep.has(uuid)) continue;
    activeLines.push(p.raw);
    rawLinesByUuid.set(uuid, p.raw);
  }

  if (activeLines.length >= rawLines.length) {
    return { parsePath: filePath, cleanup: () => {}, rawLinesByUuid };
  }
  const tempDir = mkdtempSync(join(tmpdir(), "session-explorer-activepath-"));
  const parsePath = join(tempDir, `${sessionId}.jsonl`);
  writeFileSync(parsePath, activeLines.join("\n") + "\n");
  return {
    parsePath,
    rawLinesByUuid,
    cleanup: () => {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    },
  };
}

/**
 * Read a subagent transcript's lines into an existing uuid -> raw-line map.
 * Subagent files are siblings the parent's active-path pass never touches, so
 * without this their records would have no raw line at all. Best-effort: a
 * malformed or unreadable subagent file must not fail the parent trace (same
 * contract the resolver itself follows).
 */
function collectSubagentRawLines(filePath: string, into: Map<string, string>): void {
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return;
  }
  for (const line of content.split("\n")) {
    if (line.length === 0) continue;
    try {
      const record = JSON.parse(line) as { uuid?: unknown };
      if (typeof record.uuid === "string" && record.uuid.length > 0) {
        into.set(record.uuid, line);
      }
    } catch {
      // malformed line — nothing to key it by, skip (same tolerance as the
      // active-path filter's rule #5)
    }
  }
}

/**
 * The full `SessionDetail` plus the raw JSONL line behind each record.
 *
 * Ingest needs the verbatim line for `raw_records` (plan D2) and the vendored
 * `ParsedMessage` doesn't retain it. Kept as a superset of `SessionDetail` so
 * every existing consumer (the trace endpoint, `shapeTraceForResponse`) is
 * unaffected — the extra field is simply ignored by them and dropped by
 * JSON serialization of the lean payload.
 */
export type TraceFromFile = SessionDetail & {
  /**
   * uuid -> the verbatim original JSONL line. Covers the parent transcript's
   * active-path records plus every linked subagent file's records. Records
   * dropped as abandoned rewind branches are intentionally absent.
   */
  rawLinesByUuid: Map<string, string>;
};

/**
 * Parse an already-resolved transcript file and run the full claude-devtools
 * chunk/step + subagent-linking pipeline over it, returning the complete
 * (unstripped) analysis model.
 *
 * Mirrors upstream's `get-session-detail` IPC handler (ServiceContext-composed
 * ProjectScanner + SessionParser + SubagentResolver + ChunkBuilder), minus the
 * IPC-boundary stripping of `messages` — this path is explicitly lossless.
 *
 * This is `buildTrace` minus session-id resolution: callers that already know
 * the path (ingest, which resolves the original file or its gzip archive
 * itself) use this directly instead of round-tripping through the DB/glob
 * lookup. `projectId` is the encoded `~/.claude/projects` directory name, or
 * null when the file lives outside that tree (archive fallback) — in which
 * case subagent linking is skipped, since the `subagents/` sibling directory
 * doesn't exist there.
 */
export async function buildTraceFromFile(
  filePath: string,
  projectId: string | null,
  sessionId: string
): Promise<TraceFromFile> {
  const { parsePath, cleanup, rawLinesByUuid } = materializeActivePath(filePath, sessionId);

  try {
    const fsProvider = new LocalFileSystemProvider();
    // ProjectScanner/SubagentResolver need a real projects directory to resolve
    // sibling subagent files; archived (temp-file) transcripts have no such
    // sibling directory, so subagent linking is skipped for those (degrades
    // gracefully — the parent trace still returns in full).
    //
    // `projectId` is the encoded project directory NAME and the scanner joins
    // it onto this base (`<projectsDir>/<projectId>/<sessionId>/subagents/`),
    // so the base must be the PARENT of that directory. Deriving it from the
    // transcript's own location is byte-identical to the hardcoded
    // PROJECTS_DIR for every real resolution path — a session file always sits
    // exactly two levels down (`~/.claude/projects/<projectId>/<id>.jsonl`),
    // via both the DB `source_path` lookup and the glob. Deriving it (rather
    // than hardcoding) additionally lets ingest's tests drive the real
    // subagent-linking path against a fixture tree outside `~/.claude`.
    const projectsDir = projectId ? dirname(dirname(filePath)) : dirname(filePath);
    const projectScanner = new ProjectScanner(projectsDir, TODOS_DIR, fsProvider);
    const sessionParser = new SessionParser(projectScanner);
    const chunkBuilder = new ChunkBuilder();

    let parsedSession;
    try {
      parsedSession = await sessionParser.parseSessionFile(parsePath);
    } catch (err) {
      throw new TraceError(
        `Failed to parse transcript for session ${sessionId}: ${(err as Error).message}`,
        "PARSE_FAILED"
      );
    }

    let subagents: Process[] = [];
    let session: Session | null = null;

    if (projectId) {
      const subagentResolver = new SubagentResolver(projectScanner);
      try {
        subagents = await subagentResolver.resolveSubagents(
          projectId,
          sessionId,
          parsedSession.taskCalls,
          parsedSession.messages
        );
      } catch {
        // Subagent linking is best-effort — a parent trace without linked
        // subagents is still useful and shouldn't fail the whole request.
        subagents = [];
      }

      session = await projectScanner.getSession(projectId, sessionId);
    }

    // Raw lines for the subagent records the resolver just linked. Done here,
    // beside the resolver output, rather than in vendor/ — the vendored
    // pipeline is pinned and never modified.
    for (const process of subagents) {
      collectSubagentRawLines(process.filePath, rawLinesByUuid);
    }

    if (!session) {
      session = buildStubSession(sessionId, projectId, filePath);
    }
    session.hasSubagents = subagents.length > 0;
    session.messageCount = parsedSession.messages.length;

    const detail = chunkBuilder.buildSessionDetail(session, parsedSession.messages, subagents);
    return { ...detail, rawLinesByUuid };
  } finally {
    cleanup();
  }
}

/**
 * Resolve a session id to a transcript (DB -> glob -> gzip archive) and build
 * its full analysis model. Resolution is all this does now; the parsing half
 * lives in `buildTraceFromFile`.
 */
export async function buildTrace(sessionId: string): Promise<SessionDetail> {
  const { resolved, cleanup } = resolveTranscript(sessionId);
  // resolveTranscript may have created a temp dir (archive fallback), so its
  // cleanup has to run even if buildTraceFromFile throws before it starts its
  // own try/finally.
  try {
    // `rawLinesByUuid` is dropped here on purpose: it exists for ingest, and
    // this function's result is JSON-serialized by the `?full=1` trace route,
    // where an extra (always-empty, since Maps don't serialize) key would be a
    // gratuitous response-shape change.
    const { rawLinesByUuid: _rawLinesByUuid, ...detail } = await buildTraceFromFile(
      resolved.filePath,
      resolved.projectId,
      sessionId
    );
    return detail;
  } finally {
    cleanup();
  }
}

// =============================================================================
// Lean payload shaping — the default `GET /api/sessions/:id/trace` response
// =============================================================================
//
// buildTrace() above returns the vendored pipeline's full, lossless model.
// That model duplicates message content several ways once serialized to
// JSON: `messages[]` overlaps with `chunks[].rawMessages`/`AIChunk.responses`
// (same ParsedMessage objects re-embedded per chunk), and each subagent's
// `messages[]` is duplicated between the top-level `processes[]` array and
// the `processes[]` field nested inside whichever AIChunk spawned it —
// JSON.stringify re-serializes an object graph every place it's referenced,
// it doesn't dedupe by identity. A 29MB transcript's full model serializes
// to roughly 200MB of JSON.
//
// shapeTraceForResponse() below is a pure reshape of buildTrace()'s output:
// it keeps chunk/step structure, thinking text + token counts, tool
// name/input summaries + durations, structuredPatch diffs, per-chunk context
// deltas, subagent step outlines, and compact_boundary markers — everything
// the trace UI renders — while dropping the raw `messages[]`/`rawMessages`
// duplication and capping embedded tool-result strings. `?full=1` on the
// route bypasses this and returns buildTrace()'s output verbatim, so the
// full/lossless contract this module was built for (and the assertions in
// index.test.ts, which call buildTrace() directly) are unaffected.

/** Cap for opaque tool call/result string payloads (file contents, command output, etc). */
const TOOL_PAYLOAD_CAP = 4000;
/** Cap for prose fields (thinking/output text) — generous enough to keep virtually all real content, just a backstop against pathological outliers. */
const PROSE_CAP = 8000;
/** Cap for user/system/compact chunk `text` — these come straight from messageText() with no per-field cap at all otherwise. 64k covers the largest legitimate pasted-content prompt observed across a real transcript sample (~51k) with headroom; a session with a single 47MB pasted string (console-log spam) is what this actually guards against. */
const CHUNK_TEXT_CAP = 64_000;
/** Aggregate budget per capDeep() invocation (i.e. per tool_use input / toolUseResult field) — bounds the case where many leaves each pass the per-string TOOL_PAYLOAD_CAP but the total still balloons (e.g. a huge array of capped-but-numerous strings, or a structuredPatch with thousands of lines). Not a session-global budget: each field gets its own fresh allowance, so truncation of one field never depends on how much other fields in the same chunk already used. */
const TOOL_PAYLOAD_AGGREGATE_CAP = 100_000;

interface Capped<T> {
  value: T;
  truncated: boolean;
}

function capString(s: string, cap: number): Capped<string> {
  return s.length <= cap ? { value: s, truncated: false } : { value: s.slice(0, cap), truncated: true };
}

/** Recursively cap string leaves inside an arbitrary JSON-ish tool payload (tool_use input / toolUseResult), also enforcing an aggregate size budget across the whole value so many small-but-numerous leaves can't add up past a reasonable total. Non-string structure (arrays, structuredPatch hunks, numbers, booleans) passes through untouched except for the aggregate-budget array/object truncation markers below. */
function capDeep(value: unknown, cap: number, budget: { remaining: number } = { remaining: TOOL_PAYLOAD_AGGREGATE_CAP }): Capped<unknown> {
  if (typeof value === "string") {
    if (budget.remaining <= 0) return { value: "", truncated: true };
    const allowed = Math.min(cap, budget.remaining);
    const kept = value.length <= allowed ? value : value.slice(0, allowed);
    budget.remaining -= kept.length;
    return { value: kept, truncated: kept.length < value.length };
  }
  if (Array.isArray(value)) {
    let truncated = false;
    const arr: unknown[] = [];
    for (let i = 0; i < value.length; i++) {
      if (budget.remaining <= 0) {
        arr.push(`… [${value.length - i} more items truncated]`);
        truncated = true;
        break;
      }
      const r = capDeep(value[i], cap, budget);
      if (r.truncated) truncated = true;
      arr.push(r.value);
    }
    return { value: arr, truncated };
  }
  if (value !== null && typeof value === "object") {
    let truncated = false;
    const out: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>);
    for (let i = 0; i < entries.length; i++) {
      const [k, v] = entries[i];
      if (budget.remaining <= 0) {
        out["…truncated"] = `${entries.length - i} more fields truncated`;
        truncated = true;
        break;
      }
      const r = capDeep(v, cap, budget);
      if (r.truncated) truncated = true;
      out[k] = r.value;
    }
    return { value: out, truncated };
  }
  return { value, truncated: false };
}

/** Extract plain text (+ whether an image block is present) from a ParsedMessage's content. */
function messageText(msg: ParsedMessage): { text: string; hasImage: boolean } {
  const content = msg.content;
  if (typeof content === "string") return { text: sanitizeDisplayContent(content), hasImage: false };
  if (!Array.isArray(content)) return { text: "", hasImage: false };
  let hasImage = false;
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text") {
      const sanitized = sanitizeDisplayContent(block.text);
      if (sanitized.length > 0) parts.push(sanitized);
    } else if (block.type === "image") hasImage = true;
  }
  return { text: parts.join("\n"), hasImage };
}

export interface LeanStep {
  id: string;
  type: SemanticStep["type"];
  startTime: Date;
  endTime?: Date;
  durationMs: number;
  /** Gap-filled end/duration (extends to the next step or chunk end) — tool_call/tool_result steps carry durationMs: 0 from extraction, so this is the field the UI should show as the "duration badge". */
  effectiveEndTime?: Date;
  effectiveDurationMs?: number;
  isGapFilled?: boolean;
  context: "main" | "subagent";
  agentId?: string;
  isParallel?: boolean;
  groupId?: string;
  tokens?: { input: number; output: number; cached?: number };
  contextTokens?: number;
  accumulatedContext?: number;

  thinkingText?: string;
  thinkingTruncated?: boolean;
  tokenCount?: number;

  toolName?: string;
  toolInput?: unknown;
  toolInputTruncated?: boolean;
  sourceModel?: string;

  toolResultContent?: string;
  toolResultTruncated?: boolean;
  isError?: boolean;
  toolUseResult?: unknown;
  toolUseResultTruncated?: boolean;

  subagentId?: string;
  subagentDescription?: string;

  outputText?: string;
  outputTruncated?: boolean;
  interruptionText?: string;
}

function shapeStep(step: SemanticStep): LeanStep {
  const c = step.content;
  const lean: LeanStep = {
    id: step.id,
    type: step.type,
    startTime: step.startTime,
    endTime: step.endTime,
    durationMs: step.durationMs,
    effectiveEndTime: step.effectiveEndTime,
    effectiveDurationMs: step.effectiveDurationMs,
    isGapFilled: step.isGapFilled,
    context: step.context,
    agentId: step.agentId,
    isParallel: step.isParallel,
    groupId: step.groupId,
    tokens: step.tokens,
    contextTokens: step.contextTokens,
    accumulatedContext: step.accumulatedContext,
    toolName: c.toolName,
    sourceModel: c.sourceModel,
    isError: c.isError,
    subagentId: c.subagentId,
    subagentDescription: c.subagentDescription,
    interruptionText: c.interruptionText,
  };

  if (typeof c.thinkingText === "string") {
    const capped = capString(c.thinkingText, PROSE_CAP);
    lean.thinkingText = capped.value;
    if (capped.truncated) lean.thinkingTruncated = true;
  }
  if (typeof c.outputText === "string") {
    const capped = capString(c.outputText, PROSE_CAP);
    lean.outputText = capped.value;
    if (capped.truncated) lean.outputTruncated = true;
  }
  if (c.toolInput !== undefined) {
    const capped = capDeep(c.toolInput, TOOL_PAYLOAD_CAP);
    lean.toolInput = capped.value;
    if (capped.truncated) lean.toolInputTruncated = true;
  }
  if (typeof c.toolResultContent === "string") {
    const capped = capString(c.toolResultContent, TOOL_PAYLOAD_CAP);
    lean.toolResultContent = capped.value;
    if (capped.truncated) lean.toolResultTruncated = true;
  }
  if (c.toolUseResult !== undefined) {
    const capped = capDeep(c.toolUseResult, TOOL_PAYLOAD_CAP);
    lean.toolUseResult = capped.value;
    if (capped.truncated) lean.toolUseResultTruncated = true;
  }
  if (typeof c.tokenCount === "number") lean.tokenCount = c.tokenCount;

  return lean;
}

export interface LeanSubagent {
  id: string;
  description?: string;
  subagentType?: string;
  startTime: Date;
  endTime: Date;
  durationMs: number;
  isParallel: boolean;
  isOngoing?: boolean;
  metrics: SessionMetrics;
  mainSessionImpact?: Process["mainSessionImpact"];
  team?: Process["team"];
  /** Step outline from this subagent's own messages (thinking/tool calls/output), same shape as a main-thread AI chunk's steps. Does not recurse into a sub-subagent's own subagents — the vendored resolver only links one level of Task->subagent from the parent session, so a subagent's own Task calls aren't separately resolved here either (pre-existing pipeline limitation, not introduced by this shaping step). */
  steps: LeanStep[];
}

function shapeSubagent(process: Process, chunkBuilder: ChunkBuilder): LeanSubagent {
  // ChunkBuilder.buildChunks() unconditionally drops isSidechain messages
  // (`messages.filter(m => !m.isSidechain)` — see buildChunks in
  // ChunkBuilder.ts) because at the *main session* level, isSidechain marks
  // a message as belonging to a subagent rather than the main thread. But
  // every message inside a subagent's own JSONL file is itself flagged
  // isSidechain: true (relative to the PARENT session, not the subagent's
  // own frame of reference) — passing them through unmodified means
  // buildChunks filters out the subagent's ENTIRE message list, silently
  // producing zero steps for every subagent. Re-flag them as the main
  // thread of *this* buildChunks call, which is exactly what they are here.
  const ownMessages = process.messages.map((m) => (m.isSidechain ? { ...m, isSidechain: false } : m));
  const chunks = chunkBuilder.buildChunks(ownMessages, []);
  const steps = chunks
    .filter(isAIChunk)
    .flatMap((c) => (c as unknown as EnhancedAIChunk).semanticSteps ?? [])
    .map(shapeStep);

  return {
    id: process.id,
    description: process.description,
    subagentType: process.subagentType,
    startTime: process.startTime,
    endTime: process.endTime,
    durationMs: process.durationMs,
    isParallel: process.isParallel,
    isOngoing: process.isOngoing,
    metrics: process.metrics,
    mainSessionImpact: process.mainSessionImpact,
    team: process.team,
    steps,
  };
}

interface LeanChunkBase {
  id: string;
  startTime: Date;
  endTime: Date;
  durationMs: number;
  metrics: SessionMetrics;
}

export interface LeanUserChunk extends LeanChunkBase {
  chunkType: "user";
  text: string;
  textTruncated?: boolean;
  hasImage: boolean;
}

export interface LeanSystemChunk extends LeanChunkBase {
  chunkType: "system";
  text: string;
  textTruncated?: boolean;
  commandOutput: string;
  commandOutputTruncated?: boolean;
}

export interface LeanCompactChunk extends LeanChunkBase {
  chunkType: "compact";
  text: string;
  textTruncated?: boolean;
}

export interface LeanAIChunk extends LeanChunkBase {
  chunkType: "ai";
  steps: LeanStep[];
  subagents: LeanSubagent[];
  /** Highest `accumulatedContext` reached by any step in this chunk — a per-chunk context-window reading for the trace UI's delta column/sparkline. */
  contextTokensEnd?: number;
}

export type LeanChunk = LeanUserChunk | LeanSystemChunk | LeanCompactChunk | LeanAIChunk;

function shapeChunk(chunk: Chunk, chunkBuilder: ChunkBuilder): LeanChunk {
  const base: LeanChunkBase = {
    id: chunk.id,
    startTime: chunk.startTime,
    endTime: chunk.endTime,
    durationMs: chunk.durationMs,
    metrics: chunk.metrics,
  };

  if (isUserChunk(chunk)) {
    const { text, hasImage } = messageText(chunk.userMessage);
    const capped = capString(text, CHUNK_TEXT_CAP);
    return { ...base, chunkType: "user", text: capped.value, textTruncated: capped.truncated || undefined, hasImage };
  }

  if (isSystemChunk(chunk)) {
    const { text } = messageText(chunk.message);
    const cappedText = capString(text, CHUNK_TEXT_CAP);
    const capped = capString(chunk.commandOutput, TOOL_PAYLOAD_CAP);
    return {
      ...base,
      chunkType: "system",
      text: cappedText.value,
      textTruncated: cappedText.truncated || undefined,
      commandOutput: capped.value,
      commandOutputTruncated: capped.truncated || undefined,
    };
  }

  if (isCompactChunk(chunk)) {
    const { text } = messageText(chunk.message);
    const capped = capString(text, CHUNK_TEXT_CAP);
    return { ...base, chunkType: "compact", text: capped.value, textTruncated: capped.truncated || undefined };
  }

  // AI chunk. ChunkBuilder.buildChunks() (called by buildSessionDetail above)
  // always returns EnhancedAIChunk for the 'ai' variant — SessionDetail's own
  // `chunks: Chunk[]` field type just doesn't say so (see ChunkBuilder.ts).
  const enhanced = chunk as unknown as EnhancedAIChunk;
  const steps = (enhanced.semanticSteps ?? []).map(shapeStep);
  const subagents = enhanced.processes.map((p) => shapeSubagent(p, chunkBuilder));
  let contextTokensEnd: number | undefined;
  for (const s of steps) {
    if (s.accumulatedContext !== undefined) {
      contextTokensEnd = contextTokensEnd === undefined ? s.accumulatedContext : Math.max(contextTokensEnd, s.accumulatedContext);
    }
  }

  return { ...base, chunkType: "ai", steps, subagents, contextTokensEnd };
}

export interface LeanSessionDetail {
  session: Session;
  metrics: SessionMetrics;
  models: string[];
  subagentCount: number;
  chunks: LeanChunk[];
  /** Subagents present in `processes[]` that no chunk claimed (mirrors ChunkBuilder.buildWaterfallData's own defensive fallback for the same case). Rare — kept for completeness rather than silently dropping data. */
  unattachedSubagents: LeanSubagent[];
  fingerprint?: string;
}

/**
 * Reshape a full `SessionDetail` (from buildTrace) into the lean payload
 * `GET /api/sessions/:id/trace` returns by default. Pure function — no I/O,
 * no parser changes, just a smaller view over data buildTrace already
 * computed. See the module-level comment above for why this exists.
 */
export function shapeTraceForResponse(detail: SessionDetail): LeanSessionDetail {
  const chunkBuilder = new ChunkBuilder();
  const chunks = detail.chunks.map((c) => shapeChunk(c, chunkBuilder));

  const attachedIds = new Set<string>();
  for (const chunk of detail.chunks) {
    if (isAIChunk(chunk)) {
      for (const p of chunk.processes) attachedIds.add(p.id);
    }
  }
  const unattachedSubagents = detail.processes
    .filter((p) => !attachedIds.has(p.id))
    .map((p) => shapeSubagent(p, chunkBuilder));

  const allMessages: ParsedMessage[] = [...detail.messages, ...detail.processes.flatMap((p) => p.messages)];
  const models = Array.from(
    new Set(allMessages.map((m) => m.model).filter((m): m is string => typeof m === "string" && m.length > 0))
  ).sort();

  return {
    session: detail.session,
    metrics: detail.metrics,
    models,
    subagentCount: detail.processes.length,
    chunks,
    unattachedSubagents,
    fingerprint: detail.fingerprint,
  };
}
