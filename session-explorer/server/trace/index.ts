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
import { filterActivePath } from "./active-path";

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
 * Parse a session's transcript and run the full claude-devtools chunk/step +
 * subagent-linking pipeline, returning the complete (unstripped) analysis model.
 *
 * Mirrors upstream's `get-session-detail` IPC handler (ServiceContext-composed
 * ProjectScanner + SessionParser + SubagentResolver + ChunkBuilder), minus the
 * IPC-boundary stripping of `messages` — this endpoint is explicitly lossless.
 */
/**
 * Pre-filter a transcript to its active path (drop abandoned rewind
 * branches) before handing it to the vendored pipeline, which parses in
 * file order and has no branch semantics of its own. When nothing is
 * dropped the original file is parsed directly — no temp-file cost.
 * Subagent sibling files are deliberately NOT pre-filtered (the resolver
 * reads them from the project dir; rewinds inside subagent runs are rare).
 */
function materializeActivePath(
  filePath: string,
  sessionId: string
): { parsePath: string; cleanup: () => void } {
  const rawLines = readFileSync(filePath, "utf-8")
    .split("\n")
    .filter((l) => l.length > 0);
  const activeLines = filterActivePath(rawLines);
  if (activeLines.length >= rawLines.length) {
    return { parsePath: filePath, cleanup: () => {} };
  }
  const tempDir = mkdtempSync(join(tmpdir(), "session-explorer-activepath-"));
  const parsePath = join(tempDir, `${sessionId}.jsonl`);
  writeFileSync(parsePath, activeLines.join("\n") + "\n");
  return {
    parsePath,
    cleanup: () => {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    },
  };
}

export async function buildTrace(sessionId: string): Promise<SessionDetail> {
  const { resolved, cleanup: resolveCleanup } = resolveTranscript(sessionId);
  // resolveTranscript may have created a temp dir (archive fallback) —
  // if materializeActivePath throws, that temp must still be cleaned.
  let parsePath: string;
  let filterCleanup: () => void;
  try {
    ({ parsePath, cleanup: filterCleanup } = materializeActivePath(
      resolved.filePath,
      sessionId
    ));
  } catch (err) {
    resolveCleanup();
    throw err;
  }
  const cleanup = () => {
    filterCleanup();
    resolveCleanup();
  };

  try {
    const fsProvider = new LocalFileSystemProvider();
    // ProjectScanner/SubagentResolver need a real projects directory to resolve
    // sibling subagent files; archived (temp-file) transcripts have no such
    // sibling directory, so subagent linking is skipped for those (degrades
    // gracefully — the parent trace still returns in full).
    const projectsDir = resolved.projectId ? PROJECTS_DIR : dirname(resolved.filePath);
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

    if (resolved.projectId) {
      const subagentResolver = new SubagentResolver(projectScanner);
      try {
        subagents = await subagentResolver.resolveSubagents(
          resolved.projectId,
          sessionId,
          parsedSession.taskCalls,
          parsedSession.messages
        );
      } catch {
        // Subagent linking is best-effort — a parent trace without linked
        // subagents is still useful and shouldn't fail the whole request.
        subagents = [];
      }

      session = await projectScanner.getSession(resolved.projectId, sessionId);
    }

    if (!session) {
      session = buildStubSession(sessionId, resolved.projectId, resolved.filePath);
    }
    session.hasSubagents = subagents.length > 0;
    session.messageCount = parsedSession.messages.length;

    return chunkBuilder.buildSessionDetail(session, parsedSession.messages, subagents);
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

interface Capped<T> {
  value: T;
  truncated: boolean;
}

function capString(s: string, cap: number): Capped<string> {
  return s.length <= cap ? { value: s, truncated: false } : { value: s.slice(0, cap), truncated: true };
}

/** Recursively cap string leaves inside an arbitrary JSON-ish tool payload (tool_use input / toolUseResult). Non-string structure (arrays, structuredPatch hunks, numbers, booleans) passes through untouched. */
function capDeep(value: unknown, cap: number): Capped<unknown> {
  if (typeof value === "string") return capString(value, cap);
  if (Array.isArray(value)) {
    let truncated = false;
    const arr = value.map((item) => {
      const r = capDeep(item, cap);
      if (r.truncated) truncated = true;
      return r.value;
    });
    return { value: arr, truncated };
  }
  if (value !== null && typeof value === "object") {
    let truncated = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const r = capDeep(v, cap);
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
  if (typeof content === "string") return { text: content, hasImage: false };
  if (!Array.isArray(content)) return { text: "", hasImage: false };
  let hasImage = false;
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text") parts.push(block.text);
    else if (block.type === "image") hasImage = true;
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
  hasImage: boolean;
}

export interface LeanSystemChunk extends LeanChunkBase {
  chunkType: "system";
  text: string;
  commandOutput: string;
  commandOutputTruncated?: boolean;
}

export interface LeanCompactChunk extends LeanChunkBase {
  chunkType: "compact";
  text: string;
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
    return { ...base, chunkType: "user", text, hasImage };
  }

  if (isSystemChunk(chunk)) {
    const { text } = messageText(chunk.message);
    const capped = capString(chunk.commandOutput, TOOL_PAYLOAD_CAP);
    return {
      ...base,
      chunkType: "system",
      text,
      commandOutput: capped.value,
      commandOutputTruncated: capped.truncated || undefined,
    };
  }

  if (isCompactChunk(chunk)) {
    const { text } = messageText(chunk.message);
    return { ...base, chunkType: "compact", text };
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
