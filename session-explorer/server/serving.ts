// ── Serving from rows (plan U5) ─────────────────────────────────────
//
// Pure query/reshape logic for the row-backed read paths — paginated
// messages, per-record raw expand, and trace reassembly from
// `sessions.trace_meta` + `trace_chunks`. Factored out of `server/index.ts`
// into its own module (matching the existing pattern of `chat.ts`,
// `projection.ts`, `redact.ts`, `summary-staleness.ts`, etc.) for exactly one
// reason: `server/index.ts` opens the real on-disk `data/sessions.db` and
// calls `app.listen()` as *module-load* side effects, so it can never be
// imported from a test. Every function here takes its `Database` as a
// parameter instead of importing `./db.js`, so tests can hand it an
// in-memory database with no mocking required.
//
// This is NOT a router — nothing here calls `app.get`/`app.post`. Route
// registration stays in `server/index.ts`; this module only answers
// "given this session id and these rows, what should the response be."

import { PROJECTION_TRUNCATION_MARKER } from "./projection.js";

// Structural type for bun:sqlite's Database, duck-typed rather than imported
// so this module's tests can hand it a real bun:sqlite Database OR anything
// with the same shape, without pulling `bun:sqlite`'s ambient types in here.
interface PreparedStatementLike {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
interface QueryableDatabaseLike {
  prepare(sql: string): PreparedStatementLike;
}

// ── cleanXmlNoise ────────────────────────────────────────────────────
//
// Read-time strip of harness XML noise (task-notification, system-reminder,
// etc.) that leaked into stored message content under the pre-migration
// ingest path. Projection (server/projection.ts) now strips this at ingest
// time for anything reingested through the unified parser, so this call is
// transitional — kept per the plan's deferred note until the U8
// force-reingest makes every row clean, at which point it can be deleted.
export function cleanXmlNoise(text: string): string {
  return text
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, "")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<(?:output-file|tool-use-id|task-id|status|summary|result|available-deferred-tools)>[\s\S]*?<\/(?:output-file|tool-use-id|task-id|status|summary|result|available-deferred-tools)>/g, "")
    .replace(/<\/?(?:task-notification|system-reminder|output-file|tool-use-id|task-id|status|summary|result|available-deferred-tools)[^>]*>/g, "")
    .trim();
}

// ── Quick-search FTS query building ──────────────────────────────────
//
// The porter/facet FTS5 migration (D4/D5) added `title`/`workspace` as
// indexed columns on `messages_fts`, denormalized onto every message row of
// a session (server/ingest.ts writes the session's title/workspace name
// onto each row it inserts). That denormalization is a deliberate,
// necessary FTS5 constraint (external-content tables index each column from
// the same-named column on the content table, so there is no way to index
// a session-level field without copying it onto every row) — but it means
// an UNSCOPED `messages_fts MATCH ?` matches title/workspace text on every
// row of a session, not just the rows whose CONTENT matched. A session
// titled "Parser migration" with 400 unrelated messages will produce 400
// title-only hits for the query "parser", and at the endpoint's `LIMIT 200`
// those title-only hits can fill the entire result set and starve out
// genuine content matches elsewhere. This was a real, reproduced regression
// (see the "does not flood real content matches" test in serving.test.ts) —
// not merely theoretical.
//
// `scopeFtsToContent` (below) is the fix: every quick-search MATCH scopes
// to the `content` column only, restoring the pre-migration search
// semantics for the quick-search box. This sanitizer's OWN job is narrower
// and unchanged (D9) — it was written only for plain content search and
// strips ':' along with every other non-word character, so a facet-shaped
// quick-search query like "workspace: terra" is NOT turned into a
// column-scoped filter here; it becomes `NEAR("workspace" "terra", 16)`
// (space-separated) or `"workspaceterra"` (no space). Combined with
// `scopeFtsToContent`, that sanitized expression is then scoped to
// `content` only, so it searches message content for those literal word(s)
// — never title/workspace. That means quick search cannot facet-filter by
// workspace/title at all (searching "workspace: terra" looks for the literal
// words "workspace" and "terra" IN MESSAGE CONTENT, not sessions in the
// terra workspace) — a real limitation, but a safe, predictable one, and a
// strict improvement over floodable unscoped matching. Column-scoped facet
// filtering IS supported end to end, just via chat.ts's raw MATCH tool (see
// server/chat.ts's "Faceted search" recipe), which never routes through
// this sanitizer.

