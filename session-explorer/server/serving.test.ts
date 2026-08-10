// ── Tests for server/serving.ts (plan U5: serving from rows) ────────
//
// `server/index.ts` can't be imported directly from a test — it opens the
// real on-disk `data/sessions.db` and calls `app.listen()` as module-load
// side effects (see server/serving.ts's header comment). So these tests
// exercise the extracted pure logic directly against an in-memory database.
//
// Fixture rows are produced by calling the SAME pure pipeline `ingestSession`
// calls (`buildTraceFromFile` -> `shapeTraceForResponse` -> `projectMessages`
// -> insert), not by hand-writing row literals — so the trace-reassembly
// test is checking against what that pipeline actually produces, not
// against my own assumptions about its shape. `ingestSession` itself is
// deliberately NOT used here: it imports `./db.js` (which would need
// `mock.module`, and that registration is GLOBAL across the whole `bun test`
// run per ingest.test.ts's own header comment — a second file mocking the
// same module path races with ingest.test.ts's registration and silently
// binds `ingest.ts`'s prepared statements to whichever file's in-memory db
// module-loaded first). Driving the same pure functions directly against
// this file's own `memDb` sidesteps that cross-file hazard entirely.

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, dirname, join } from "path";

import { applySchema } from "./db-migrations.js";
import { pickTitle } from "./title.js";
import { extractFileReferences, projectHeader, projectMessages } from "./projection.js";
import { buildTraceFromFile, shapeTraceForResponse } from "./trace/index.js";
import {
  cleanXmlNoise,
  getRawRecord,
  hasUnderscoreTerms,
  reassembleTrace,
  scopeFtsToContent,
  sessionExists,
  toFtsQuery,
  windowedMessages,
} from "./serving.js";

const memDb = new Database(":memory:");
applySchema(memDb);

function isoOrNull(value: unknown): string | null {
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString() : null;
}

/**
 * Runs the exact same parse -> project -> shape pipeline `ingestSession`
 * runs (server/ingest.ts steps 4-7, minus the reingest/preserve machinery
 * this test file has no use for), and writes the resulting rows into
 * `memDb` directly. Returns the `SessionDetail` from `buildTraceFromFile` so
 * callers can independently recompute `shapeTraceForResponse` for the
 * trace-reassembly comparison test.
 */
