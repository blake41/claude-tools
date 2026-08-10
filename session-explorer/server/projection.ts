// ── Projection: vendored ParsedMessage → `messages` row descriptors ──
//
// THE one place lossy transforms live (R3). Everything upstream of this
// module is full fidelity: the vendored parser produces `ParsedMessage`s,
// `raw_records` stores the verbatim JSONL line, and the gzip archive keeps
// the original file. Anything this module drops or shortens is a DISPLAY /
// SEARCH decision, never a storage decision — re-projecting from raw is
// always possible without touching source files.
//
// Pure by construction: no file reading, no JSON.parse of files, no tree
// walking. Branch selection (canonical/active path) already happened
// upstream in server/trace/active-path.ts's `filterActivePath`.

import { guardFtsTokens, redactSecrets } from "./redact";
import type { ContentBlock } from "./trace/vendor/main/types/jsonl";
import type { ParsedMessage } from "./trace/vendor/main/types/messages";

// ── Row descriptor ────────────────────────────────────────────────────

/**
 * The `messages.message_type` vocabulary, unchanged from the strip.ts era
 * (D9). Every existing prepared statement, subquery and Ask/chat recipe is
 * written against these five values — the migration changes what content
 * survives, not what a row means.
 */
export type ProjectedMessageType =
  | "text"
  | "tool_use"
  | "tool_result"
  | "system"
  | "subagent_prompt";

export interface ProjectedRow {
  /** `messages.role` — the column's contract is (user|assistant), per the
   *  hand-written schema prose the Ask/chat agent reads (server/chat.ts:42). */
  role: "user" | "assistant";
  content: string;
  messageType: ProjectedMessageType;
  /** Links a tool_use row to its tool_result row. Null on text/system rows. */
  toolUseId: string | null;
  /** tool_use rows only: tool name and the full input JSON, so the UI renders
   *  per-tool views without re-parsing the `'ToolName: …'` content prefix. */
  toolName: string | null;
  toolInput: string | null;
  /** ISO-8601 string; `ParsedMessage.timestamp` is a Date. */
  timestamp: string | null;
  /** `messages.record_uuid` — the join key into `raw_records` (D2). */
  recordUuid: string | null;
}

/**
 * Which transcript file the message came from. Ingest knows this (parent
 * transcript vs `subagents/*.jsonl` / resolver output) and passes it in; the
 * subagent_prompt override rule itself lives here so it is tested, not
 * inlined in ingest.
 */
export type ProjectionSource = "parent" | "subagent";

// ── Tool-input summaries ──────────────────────────────────────────────

/**
 * Ported verbatim from strip.ts:397. The `'ToolName: <summary>'` content
 * format this feeds is a SILENT FORMAT CONTRACT with the Ask/chat SQL agent's
 * query recipe at server/chat.ts:89 (`content LIKE 'ToolName:%'`). Changing
 * the separator or the per-tool summary fields breaks that recipe with no
 * type error and no failing query — just wrong answers.
 */
export function summarizeToolInput(
  toolName: string,
  input: Record<string, unknown>
): string {
  switch (toolName) {
    case "Bash":
      return String(input.command || "").slice(0, 500);
    case "Read":
    case "Edit":
    case "Write":
    case "read":
    case "edit":
    case "write":
      return String(input.file_path || "");
    case "Grep":
    case "Glob":
    case "grep":
    case "glob":
      return String(input.pattern || "");
    case "Agent":
    case "agent":
      return String(input.description || input.prompt || "").slice(0, 200);
    case "ToolSearch":
      return String(input.query || "");
    default:
      try {
        return JSON.stringify(input).slice(0, 300);
      } catch {
        return "";
      }
  }
}

// ── Text blocks ───────────────────────────────────────────────────────