/** Convert a user's quick-search query to an FTS5 MATCH expression. */
export function toFtsQuery(query: string): string {
  const trimmed = query.trim();

  // Exact phrase match: user wrapped query in quotes e.g. "artifacts = the data layer"
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length > 2) {
    const phrase = trimmed.slice(1, -1).replace(/[^a-zA-Z0-9_.\-\s]/g, '').trim();
    return phrase ? `"${phrase}"` : '""';
  }

  // Default: NEAR for multi-word, plain match for single word
  const words = trimmed.split(/\s+/).filter(Boolean)
    .map(w => w.replace(/[^a-zA-Z0-9_.\-]/g, ''))
    .filter(w => w.length > 0);
  if (words.length === 0) return '""';
  if (words.length === 1) return `"${words[0].replace(/"/g, '""')}"`;
  // NEAR keeps terms within 16 tokens so snippets show both matches
  const quoted = words.map(w => `"${w.replace(/"/g, '""')}"`).join(' ');
  return `NEAR(${quoted}, 16)`;
}

/** Check if query contains underscore-joined terms that FTS5 can't match as phrases */
export function hasUnderscoreTerms(query: string): boolean {
  return query.trim().split(/\s+/).some(w => w.includes('_'));
}

/**
 * Scope an FTS5 MATCH expression (as built by `toFtsQuery`) to the
 * `content` column only, excluding the `title`/`workspace` facet columns
 * the D4/D5 porter/facet migration added to `messages_fts`. FTS5's
 * column-filter syntax (`col: (expr)`) applies to any following primitive
 * including a parenthesized group, so this wraps cleanly around phrase
 * matches, single words, and `NEAR(...)` expressions alike — verified
 * against a real in-memory FTS5 table, not just read off the grammar.
 *
 * Without this, quick search on the two `/api/search` MATCH statements in
 * server/index.ts floods results with title/workspace-only hits (see the
 * doc comment above `toFtsQuery` for the reproduced regression this fixes).
 */
export function scopeFtsToContent(ftsQuery: string): string {
  return `content: (${ftsQuery})`;
}

// ── Session existence ────────────────────────────────────────────────

export function sessionExists(db: QueryableDatabaseLike, sessionId: string): boolean {
  return !!db.prepare(`SELECT 1 FROM sessions WHERE id = ?`).get(sessionId);
}

// ── Windowed messages ────────────────────────────────────────────────

export interface WindowedMessageRow {
  role: string;
  content: string;
  timestamp: string | null;
  sequence: number;
  message_type: string | null;
  tool_use_id: string | null;
  tool_name: string | null;
  tool_input: string | null;
  record_uuid: string | null;
  /** True when the projection capped this row's content (D7) — the content
   *  ends in `PROJECTION_TRUNCATION_MARKER`. The UI uses this to decide
   *  whether an "expand" control (fetching `/records/:uuid`) is worth showing. */
  truncated: boolean;
}

export interface WindowedMessagesResult {
  messages: WindowedMessageRow[];
  total: number;
  limit: number;
  offset: number;
}

interface RawMessageRow {
  role: string;
  content: string;
  timestamp: string | null;
  sequence: number;
  message_type: string | null;
  tool_use_id: string | null;
  tool_name: string | null;
  tool_input: string | null;
  record_uuid: string | null;
}

/**
 * `GET /api/sessions/:id/messages` and the inline first-window on
 * `GET /api/sessions/:id` both read through this — one query, one shaping
 * rule, so the two endpoints can never drift.
 *
 * Ordering is `timestamp ASC, sequence ASC` per the project's sequence-vs-
 * timestamp rule (sequence can be non-chronological due to rewind/replay).
 * `sequence` is assigned strictly increasing per session at ingest, so the
 * combined order is a deterministic total order — offset/limit windows are
 * stable across repeated calls as long as the session isn't reingested
 * in between (D10: sessions are immutable otherwise). Offset/limit was
 * chosen over a `(timestamp, sequence)` keyset cursor for that reason: the
 * extra complexity of a cursor buys safety against a mutation pattern this
 * data doesn't have. If reingest-while-a-client-is-mid-scroll ever becomes
 * a real complaint, keyset is the fallback — see the plan's U5 deferred note.
 */