async function ingestFixture(
  db: Database,
  sessionId: string,
  workspaceId: string | number,
  jsonlPath: string,
  workspaceName: string
) {
  const projectId = basename(dirname(jsonlPath));
  const detail = await buildTraceFromFile(jsonlPath, projectId, sessionId);
  const lean = shapeTraceForResponse(detail);
  const { chunks: leanChunks, ...traceMeta } = lean;

  const parentRows = projectMessages(detail.messages, "parent");
  const subagentRows = detail.processes.flatMap((p) => projectMessages(p.messages, "subagent"));
  const sourcedRows = [
    ...parentRows.map((row) => ({ row, source: "parent" as const })),
    ...subagentRows.map((row) => ({ row, source: "subagent" as const })),
  ];

  const header = projectHeader(detail.messages);
  const title = pickTitle(parentRows.filter((r) => r.role === "user"));
  const userRowCount = sourcedRows.filter((r) => r.row.role === "user").length;
  const timestamps = parentRows
    .map((r) => r.timestamp)
    .filter((t): t is string => typeof t === "string" && t.length > 0);

  db.prepare(
    `INSERT INTO sessions (id, workspace_id, source_path, started_at, ended_at, git_branch, title, message_count, user_message_count, file_size, file_mtime, trace_meta, ingested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    sessionId,
    workspaceId,
    jsonlPath,
    timestamps[0] ?? null,
    timestamps[timestamps.length - 1] ?? null,
    header.branch || null,
    title,
    sourcedRows.length,
    userRowCount,
    null,
    null,
    JSON.stringify(traceMeta),
    new Date().toISOString()
  );

  const insertMessage = db.prepare(
    `INSERT INTO messages (session_id, role, content, timestamp, sequence, message_type, source, tool_use_id, tool_name, tool_input, record_uuid, title, workspace)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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

  const insertRawRecord = db.prepare(
    `INSERT INTO raw_records (session_id, uuid, seq, raw) VALUES (?, ?, ?, ?)`
  );
  let rawSeq = 0;
  for (const [uuid, raw] of detail.rawLinesByUuid) {
    insertRawRecord.run(sessionId, uuid, rawSeq++, raw);
  }

  const insertTraceChunk = db.prepare(
    `INSERT INTO trace_chunks (session_id, chunk_seq, chunk_type, started_at, ended_at, payload)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
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

  const fileReferences = extractFileReferences([
    ...detail.messages,
    ...detail.processes.flatMap((p) => p.messages),
  ]);
  const insertFile = db.prepare(
    `INSERT INTO session_files (session_id, file_path, file_name, operation, timestamp, sequence)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  for (const file of fileReferences) {
    insertFile.run(sessionId, file.filePath, file.fileName, file.operation, file.timestamp, file.sequence);
  }

  return detail;
}

// ── Fixture helpers ────────────────────────────────────────────────

const WORKSPACE_PATH = "/tmp/fixture-serving-project";
const WORKSPACE_DIR_NAME = "-tmp-fixture-serving-project";

/**
 * A small but non-trivial transcript: two user turns, one assistant turn
 * with a tool_use + a synthetic tool_result reply, so ingest produces more
 * than one trace chunk (user chunk, ai chunk) and at least one tool_use /
 * tool_result message row pair — enough surface for the pagination and
 * trace-reassembly tests without pulling in a huge real-world fixture.
 */
function transcript(sessionId: string): string {
  const lines: unknown[] = [];
  lines.push({
    type: "user",
    sessionId,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, 0)).toISOString(),
    cwd: WORKSPACE_PATH,
    gitBranch: "main",
    uuid: "u0",
    parentUuid: null,
    message: { role: "user", content: "First turn: look at the ingest pipeline" },
  });
  lines.push({
    type: "assistant",
    sessionId,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 1, 0)).toISOString(),
    uuid: "a0",
    parentUuid: "u0",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "Let me check the file." },
        {
          type: "tool_use",
          id: "toolu_1",
          name: "Read",
          input: { file_path: `${WORKSPACE_PATH}/ingest.ts` },
        },
      ],
    },
  });
  lines.push({
    type: "user",
    sessionId,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 2, 0)).toISOString(),
    uuid: "u1",
    parentUuid: "a0",
    toolUseResult: { stdout: "export const x = 1;\n" },
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_1", content: "export const x = 1;\n" },
      ],
    },
  });
  lines.push({
    type: "user",
    sessionId,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 3, 0)).toISOString(),
    cwd: WORKSPACE_PATH,
    gitBranch: "main",
    uuid: "u2",
    parentUuid: "u1",
    message: { role: "user", content: "Second turn: thanks, that's what I needed" },
  });
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

let fixtureDir: string;
let sessionId: string;
let jsonlPath: string;
let workspaceId: number;
let fixtureDetail: Awaited<ReturnType<typeof ingestFixture>>;

beforeEach(async () => {
  memDb.exec(`
    DELETE FROM session_tags;
    DELETE FROM session_files;
    DELETE FROM messages;
    DELETE FROM raw_records;
    DELETE FROM trace_chunks;
    DELETE FROM sessions;
    DELETE FROM tags;
    DELETE FROM workspaces;
  `);
  const info = memDb
    .prepare(`INSERT INTO workspaces (path, dir_name, display_name) VALUES (?, ?, ?)`)
    .run(WORKSPACE_PATH, WORKSPACE_DIR_NAME, "fixture-serving-project");
  workspaceId = Number(info.lastInsertRowid);

  fixtureDir = mkdtempSync(join(tmpdir(), "serving-test-fixture-"));
  sessionId = "11111111-2222-3333-4444-555555555555";
  jsonlPath = join(fixtureDir, `${sessionId}.jsonl`);
  writeFileSync(jsonlPath, transcript(sessionId));

  fixtureDetail = await ingestFixture(memDb, sessionId, workspaceId, jsonlPath, "fixture-serving-project");
});