/**
 * Strip XML tags that leak into user/assistant text (task-notification,
 * system-reminder, etc.). Ported verbatim from strip.ts:353 — the ONE
 * strip.ts text transform that survives U3, because it removes harness
 * plumbing that was never conversational content, not user or model prose.
 *
 * Everything else strip.ts did to text is deliberately gone:
 *  - the `> 100 chars` assistant-text floor (strip.ts:609), which silently
 *    deleted every short assistant answer;
 *  - `isSkillInjection`/`isSystemContext` collapse (strip.ts:322-350), which
 *    replaced multi-KB skill and CLAUDE.md dumps with a one-line stub.
 * Both were STORAGE-level losses. Full fidelity is the point of the
 * migration; `raw_records` keeps the pre-strip original either way.
 */
function stripXmlNoise(text: string): string {
  // Remove entire <task-notification>...</task-notification> blocks
  let cleaned = text.replace(/<task-notification>[\s\S]*?<\/task-notification>/g, "");
  // Remove entire <system-reminder>...</system-reminder> blocks
  cleaned = cleaned.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "");
  // Remove <output-file>...</output-file>, <tool-use-id>...</tool-use-id>, etc.
  cleaned = cleaned.replace(/<(?:output-file|tool-use-id|task-id|status|summary|result|available-deferred-tools)>[\s\S]*?<\/(?:output-file|tool-use-id|task-id|status|summary|result|available-deferred-tools)>/g, "");
  // Remove any remaining orphan XML-looking tags that are clearly not markdown
  cleaned = cleaned.replace(/<\/?(?:task-notification|system-reminder|output-file|tool-use-id|task-id|status|summary|result|available-deferred-tools)[^>]*>/g, "");
  return cleaned.trim();
}

/**
 * Collapse a slash-command wrapper to the `/name args` line a human would
 * recognize. Ported from strip.ts:365, minus its 100-char arg slice — the
 * cap was a storage-era economy and the full args are conversational
 * content.
 *
 * Kept (unlike the skill/system collapse heuristics) because it is the same
 * category as stripXmlNoise: harness XML wrapping, not prose. stripXmlNoise's
 * tag list does not cover `<command-name>`, so without this the row renders
 * as raw XML in the UI.
 */
function compactCommand(text: string): string | null {
  const cmdMatch = text.match(/<command-name>(.*?)<\/command-name>/);
  if (!cmdMatch) return null;

  const cmd = cmdMatch[1].trim().replace(/^\//, "");
  const argsMatch = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
  const args = argsMatch ? argsMatch[1].trim() : "";
  return `/${cmd} ${args}`.trim();
}

/**
 * Project a text block's body. Returns "" when nothing survives (e.g. a
 * block that was entirely a `<system-reminder>` stub) — the caller emits no
 * row in that case, matching strip.ts's `if (processed)` guard.
 */
function projectTextBody(raw: string): string {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  return stripXmlNoise(compactCommand(trimmed) ?? trimmed);
}

// ── Tool-result body ──────────────────────────────────────────────────

/**
 * Per-result projection cap (D7). 4000 matches the `TOOL_PAYLOAD_CAP = 4000`
 * precedent already used by the trace shaper (server/trace/index.ts:427) —
 * one number for "how much of a tool payload a UI surface gets", not two.
 *
 * This replaces strip.ts's 500-char `.slice(0, 500)` (strip.ts:559), which
 * was a STORAGE decision and permanently destroyed the rest. Here it is a
 * projection decision only: `raw_records` keeps the full body (D2), so the
 * expand-on-click path and re-projection can always recover it.
 */
export const PROJECTION_TOOL_RESULT_CAP = 4000;

/**
 * Appended INSIDE the cap (total length stays exactly the cap) so the UI can
 * tell "this tool result ended here" from "this tool result was cut".
 */
export const PROJECTION_TRUNCATION_MARKER = "… [truncated]";

/**
 * Flatten a `ToolResultContent.content` — string on most tools, an array of
 * content blocks on tools that return structured output (jsonl.ts:53-58).
 */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (b): b is { type: string; text: string } =>
          !!b &&
          typeof b === "object" &&
          (b as { type?: unknown }).type === "text" &&
          typeof (b as { text?: unknown }).text === "string"
      )
      .map((b) => b.text)
      .join("\n");
  }
  return "";
}