export function windowedMessages(
  db: QueryableDatabaseLike,
  sessionId: string,
  opts: { limit: number; offset: number }
): WindowedMessagesResult {
  const { limit, offset } = opts;

  const totalRow = db
    .prepare(`SELECT COUNT(*) as total FROM messages WHERE session_id = ?`)
    .get(sessionId) as { total: number } | undefined;
  const total = totalRow?.total ?? 0;

  const rows = db
    .prepare(
      `SELECT role, content, timestamp, sequence, message_type, tool_use_id, tool_name, tool_input, record_uuid
       FROM messages
       WHERE session_id = ?
       ORDER BY timestamp ASC, sequence ASC
       LIMIT ? OFFSET ?`
    )
    .all(sessionId, limit, offset) as RawMessageRow[];

  const messages: WindowedMessageRow[] = rows
    .map((row) => ({
      ...row,
      // Truncation is judged on the STORED content, before the transitional
      // cleanXmlNoise strip below — cleanXmlNoise only removes harness XML
      // tags, never touches PROJECTION_TRUNCATION_MARKER, but computing this
      // first keeps the two concerns from ever accidentally interacting.
      truncated: row.content.endsWith(PROJECTION_TRUNCATION_MARKER),
      content: cleanXmlNoise(row.content),
    }))
    .filter((row) => row.content.length > 0);

  return { messages, total, limit, offset };
}

// ── Raw record expand ────────────────────────────────────────────────

export interface RawRecordResult {
  session_id: string;
  uuid: string;
  seq: number;
  raw: string;
}

/**
 * `GET /api/sessions/:id/records/:uuid` — the expand-on-click source (D2).
 * Returns the verbatim JSONL line untouched: no cleanXmlNoise, no
 * redaction, no cap. `raw_records` exists specifically so this can always
 * recover exactly what Claude Code wrote, independent of anything the
 * projection layer decided to shorten or redact for search/display.
 */
export function getRawRecord(
  db: QueryableDatabaseLike,
  sessionId: string,
  uuid: string
): RawRecordResult | null {
  const row = db
    .prepare(`SELECT uuid, seq, raw FROM raw_records WHERE session_id = ? AND uuid = ?`)
    .get(sessionId, uuid) as { uuid: string; seq: number; raw: string } | undefined;
  if (!row) return null;
  return { session_id: sessionId, uuid: row.uuid, seq: row.seq, raw: row.raw };
}

// ── Trace reassembly ─────────────────────────────────────────────────

export type TraceReassemblyResult =
  | { ok: true; trace: Record<string, unknown> }
  | { ok: false; reason: "not_found" | "no_trace" };

/**
 * `GET /api/sessions/:id/trace` — reassembles a `LeanSessionDetail`-shaped
 * object from `sessions.trace_meta` (the envelope: session/metrics/models/
 * subagentCount/unattachedSubagents/fingerprint) plus `trace_chunks` rows
 * (chunk_seq ASC) for the `chunks` array (D3). Byte-shape-compatible with
 * `shapeTraceForResponse`'s old output — `TraceView.tsx` needs no changes.
 *
 * `trace_meta IS NULL` means "never ingested with the unified parser" (the
 * comment on the column in server/db-migrations.ts) — that is the ONLY
 * signal used to distinguish "unknown session" from "known session with no
 * trace yet", both of which the route turns into a 404, but with different
 * messages.
 */
export function reassembleTrace(db: QueryableDatabaseLike, sessionId: string): TraceReassemblyResult {
  const row = db.prepare(`SELECT trace_meta FROM sessions WHERE id = ?`).get(sessionId) as
    | { trace_meta: string | null }
    | undefined;
  if (!row) return { ok: false, reason: "not_found" };
  if (!row.trace_meta) return { ok: false, reason: "no_trace" };

  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(row.trace_meta);
  } catch {
    // Corrupt trace_meta JSON is exactly as unusable as no trace_meta at all.
    return { ok: false, reason: "no_trace" };
  }

  const chunkRows = db
    .prepare(`SELECT payload FROM trace_chunks WHERE session_id = ? ORDER BY chunk_seq ASC`)
    .all(sessionId) as Array<{ payload: string }>;
  const chunks = chunkRows.map((r) => JSON.parse(r.payload));

  return { ok: true, trace: { ...meta, chunks } };
}