// ── sessionExists ────────────────────────────────────────────────────

describe("sessionExists", () => {
  test("true for an ingested session", () => {
    expect(sessionExists(memDb, sessionId)).toBe(true);
  });

  test("false for an unknown session id", () => {
    expect(sessionExists(memDb, "no-such-session")).toBe(false);
  });
});

// ── windowedMessages ─────────────────────────────────────────────────

describe("windowedMessages", () => {
  test("returns rows ordered by timestamp ASC, sequence ASC with a total count", () => {
    const result = windowedMessages(memDb, sessionId, { limit: 50, offset: 0 });
    expect(result.total).toBeGreaterThan(0);
    expect(result.messages.length).toBe(result.total);
    // Chronological: first row is the first user turn, last row is the final one.
    expect(result.messages[0].content).toContain("First turn");
    expect(result.messages[result.messages.length - 1].content).toContain("Second turn");
    for (let i = 1; i < result.messages.length; i++) {
      const prev = result.messages[i - 1];
      const cur = result.messages[i];
      expect(new Date(cur.timestamp!).getTime()).toBeGreaterThanOrEqual(
        new Date(prev.timestamp!).getTime()
      );
    }
  });

  test("every row carries record_uuid and a truncated flag", () => {
    const result = windowedMessages(memDb, sessionId, { limit: 50, offset: 0 });
    for (const m of result.messages) {
      expect(m.record_uuid).not.toBeNull();
      expect(typeof m.truncated).toBe("boolean");
    }
    // None of this fixture's content exceeds the 4000-char projection cap.
    expect(result.messages.every((m) => m.truncated === false)).toBe(true);
  });

  test("paginated fetch covers every row exactly once across stable windows", () => {
    const full = windowedMessages(memDb, sessionId, { limit: 50, offset: 0 });
    const pageSize = 2;
    const seen: string[] = [];
    for (let offset = 0; offset < full.total; offset += pageSize) {
      const page = windowedMessages(memDb, sessionId, { limit: pageSize, offset });
      for (const m of page.messages) seen.push(`${m.sequence}`);
    }
    // Every DB row appears, none skipped, none duplicated (message_type
    // determines emptiness after cleanXmlNoise, but this fixture has no XML
    // noise so nothing gets filtered — every underlying row surfaces).
    const totalRowsInDb = (
      memDb.prepare(`SELECT COUNT(*) as n FROM messages WHERE session_id = ?`).get(sessionId) as {
        n: number;
      }
    ).n;
    expect(seen.length).toBe(totalRowsInDb);
    expect(new Set(seen).size).toBe(seen.length);
  });

  test("a window past the end returns an empty array, not an error", () => {
    const result = windowedMessages(memDb, sessionId, { limit: 10, offset: 10_000 });
    expect(result.messages).toEqual([]);
    expect(result.total).toBeGreaterThan(0);
  });

  test("cleanXmlNoise strips harness noise from a message's content", () => {
    expect(cleanXmlNoise("<system-reminder>internal</system-reminder>hello")).toBe("hello");
    expect(cleanXmlNoise("plain text")).toBe("plain text");
  });
});

// ── getRawRecord ─────────────────────────────────────────────────────

describe("getRawRecord", () => {
  test("returns the verbatim raw JSONL line for a known uuid", () => {
    const record = getRawRecord(memDb, sessionId, "u0");
    expect(record).not.toBeNull();
    const parsed = JSON.parse(record!.raw);
    expect(parsed.uuid).toBe("u0");
    expect(parsed.message.content).toBe("First turn: look at the ingest pipeline");
  });

  test("returns null for an unknown uuid", () => {
    expect(getRawRecord(memDb, sessionId, "no-such-uuid")).toBeNull();
  });

  test("returns null for an unknown session id even with a valid-looking uuid", () => {
    expect(getRawRecord(memDb, "no-such-session", "u0")).toBeNull();
  });
});

// ── reassembleTrace ──────────────────────────────────────────────────