function capToolResult(text: string): string {
  if (text.length <= PROJECTION_TOOL_RESULT_CAP) return text;
  return (
    text.slice(
      0,
      PROJECTION_TOOL_RESULT_CAP - PROJECTION_TRUNCATION_MARKER.length
    ) + PROJECTION_TRUNCATION_MARKER
  );
}

/**
 * The tool-result pipeline, in the order D7 fixes:
 *   redactSecrets → cap → guardFtsTokens
 *
 * Order is load-bearing. Redaction must see the WHOLE body (a secret
 * straddling the cap boundary would otherwise survive in the tail that gets
 * kept), and the token guard must run last because it is the final shape of
 * the string SQLite's FTS5 tokenizer sees. The guard only inserts spaces, so
 * it can push the stored length slightly past the cap — accepted: the cap
 * bounds CONTENT, the guard bounds TOKENS.
 *
 * Note what is deliberately NOT here, both carried over from strip.ts:559
 * and both dropped: the `\s+ → " "` whitespace collapse and the `^\s*\d+[→│|]`
 * line-number-prefix strip. Both existed only to squeeze a tool result into
 * 500 chars; at 4000 chars they destroy the formatting (code indentation,
 * diff alignment, Read line numbers) that makes a tool result readable.
 */
function projectToolResultBody(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const redacted = redactSecrets(trimmed).text;
  return guardFtsTokens(capToolResult(redacted));
}

// ── Internal helpers ──────────────────────────────────────────────────

function isoTimestamp(msg: ParsedMessage): string | null {
  const ts = msg.timestamp;
  if (!(ts instanceof Date) || Number.isNaN(ts.getTime())) return null;
  return ts.toISOString();
}

function contentBlocks(msg: ParsedMessage): ContentBlock[] {
  return Array.isArray(msg.content) ? msg.content : [];
}

/**
 * Record types that never produce a row. `summary`, `file-history-snapshot`
 * and `queue-operation` are structural metadata, not conversation — the same
 * set strip.ts:240 skipped (minus `system`, which D9 now maps to a row).
 */
export const SKIP_RECORD_TYPES = new Set<string>([
  "summary",
  "file-history-snapshot",
  "queue-operation",
]);

/**
 * The message_type a plain text body gets, before the subagent override.
 * `system` records map to `'system'` per D9; everything else is `'text'`.
 * (strip.ts instead inferred 'system' from content markers — that heuristic
 * is gone; the record type is the honest signal.)
 */
function baseTextType(msg: ParsedMessage): ProjectedMessageType {
  return msg.type === "system" ? "system" : "text";
}

/**
 * `messages.role` only ever holds "user" or "assistant" (server/chat.ts:42
 * documents that to the SQL agent as fact). `ParsedMessage.role` is optional
 * and free-form, so fall back to the record type: assistant records are
 * "assistant", everything else — user, system, summary — is "user". That
 * matches strip.ts, which only ever emitted 'system' rows for user-role
 * records (skill/CLAUDE.md dumps).
 */
function rowRole(msg: ParsedMessage): "user" | "assistant" {
  if (msg.role === "assistant" || msg.role === "user") return msg.role;
  return msg.type === "assistant" ? "assistant" : "user";
}