describe("reassembleTrace", () => {
  test("matches shapeTraceForResponse(buildTraceFromFile(...)) for a freshly-ingested session", async () => {
    // Independently recompute from the SAME detail `ingestFixture` parsed
    // (fixtureDetail) rather than re-parsing the file again — two identical
    // parses of the same immutable fixture would trivially agree, but using
    // the shared detail is what makes this a check on `reassembleTrace`'s
    // reconstruction, not a check on parser determinism.
    const expected = shapeTraceForResponse(fixtureDetail);

    const result = reassembleTrace(memDb, sessionId);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    // Round-trip `expected` through JSON exactly like ingest -> DB -> route
    // does, so Date fields on both sides compare as the same ISO strings
    // rather than failing on Date-vs-string identity.
    const expectedOverWire = JSON.parse(JSON.stringify(expected));
    expect(result.trace).toEqual(expectedOverWire);
  });

  test("404-shape (no_trace) for a session that exists but was never ingested with the unified parser", () => {
    memDb.prepare(`UPDATE sessions SET trace_meta = NULL WHERE id = ?`).run(sessionId);
    memDb.prepare(`DELETE FROM trace_chunks WHERE session_id = ?`).run(sessionId);

    const result = reassembleTrace(memDb, sessionId);
    expect(result).toEqual({ ok: false, reason: "no_trace" });
  });

  test("not_found for an unknown session id", () => {
    const result = reassembleTrace(memDb, "no-such-session");
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });
});

// ── Search endpoint SQL: toFtsQuery x facet syntax, subagent_prompt filter ──
//
// server/index.ts's `/api/search` runs
// `messages_fts MATCH scopeFtsToContent(toFtsQuery(q))` through this exact
// prepared statement (D9's "existing statements keep working" guarantee —
// the SQL text itself is untouched; only the bound parameter value changes).
// The porter/facet FTS5 migration (D4/D5, covered at the schema level in
// db.test.ts) changed what messages_fts indexes; these tests confirm the
// SEARCH ENDPOINT's own query-building (`toFtsQuery` + `scopeFtsToContent`)
// and filtering (`m.message_type != 'subagent_prompt'`) still hold up
// against real ingested rows, specifically for facet-shaped input and for
// the title/workspace flood regression `scopeFtsToContent` exists to fix.
const SEARCH_SQL = `
  SELECT m.session_id, m.role, m.message_type, m.timestamp, m.sequence,
         snippet(messages_fts, 0, '<mark>', '</mark>', '...', 48) as snippet,
         s.title, s.started_at, s.git_branch,
         rank
  FROM messages_fts
  JOIN messages m ON m.id = messages_fts.rowid
  JOIN sessions s ON m.session_id = s.id
  WHERE messages_fts MATCH ? AND m.message_type != 'subagent_prompt'
  ORDER BY rank
  LIMIT 200
`;

describe("search endpoint FTS query (toFtsQuery x facet ':' syntax)", () => {
  test("a facet-shaped quick-search query ('workspace: terra') does not crash the search endpoint", () => {
    const ftsQuery = scopeFtsToContent(toFtsQuery("workspace: fixture-serving-project"));
    // Sanitized to a plain word search (colon stripped) — not a crash, and
    // not real column-scoped filtering either. See serving.ts's doc comment
    // on toFtsQuery for why that's the accepted, documented behavior.
    expect(toFtsQuery("workspace: fixture-serving-project")).not.toContain(":");
    expect(() => memDb.prepare(SEARCH_SQL).all(ftsQuery)).not.toThrow();
  });

  test("hasUnderscoreTerms flags underscore-joined queries (the LIKE-fallback trigger)", () => {
    expect(hasUnderscoreTerms("some_snake_case_term")).toBe(true);
    expect(hasUnderscoreTerms("plain words")).toBe(false);
  });

  test("subagent_prompt rows are excluded from search results", () => {
    // Manually insert a subagent_prompt row alongside the ingested fixture
    // rows — the ingest pipeline's subagent linking is exercised elsewhere
    // (server/trace/index.test.ts, server/ingest.test.ts); this test is
    // about the SEARCH SQL's filter, not about producing a subagent row via
    // a real subagent transcript.
    const maxSeq = (
      memDb
        .prepare(`SELECT MAX(sequence) as m FROM messages WHERE session_id = ?`)
        .get(sessionId) as { m: number }
    ).m;
    memDb
      .prepare(
        `INSERT INTO messages (session_id, role, content, timestamp, sequence, message_type, source, title, workspace)
         VALUES (?, 'user', 'search-canary-unique-token', '2026-01-01T00:04:00Z', ?, 'subagent_prompt', 'subagent', NULL, NULL)`
      )
      .run(sessionId, maxSeq + 1);

    const ftsQuery = scopeFtsToContent(toFtsQuery("search-canary-unique-token"));
    const rows = memDb.prepare(SEARCH_SQL).all(ftsQuery) as Array<{ message_type: string }>;
    expect(rows.length).toBe(0);
  });

  // ── Codex #4 regression: title/workspace denormalization floods search ──
  //
  // Reproduces the exact repro from the Codex finding this test was written
  // to catch: a session with many messages whose DENORMALIZED title matches
  // the query, plus a handful of genuine CONTENT matches in a different
  // session, both indexed by the same `messages_fts` table. An unscoped
  // `messages_fts MATCH ?` (searching content+title+workspace together)
  // returns the title-only hits first (or interleaved) and, once capped at
  // `LIMIT 200`, can push every genuine content match out of the result set
  // entirely. `scopeFtsToContent` must make every one of the real content
  // matches survive, and exclude every title-only row.
  test("scopeFtsToContent prevents title-denormalization from flooding out real content matches", () => {
    const floodedSessionId = "flood-session-title-match";
    memDb
      .prepare(
        `INSERT INTO sessions (id, workspace_id, source_path, started_at, ended_at, title, message_count, user_message_count, ingested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(floodedSessionId, workspaceId, "/tmp/flood.jsonl", "2026-02-01T00:00:00Z", "2026-02-01T00:10:00Z", "Parser migration", 400, 200, new Date().toISOString());

    const insertFloodMessage = memDb.prepare(
      `INSERT INTO messages (session_id, role, content, timestamp, sequence, message_type, source, title, workspace)
       VALUES (?, 'user', ?, ?, ?, 'text', 'parent', 'Parser migration', 'flood-workspace')`
    );
    for (let i = 0; i < 400; i++) {
      insertFloodMessage.run(
        floodedSessionId,
        `unrelated message body about something else entirely, number ${i}`,
        `2026-02-01T00:${String(i % 60).padStart(2, "0")}:00Z`,
        i
      );
    }

    const realMatchSessionIds: string[] = [];
    for (let i = 0; i < 10; i++) {
      const realSessionId = `real-match-session-${i}`;
      realMatchSessionIds.push(realSessionId);
      memDb
        .prepare(
          `INSERT INTO sessions (id, workspace_id, source_path, started_at, ended_at, title, message_count, user_message_count, ingested_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(realSessionId, workspaceId, "/tmp/real.jsonl", "2026-03-01T00:00:00Z", "2026-03-01T00:01:00Z", "Other session", 1, 1, new Date().toISOString());
      memDb
        .prepare(
          `INSERT INTO messages (session_id, role, content, timestamp, sequence, message_type, source, title, workspace)
           VALUES (?, 'user', ?, '2026-03-01T00:00:00Z', 0, 'text', 'parent', 'Other session', 'other-workspace')`
        )
        .run(realSessionId, `this message is genuinely about the parser rewrite, entry ${i}`);
    }

    const scopedQuery = scopeFtsToContent(toFtsQuery("parser"));
    const rows = memDb.prepare(SEARCH_SQL).all(scopedQuery) as Array<{ session_id: string }>;

    const hitSessionIds = new Set(rows.map((r) => r.session_id));
    for (const realSessionId of realMatchSessionIds) {
      expect(hitSessionIds.has(realSessionId)).toBe(true);
    }
    expect(hitSessionIds.has(floodedSessionId)).toBe(false);
  });
});