function toolUseRow(
  block: { id?: string; name?: string; input?: Record<string, unknown> },
  msg: ParsedMessage
): ProjectedRow | null {
  if (!block.name) return null;
  const input = (block.input || {}) as Record<string, unknown>;
  let toolInput: string | null = null;
  try {
    toolInput = JSON.stringify(input);
  } catch {
    // Circular / non-serializable — drop input, keep the summary.
  }
  return {
    role: "assistant",
    content: `${block.name}: ${summarizeToolInput(block.name, input)}`,
    messageType: "tool_use",
    toolUseId: block.id ?? null,
    toolName: block.name,
    toolInput,
    timestamp: isoTimestamp(msg),
    recordUuid: msg.uuid ?? null,
  };
}

// ── projectMessage ────────────────────────────────────────────────────

/**
 * The subagent override (R12's "subagent_prompt contract"): a USER TEXT row
 * that came out of a subagent transcript is an agent-to-agent prompt, not a
 * human turn, so it is stored as `subagent_prompt`. Every query filtering
 * `message_type = 'text'` then excludes it for free, and the search
 * statements (server/index.ts:191,204,217,229) exclude it explicitly. Ported
 * from the inline rule at server/ingest.ts:429 so it is testable in one
 * place; ingest supplies the `source` hint because only ingest knows which
 * file a record came from.
 *
 * Scope is exactly user + text: subagent tool_use/tool_result/system rows
 * keep their own types, matching the old ingest condition
 * (`role === 'user' && messageType === 'text'`).
 */
function applySubagentOverride(
  messageType: ProjectedMessageType,
  role: "user" | "assistant",
  source: ProjectionSource
): ProjectedMessageType {
  if (source === "subagent" && role === "user" && messageType === "text") {
    return "subagent_prompt";
  }
  return messageType;
}

/**
 * Project ONE `ParsedMessage` into zero-or-more row descriptors, in content
 * block order.
 */
export function projectMessage(
  msg: ParsedMessage,
  source: ProjectionSource = "parent"
): ProjectedRow[] {
  const rows: ProjectedRow[] = [];
  if (!msg) return rows;
  if (SKIP_RECORD_TYPES.has(msg.type)) return rows;

  const role = rowRole(msg);
  const textType = applySubagentOverride(baseTextType(msg), role, source);

  // Older sessions store `message.content` as a bare string (the vendored
  // type guards call this out explicitly, vendor/main/types/messages.ts:131).
  // One verbatim text row, no block walk.
  if (typeof msg.content === "string") {
    const text = projectTextBody(msg.content);
    if (text) {
      rows.push({
        role,
        content: text,
        messageType: textType,
        toolUseId: null,
        toolName: null,
        toolInput: null,
        timestamp: isoTimestamp(msg),
        recordUuid: msg.uuid ?? null,
      });
    }
    return rows;
  }

  for (const block of contentBlocks(msg)) {
    if (!block || typeof block !== "object") continue;

    if (block.type === "text") {
      const text = projectTextBody(block.text);
      if (!text) continue;
      rows.push({
        role,
        content: text,
        messageType: textType,
        toolUseId: null,
        toolName: null,
        toolInput: null,
        timestamp: isoTimestamp(msg),
        recordUuid: msg.uuid ?? null,
      });
      continue;
    }

    if (block.type === "tool_use") {
      const row = toolUseRow(block, msg);
      if (row) rows.push(row);
      continue;
    }

    if (block.type === "tool_result") {
      const content = projectToolResultBody(toolResultText(block.content));
      if (!content) continue;
      rows.push({
        role,
        content,
        messageType: "tool_result",
        // `sourceToolUseID` is the record-level mirror of the block's
        // `tool_use_id` — fall back to it when the block omits one.
        toolUseId: block.tool_use_id ?? msg.sourceToolUseID ?? null,
        toolName: null,
        toolInput: null,
        timestamp: isoTimestamp(msg),
        recordUuid: msg.uuid ?? null,
      });
    }

    // `thinking` and `image` blocks intentionally produce no row — see the
    // message_type vocabulary note on ProjectedMessageType (D9). Their
    // content is preserved in raw_records and in the trace chunk model.
  }

  return rows;
}

/**
 * Project a whole conversation (parent `detail.messages`, or one subagent
 * process's `messages`) in order. Sequence numbers are NOT assigned here —
 * ingest owns them, because only ingest knows the parent/subagent offset.
 */
export function projectMessages(
  msgs: ParsedMessage[],
  source: ProjectionSource = "parent"
): ProjectedRow[] {
  if (!Array.isArray(msgs)) return [];
  const rows: ProjectedRow[] = [];
  for (const msg of msgs) {
    for (const row of projectMessage(msg, source)) rows.push(row);
  }
  return rows;
}

// ── File references (session_files) ───────────────────────────────────

export interface FileReference {
  filePath: string;
  fileName: string;
  operation: "write" | "edit" | "read";
  timestamp: string | null;
  sequence: number;
}

/**
 * The tools whose `file_path` input counts as "this session touched this
 * file". Ported from strip.ts:395 — lowercase aliases included because
 * older transcripts and some MCP servers emit them.
 */
const FILE_TOOL_NAMES = new Set([
  "Write",
  "Edit",
  "Read",
  "write",
  "edit",
  "read",
]);

function extractFileName(filePath: string): string {
  const parts = filePath.split("/");
  return parts[parts.length - 1] || filePath;
}

/**
 * Collect `session_files` rows from Write/Edit/Read tool calls, deduped on
 * `filePath|operation` and keeping the FIRST occurrence's timestamp — the
 * same key and the same first-wins rule as strip.ts:510-524, so file
 * listings do not change shape across the migration.
 *
 * Image filtering stays in ingest (`isImageFile`, server/ingest.ts:76): it
 * is a policy about what is worth tracking, not a parse rule.
 */
export function extractFileReferences(msgs: ParsedMessage[]): FileReference[] {
  if (!Array.isArray(msgs)) return [];

  const fileMap = new Map<string, FileReference>();
  let sequence = 0;

  for (const msg of msgs) {
    if (!msg) continue;
    for (const block of contentBlocks(msg)) {
      if (!block || typeof block !== "object") continue;
      if (block.type !== "tool_use" || !block.name) continue;
      if (!FILE_TOOL_NAMES.has(block.name)) continue;

      const filePath = (block.input ?? {}).file_path;
      if (!filePath || typeof filePath !== "string") continue;

      const operation = block.name.toLowerCase() as "write" | "edit" | "read";
      const key = `${filePath}|${operation}`;
      if (fileMap.has(key)) continue;

      fileMap.set(key, {
        filePath,
        fileName: extractFileName(filePath),
        operation,
        timestamp: isoTimestamp(msg),
        sequence: sequence++,
      });
    }
  }

  return Array.from(fileMap.values());
}

// ── Session header ────────────────────────────────────────────────────

/**
 * Pull the session's `branch` and `cwd` off the parsed records. Each field
 * is taken from the FIRST record that carries it, independently: the
 * vendored parser only copies cwd/gitBranch off conversational entries
 * (vendor/main/utils/jsonl.ts:134-135), so a transcript can easily lead with
 * records that have one and not the other.
 *
 * `sessionId`/`date`/`project` from strip.ts's `SessionHeader` are
 * intentionally absent: ingest already knows the session id and derives date
 * and project from data it holds, so re-deriving them here would just be a
 * second source of truth.
 */
export function projectHeader(msgs: ParsedMessage[]): {
  branch: string;
  cwd: string;
} {
  const header = { branch: "", cwd: "" };
  if (!Array.isArray(msgs)) return header;

  for (const msg of msgs) {
    if (!msg) continue;
    if (!header.cwd && typeof msg.cwd === "string" && msg.cwd) {
      header.cwd = msg.cwd;
    }
    if (!header.branch && typeof msg.gitBranch === "string" && msg.gitBranch) {
      header.branch = msg.gitBranch;
    }
    if (header.cwd && header.branch) break;
  }

  return header;
}
