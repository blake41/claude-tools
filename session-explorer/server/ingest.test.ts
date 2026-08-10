// ── Characterization tests for ingestSession's preserve/restore contract ──
//
// These pin the behavior of `ingestSession` (server/ingest.ts) EXACTLY AS IT
// IS TODAY, before the unified-parser rewrite swaps `stripSession` for the
// vendored pipeline (plan U4). They are a safety net, not a specification of
// something new: every assertion here was written against, and passes on, the
// pre-rewrite implementation. After the rewrite the same assertions must still
// pass — that is the whole point.
//
// The preserve/restore block (ingest.ts:331-341 read, :479-508 restore) is the
// highest-risk regression surface in the migration:
//   * reingest deletes and reinserts the session row, so every LLM-derived
//     column is wiped and must be put back;
//   * `insights_extracted`/`events_extracted` come back unconditionally
//     (expensive Sonnet work);
//   * `summary`/`summary_short`/`summarized_message_count`/`summarized_at`
//     come back only when `isSummaryStale` says the summary still matches the
//     session — otherwise they stay NULL so the auto-summarize tick
//     (WHERE summary IS NULL) redoes them exactly once;
//   * a parse failure must leave every prior row untouched (parse-before-delete);
//   * `session_tags` is user data and is never deleted by ingest.
//
// Test-harness notes:
//   * `server/db.ts` is mocked to an in-memory database. Importing it for real
//     opens (and migrates) the 1.6 GB production `data/sessions.db` as a module
//     side effect — `bun test` must never do that. Same reason `db.test.ts`
//     calls `applySchema` against `:memory:` instead of importing `db.ts`.
//   * `server/archive.ts` is mocked because the real `archiveSession` gzips the
//     fixture into `data/archive/` on disk. Archiving is an outermost boundary
//     here, not part of the contract under test — but *that* it is called, and
//     called even when the parse then fails, IS part of the contract, so the
//     stub records its calls.
//   * `ingestSession` itself is module-private; `reingestSession` is the
//     exported wrapper that calls it with `forceReingest = true`, which is the
//     reingest path these tests are about. Nothing in ingest.ts is modified to
//     make it testable.

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { applySchema } from "./db-migrations.js";
import { STALE_DEBOUNCE_MS } from "./summary-staleness.js";
import { buildTraceFromFile, shapeTraceForResponse } from "./trace/index.js";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));

const memDb = new Database(":memory:");
applySchema(memDb);

const archiveCalls: Array<{ sessionId: string; sourcePath: string }> = [];

mock.module(join(SERVER_DIR, "db.ts"), () => ({ default: memDb, DB_PATH: ":memory:" }));

// Only `archiveSession` (the one that writes gzip files into `data/archive/`)
// is replaced — the rest of the module is re-exported for real. `mock.module`
// registrations are global to the whole `bun test` run, so a from-scratch stub
// object would also hand `archive.test.ts` a fake `shouldArchive` and break it.
//
// `archivePathFor` is redirected at a temp directory for the same reason: the
// archive is now a LOAD-BEARING parse fallback (plan R4), so the tests that
// cover it have to put a real `.jsonl.gz` where ingest will look — and that
// must not be the repo's own `data/archive/`.
const realArchive = await import("./archive.js");
const TEST_ARCHIVE_DIR = mkdtempSync(join(tmpdir(), "ingest-test-archive-"));
mock.module(join(SERVER_DIR, "archive.ts"), () => ({
  ...realArchive,
  ARCHIVE_DIR: TEST_ARCHIVE_DIR,
  archivePathFor: (id: string) => join(TEST_ARCHIVE_DIR, `${id}.jsonl.gz`),
  archiveSession: (sessionId: string, sourcePath: string) => {
    archiveCalls.push({ sessionId, sourcePath });
    return true;
  },
}));

// Imported after the mocks are registered so ingest.ts's module-level
// `db.prepare(...)` statements bind to the in-memory database.
const {
  reingestSession,
  ingestSession,
  runIngestion,
  getIngestHealth,
  getPendingCount,
  getPrunedSessionsForArchiveSweep,
  MAX_RECENT_FAILURES,
  __resetIngestHealthForTesting,
} = await import("./ingest.js");

// ── Fixture helpers ────────────────────────────────────────────────

const WORKSPACE_PATH = "/tmp/fixture-project";
const WORKSPACE_DIR_NAME = "-tmp-fixture-project";

/**
 * A transcript of `turnCount` chained user turns. Chained parentUuids matter:
 * `stripSession` runs `canonicalBranch` over the uuid DAG before assigning
 * sequences, so a flat unlinked list would exercise a different code path than
 * a real transcript.
 */
function transcript(sessionId: string, turnCount: number): string {
  const lines: unknown[] = [];
  let parentUuid: string | null = null;
  for (let i = 0; i < turnCount; i++) {
    const uuid = `u${i}`;
    lines.push({
      type: "user",
      sessionId,
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, i, 0)).toISOString(),
      cwd: WORKSPACE_PATH,
      gitBranch: "main",
      uuid,
      parentUuid,
      message: {
        role: "user",
        content: `Turn ${i}: check the ingest preserve and restore contract`,
      },
    });
    parentUuid = uuid;
  }
  // One assistant tool_use turn so `session_files` gets a row too — the
  // parse-failure test asserts on that table's row count as well.
  lines.push({
    type: "assistant",
    sessionId,
    timestamp: new Date(Date.UTC(2026, 0, 1, 1, 0, 0)).toISOString(),
    uuid: "a-final",
    parentUuid,
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_fixture_1",
          name: "Write",
          input: { file_path: `${WORKSPACE_PATH}/notes.ts`, content: "export const x = 1;\n" },
        },
      ],
    },
  });
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

/**
 * Message rows a `transcript(_, turns)` fixture produces today: one `text` row
 * per user turn, plus one `tool_use` row for the trailing assistant Write call
 * (`stripSession` emits tool_use blocks as their own block-level row with
 * content `'Write: <path>'`). Derived rather than hardcoded so the staleness
 * fixtures below say what they mean.
 */
function expectedRows(turns: number): number {
  return turns + 1;
}

let fixtureDir: string;
let sessionId: string;
let jsonlPath: string;
let workspaceId: number;

function writeTranscript(turnCount: number): void {
  writeFileSync(jsonlPath, transcript(sessionId, turnCount));
}

function sessionRow(): Record<string, unknown> {
  return memDb.prepare(`SELECT * FROM sessions WHERE id = ?`).get(sessionId) as Record<
    string,
    unknown
  >;
}

function count(sql: string): number {
  return (memDb.prepare(sql).get(sessionId) as { n: number }).n;
}

function messageCount(): number {
  return count(`SELECT COUNT(*) AS n FROM messages WHERE session_id = ?`);
}

function fileCount(): number {
  return count(`SELECT COUNT(*) AS n FROM session_files WHERE session_id = ?`);
}

/** Write the LLM-derived columns a real summarized/extracted session carries. */
function setDerived(fields: {
  summary: string;
  summaryShort: string;
  summarizedMessageCount: number;
  summarizedAt: string;
  insightsExtracted: number;
  eventsExtracted: number;
}): void {
  memDb
    .prepare(
      `UPDATE sessions
       SET summary = ?, summary_short = ?, summarized_message_count = ?, summarized_at = ?,
           insights_extracted = ?, events_extracted = ?
       WHERE id = ?`
    )
    .run(
      fields.summary,
      fields.summaryShort,
      fields.summarizedMessageCount,
      fields.summarizedAt,
      fields.insightsExtracted,
      fields.eventsExtracted,
      sessionId
    );
}

const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString();

beforeEach(() => {
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
    .run(WORKSPACE_PATH, WORKSPACE_DIR_NAME, "fixture-project");
  workspaceId = Number(info.lastInsertRowid);

  // The archive is a parse SOURCE now, so a leftover `.jsonl.gz` from an
  // earlier test would silently rescue a case that is supposed to have no
  // bytes to parse at all.
  rmSync(TEST_ARCHIVE_DIR, { recursive: true, force: true });
  mkdirSync(TEST_ARCHIVE_DIR, { recursive: true });

  fixtureDir = mkdtempSync(join(tmpdir(), "ingest-characterization-"));
  // The session id is derived from the filename by `basename(path, ".jsonl")`.
  sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  jsonlPath = join(fixtureDir, `${sessionId}.jsonl`);
  archiveCalls.length = 0;

  // `lastTickAt`/`recentFailures` (plan U6) are module-singleton state — the
  // whole point of a ring buffer is that it survives across ticks in
  // production, but that means it also survives across test cases sharing
  // this one module instance unless explicitly zeroed here.
  __resetIngestHealthForTesting();
});

// ── Baseline: what a first ingest produces ─────────────────────────

describe("ingestSession — baseline ingest (current behavior)", () => {
  test("inserts the session, its message rows, and its file references", async () => {
    writeTranscript(3);

    expect(await reingestSession(jsonlPath, workspaceId)).toBe(true);

    const row = sessionRow();
    expect(row.id).toBe(sessionId);
    expect(row.workspace_id).toBe(workspaceId);
    expect(row.source_path).toBe(jsonlPath);
    expect(row.git_branch).toBe("main");
    expect(messageCount()).toBe(expectedRows(3));
    expect(fileCount()).toBe(1);

    // Block-level rows with the existing message_type vocabulary — three user
    // `text` rows and one assistant `tool_use` row, all `source = 'parent'`.
    const rows = memDb
      .prepare(
        `SELECT role, message_type, source, content FROM messages WHERE session_id = ? ORDER BY sequence`
      )
      .all(sessionId) as Array<{ role: string; message_type: string; source: string; content: string }>;
    expect(rows.map((r) => `${r.role}/${r.message_type}/${r.source}`)).toEqual([
      "user/text/parent",
      "user/text/parent",
      "user/text/parent",
      "assistant/tool_use/parent",
    ]);
    expect(rows[3].content).toBe(`Write: ${WORKSPACE_PATH}/notes.ts`);

    // Fresh row: no LLM-derived data yet.
    expect(row.summary).toBeNull();
    expect(row.insights_extracted).toBe(0);
    expect(row.events_extracted).toBe(0);
  });

  test("reingest replaces message/file rows rather than appending duplicates", async () => {
    writeTranscript(3);
    await reingestSession(jsonlPath, workspaceId);
    expect(messageCount()).toBe(expectedRows(3));

    await reingestSession(jsonlPath, workspaceId);

    expect(messageCount()).toBe(expectedRows(3));
    expect(fileCount()).toBe(1);
    expect(count(`SELECT COUNT(*) AS n FROM sessions WHERE id = ?`)).toBe(1);
  });

  test("archives before parsing on every ingest", async () => {
    writeTranscript(2);
    await reingestSession(jsonlPath, workspaceId);

    expect(archiveCalls).toEqual([{ sessionId, sourcePath: jsonlPath }]);
  });
});

// ── insights_extracted / events_extracted: unconditional ───────────

describe("ingestSession — insights/events flags survive reingest unconditionally", () => {
  test("preserved when the summary is NOT stale", async () => {
    writeTranscript(3);
    await reingestSession(jsonlPath, workspaceId);
    setDerived({
      summary: "A long-form summary of the session.",
      summaryShort: "Short summary.",
      summarizedMessageCount: expectedRows(3), // == fresh count -> not stale
      summarizedAt: isoAgo(STALE_DEBOUNCE_MS * 10),
      insightsExtracted: 1,
      eventsExtracted: 1,
    });

    await reingestSession(jsonlPath, workspaceId);

    const row = sessionRow();
    expect(row.summary).not.toBeNull(); // confirms this really is the not-stale branch
    expect(row.insights_extracted).toBe(1);
    expect(row.events_extracted).toBe(1);
  });

  test("preserved even when the summary IS stale and gets dropped", async () => {
    // The two restores are independent: expensive Sonnet extraction is never
    // re-triggered by reingest, even in the branch that throws the summary away.
    writeTranscript(3);
    await reingestSession(jsonlPath, workspaceId);
    setDerived({
      summary: "A stale summary written when the session was shorter.",
      summaryShort: "Stale short summary.",
      summarizedMessageCount: 1, // < fresh count -> grown
      summarizedAt: isoAgo(STALE_DEBOUNCE_MS * 10), // debounce elapsed
      insightsExtracted: 1,
      eventsExtracted: 1,
    });

    writeTranscript(5); // session grew on disk
    await reingestSession(jsonlPath, workspaceId);

    const row = sessionRow();
    expect(row.summary).toBeNull();
    expect(row.insights_extracted).toBe(1);
    expect(row.events_extracted).toBe(1);
  });

  test("a session that was never extracted stays at 0 (no accidental promotion)", async () => {
    writeTranscript(3);
    await reingestSession(jsonlPath, workspaceId);

    await reingestSession(jsonlPath, workspaceId);

    const row = sessionRow();
    expect(row.insights_extracted).toBe(0);
    expect(row.events_extracted).toBe(0);
  });
});

// ── summary fields: restored only when isSummaryStale === false ────

describe("ingestSession — summary restore is gated on isSummaryStale", () => {
  test("isSummaryStale false (no growth): summary, summary_short, count and timestamp all come back", async () => {
    writeTranscript(3);
    await reingestSession(jsonlPath, workspaceId);
    const summarizedAt = isoAgo(STALE_DEBOUNCE_MS * 10);
    setDerived({
      summary: "Investigated the ingest preserve/restore contract end to end.",
      summaryShort: "Ingest contract investigation.",
      summarizedMessageCount: expectedRows(3), // freshMessageCount <= storedSummarizedCount
      summarizedAt,
      insightsExtracted: 0,
      eventsExtracted: 0,
    });

    await reingestSession(jsonlPath, workspaceId);

    const row = sessionRow();
    expect(row.summary).toBe("Investigated the ingest preserve/restore contract end to end.");
    expect(row.summary_short).toBe("Ingest contract investigation.");
    expect(row.summarized_message_count).toBe(expectedRows(3));
    expect(row.summarized_at).toBe(summarizedAt);
  });

  test("isSummaryStale false (grew, but inside the debounce window): summary still comes back", async () => {
    // Growth alone is not staleness — STALE_DEBOUNCE_MS must also have elapsed
    // since the summary was produced, or a busy session would re-summarize on
    // every ~30s tick.
    writeTranscript(3);
    await reingestSession(jsonlPath, workspaceId);
    setDerived({
      summary: "Summary produced moments ago.",
      summaryShort: "Fresh summary.",
      summarizedMessageCount: expectedRows(3),
      summarizedAt: new Date().toISOString(), // debounce has NOT elapsed
      insightsExtracted: 0,
      eventsExtracted: 0,
    });

    writeTranscript(5); // grew
    await reingestSession(jsonlPath, workspaceId);

    const row = sessionRow();
    expect(messageCount()).toBe(expectedRows(5)); // the session really did grow
    expect(row.summary).toBe("Summary produced moments ago.");
    expect(row.summary_short).toBe("Fresh summary.");
    expect(row.summarized_message_count).toBe(expectedRows(3));
  });

  test("isSummaryStale true (grew past the debounce window): all four summary columns stay NULL", async () => {
    writeTranscript(3);
    await reingestSession(jsonlPath, workspaceId);
    setDerived({
      summary: "Summary of a 3-turn session.",
      summaryShort: "Old short summary.",
      summarizedMessageCount: expectedRows(3),
      summarizedAt: isoAgo(STALE_DEBOUNCE_MS * 10),
      insightsExtracted: 0,
      eventsExtracted: 0,
    });

    writeTranscript(6); // freshMessageCount (7) > storedSummarizedCount (4)
    await reingestSession(jsonlPath, workspaceId);

    const row = sessionRow();
    expect(messageCount()).toBe(expectedRows(6));
    // Dropped, not restored — so the auto-summarize tick (WHERE summary IS NULL)
    // picks this session up exactly once.
    expect(row.summary).toBeNull();
    expect(row.summary_short).toBeNull();
    expect(row.summarized_message_count).toBeNull();
    expect(row.summarized_at).toBeNull();
  });

  test("summary_retry_count / summary_failed_at are deliberately NOT preserved", async () => {
    // Reingest is treated as a reasonable point to give a previously-stuck
    // summary a fresh attempt (see the comment above PreservedDerivedData).
    writeTranscript(3);
    await reingestSession(jsonlPath, workspaceId);
    memDb
      .prepare(`UPDATE sessions SET summary_retry_count = 4, summary_failed_at = ? WHERE id = ?`)
      .run(isoAgo(1000), sessionId);

    await reingestSession(jsonlPath, workspaceId);

    const row = sessionRow();
    expect(row.summary_retry_count).toBe(0);
    expect(row.summary_failed_at).toBeNull();
  });
});

// ── Parse failure: prior rows fully intact ─────────────────────────

describe("ingestSession — a parse failure leaves the previous rows fully intact", () => {
  test("unreadable transcript: row counts, summary fields and flags all unchanged", async () => {
    writeTranscript(3);
    await reingestSession(jsonlPath, workspaceId);
    const summarizedAt = isoAgo(STALE_DEBOUNCE_MS * 10);
    setDerived({
      summary: "Summary that must survive a failed reingest.",
      summaryShort: "Must survive.",
      summarizedMessageCount: expectedRows(3),
      summarizedAt,
      insightsExtracted: 1,
      eventsExtracted: 1,
    });

    const before = { messages: messageCount(), files: fileCount(), row: sessionRow() };
    expect(before.messages).toBe(expectedRows(3));
    expect(before.files).toBe(1);

    // Replace the transcript with a directory so readFileSync throws EISDIR
    // inside stripSession — the "Failed to strip" catch branch.
    rmSync(jsonlPath);
    mkdirSync(jsonlPath);

    expect(await reingestSession(jsonlPath, workspaceId)).toBe(false);

    const after = sessionRow();
    expect(messageCount()).toBe(before.messages);
    expect(fileCount()).toBe(before.files);
    expect(after.summary).toBe("Summary that must survive a failed reingest.");
    expect(after.summary_short).toBe("Must survive.");
    expect(after.summarized_message_count).toBe(expectedRows(3));
    expect(after.summarized_at).toBe(summarizedAt);
    expect(after.insights_extracted).toBe(1);
    expect(after.events_extracted).toBe(1);
    expect(after.ingested_at).toBe(before.row.ingested_at);
    expect(after.message_count).toBe(before.row.message_count);

    // The archive still ran — the gzip copy is independent of parseability, and
    // U4 makes that archive the parse fallback for pruned sessions.
    expect(archiveCalls).toHaveLength(2);
  });

  test("transcript that yields zero messages: prior rows survive that branch too", async () => {
    writeTranscript(3);
    await reingestSession(jsonlPath, workspaceId);
    setDerived({
      summary: "Summary that must survive an empty reparse.",
      summaryShort: "Must survive.",
      summarizedMessageCount: expectedRows(3),
      summarizedAt: isoAgo(STALE_DEBOUNCE_MS * 10),
      insightsExtracted: 1,
      eventsExtracted: 1,
    });

    // Parseable file, but nothing stripSession recognizes as a message.
    writeFileSync(jsonlPath, "not json at all\n{ still not a record }\n");

    expect(await reingestSession(jsonlPath, workspaceId)).toBe(false);

    expect(messageCount()).toBe(expectedRows(3));
    expect(fileCount()).toBe(1);
    const after = sessionRow();
    expect(after.summary).toBe("Summary that must survive an empty reparse.");
    expect(after.insights_extracted).toBe(1);
    expect(after.events_extracted).toBe(1);
  });
});

// ── Tags: user data, never touched by ingest ───────────────────────

describe("ingestSession — session_tags survive reingest", () => {
  test("tag links persist across a reingest that deletes and reinserts the session row", async () => {
    writeTranscript(3);
    await reingestSession(jsonlPath, workspaceId);

    const tagId = Number(
      memDb
        .prepare(`INSERT INTO tags (name, color, created_at) VALUES (?, ?, ?)`)
        .run("architecture", "#58a6ff", new Date().toISOString()).lastInsertRowid
    );
    memDb
      .prepare(`INSERT INTO session_tags (session_id, tag_id, added_at) VALUES (?, ?, ?)`)
      .run(sessionId, tagId, new Date().toISOString());

    writeTranscript(5);
    await reingestSession(jsonlPath, workspaceId);

    const tags = memDb
      .prepare(
        `SELECT t.name FROM session_tags st JOIN tags t ON t.id = st.tag_id WHERE st.session_id = ?`
      )
      .all(sessionId) as Array<{ name: string }>;
    expect(tags).toEqual([{ name: "architecture" }]);
  });

  test("tags survive a FAILED reingest as well", async () => {
    writeTranscript(3);
    await reingestSession(jsonlPath, workspaceId);
    const tagId = Number(
      memDb
        .prepare(`INSERT INTO tags (name, color, created_at) VALUES (?, ?, ?)`)
        .run("keep-me", "#58a6ff", new Date().toISOString()).lastInsertRowid
    );
    memDb
      .prepare(`INSERT INTO session_tags (session_id, tag_id, added_at) VALUES (?, ?, ?)`)
      .run(sessionId, tagId, new Date().toISOString());

    rmSync(jsonlPath);
    mkdirSync(jsonlPath);
    expect(await reingestSession(jsonlPath, workspaceId)).toBe(false);

    expect(count(`SELECT COUNT(*) AS n FROM session_tags WHERE session_id = ?`)).toBe(1);
  });
});

// ── Reingest trigger: size OR mtime (D10) ──────────────────────────
//
// The trigger used to be file-size-only (ingest.ts:284-295), so an in-place
// rewrite that happened to land on the same byte count was never re-ingested.
// These exercise the NON-force path (`forceReingest = false`), which is why
// they call `ingestSession` directly rather than the `reingestSession`
// wrapper every test above uses.

describe("ingestSession — reingest trigger fires on size OR mtime change", () => {
  test("an unchanged file (same size, same mtime) is skipped", async () => {
    writeTranscript(3);
    expect(await ingestSession(jsonlPath, workspaceId, false)).toBe(true);

    expect(await ingestSession(jsonlPath, workspaceId, false)).toBe(false);
  });

  test("file_mtime is recorded on insert so the mtime half of the trigger has a baseline", async () => {
    writeTranscript(3);
    await ingestSession(jsonlPath, workspaceId, false);

    expect(sessionRow().file_mtime).toBe(Math.round(statSync(jsonlPath).mtimeMs));
  });

  test("an mtime-only change (byte-identical rewrite) triggers a reingest", async () => {
    writeTranscript(3);
    expect(await ingestSession(jsonlPath, workspaceId, false)).toBe(true);
    const sizeBefore = statSync(jsonlPath).size;

    // Byte-identical content, newer mtime — exactly the in-place-compaction
    // case the size-only trigger silently ignored.
    writeTranscript(3);
    const future = new Date(Date.now() + 60_000);
    utimesSync(jsonlPath, future, future);
    expect(statSync(jsonlPath).size).toBe(sizeBefore);

    expect(await ingestSession(jsonlPath, workspaceId, false)).toBe(true);
  });
});

// ── Unified-parser ingest (plan U4) ────────────────────────────────
//
// Everything below is NEW behavior, not characterization: it pins what the
// vendored-pipeline ingest must write that the strip.ts ingest never did —
// raw_records, trace_chunks + trace_meta, FTS facet columns, record_uuid, and
// subagent rows sourced from the resolver instead of a second parser pass.
//
// The fixtures here need a real `~/.claude/projects`-SHAPED tree
// (`<projects>/<projectId>/<sessionId>.jsonl` plus
// `<projects>/<projectId>/<sessionId>/subagents/agent-*.jsonl`) because the
// vendored SubagentResolver locates subagent files by that layout. Nothing is
// written under the real `~/.claude`.

const L = (record: unknown) => JSON.stringify(record);

/**
 * Parent transcript that delegates to one subagent: a user turn, an assistant
 * turn carrying text + a `Task` tool_use, and the tool_result turn that closes
 * it. Enough for a `user` chunk followed by an `ai` chunk with a linked
 * process.
 */
function parentTranscript(id: string): string {
  return (
    [
      L({
        type: "user",
        sessionId: id,
        timestamp: "2026-02-01T00:00:00.000Z",
        cwd: WORKSPACE_PATH,
        gitBranch: "main",
        uuid: "p0",
        parentUuid: null,
        message: { role: "user", content: "Investigate the unified parser swap" },
      }),
      L({
        type: "assistant",
        sessionId: id,
        timestamp: "2026-02-01T00:00:10.000Z",
        uuid: "p1",
        parentUuid: "p0",
        message: {
          role: "assistant",
          model: "claude-opus-4",
          content: [
            { type: "text", text: "Delegating the exploration." },
            {
              type: "tool_use",
              id: "toolu_task_1",
              name: "Task",
              input: { description: "explore parser", prompt: "look at the parser", subagent_type: "Explore" },
            },
          ],
        },
      }),
      L({
        type: "user",
        sessionId: id,
        timestamp: "2026-02-01T00:01:00.000Z",
        uuid: "p2",
        parentUuid: "p1",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_task_1", content: "Found the parser at server/trace" }],
        },
      }),
    ].join("\n") + "\n"
  );
}

/**
 * A subagent transcript. EVERY record carries `isSidechain: true`, which is
 * how Claude Code really writes these files — the regression this guards is
 * ChunkBuilder dropping all of them and rendering a zero-step subagent.
 */
function subagentTranscript(agentId: string): string {
  return (
    [
      L({
        type: "user",
        sessionId: agentId,
        isSidechain: true,
        timestamp: "2026-02-01T00:00:11.000Z",
        cwd: WORKSPACE_PATH,
        uuid: "s0",
        parentUuid: null,
        message: { role: "user", content: "look at the parser" },
      }),
      L({
        type: "assistant",
        sessionId: agentId,
        isSidechain: true,
        timestamp: "2026-02-01T00:00:20.000Z",
        uuid: "s1",
        parentUuid: "s0",
        message: {
          role: "assistant",
          model: "claude-sonnet-4",
          content: [
            { type: "text", text: "Reading the vendored parser." },
            { type: "tool_use", id: "toolu_sub_read", name: "Read", input: { file_path: "/repo/server/trace/index.ts" } },
          ],
        },
      }),
      L({
        type: "user",
        sessionId: agentId,
        isSidechain: true,
        timestamp: "2026-02-01T00:00:30.000Z",
        uuid: "s2",
        parentUuid: "s1",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_sub_read", content: "export function buildTrace() {}" }],
        },
      }),
    ].join("\n") + "\n"
  );
}

const AGENT_ID = "aa11bb22";
const TREE_SESSION_ID = "11111111-2222-3333-4444-555555555555";

/**
 * Build the projects-shaped fixture tree and point the module-level
 * `sessionId`/`jsonlPath` (which `sessionRow()`/`count()` read) at it.
 * `withSubagents: false` covers the parent-only case.
 */
function useProjectTree(opts: { subagents?: boolean; brokenSubagent?: boolean } = {}): void {
  sessionId = TREE_SESSION_ID;
  const projectsDir = join(fixtureDir, "projects");
  const projectDir = join(projectsDir, WORKSPACE_DIR_NAME);
  mkdirSync(projectDir, { recursive: true });
  jsonlPath = join(projectDir, `${sessionId}.jsonl`);
  writeFileSync(jsonlPath, parentTranscript(sessionId));

  if (opts.subagents ?? true) {
    const subagentDir = join(projectDir, sessionId, "subagents");
    mkdirSync(subagentDir, { recursive: true });
    writeFileSync(join(subagentDir, `agent-${AGENT_ID}.jsonl`), subagentTranscript(AGENT_ID));
    if (opts.brokenSubagent) {
      writeFileSync(join(subagentDir, "agent-broken99.jsonl"), "{ not json at all\n");
    }
  }
}

function messageRows(): Array<Record<string, unknown>> {
  return memDb
    .prepare(`SELECT * FROM messages WHERE session_id = ? ORDER BY sequence`)
    .all(sessionId) as Array<Record<string, unknown>>;
}

describe("ingestSession — unified-parser rows", () => {
  test("writes block-level message rows carrying record_uuid and the FTS facet columns", async () => {
    useProjectTree({ subagents: false });

    expect(await ingestSession(jsonlPath, workspaceId, true)).toBe(true);

    const rows = messageRows();
    expect(rows.map((r) => `${r.role}/${r.message_type}/${r.source}`)).toEqual([
      "user/text/parent",
      "assistant/text/parent",
      "assistant/tool_use/parent",
      "user/tool_result/parent",
    ]);
    // Full fidelity: the 26-char assistant text strip.ts's >100-char floor
    // deleted is a row now.
    expect(rows[1].content).toBe("Delegating the exploration.");
    // tool_result bodies used to be truncated to 500 chars at ingest; the body
    // is stored as projected now.
    expect(rows[3].content).toBe("Found the parser at server/trace");
    expect(rows.map((r) => r.record_uuid)).toEqual(["p0", "p1", "p1", "p2"]);
    // D4 facets — denormalized onto every row so external-content FTS5 can
    // filter by them.
    expect(new Set(rows.map((r) => r.title))).toEqual(
      new Set(["Investigate the unified parser swap"])
    );
    expect(new Set(rows.map((r) => r.workspace))).toEqual(new Set(["fixture-project"]));
    expect(rows[2].tool_name).toBe("Task");
    expect(rows[2].tool_use_id).toBe("toolu_task_1");
    expect(rows[3].tool_use_id).toBe("toolu_task_1");
  });

  test("stores every parsed JSONL record verbatim in raw_records, keyed by uuid", async () => {
    useProjectTree({ subagents: false });

    await ingestSession(jsonlPath, workspaceId, true);

    const raw = memDb
      .prepare(`SELECT uuid, seq, raw FROM raw_records WHERE session_id = ? ORDER BY seq`)
      .all(sessionId) as Array<{ uuid: string; seq: number; raw: string }>;
    expect(raw.map((r) => r.uuid)).toEqual(["p0", "p1", "p2"]);
    expect(raw.map((r) => r.seq)).toEqual([0, 1, 2]);
    // Verbatim: byte-for-byte the original line, not a re-serialization.
    const originalLines = parentTranscript(sessionId).split("\n").filter(Boolean);
    expect(raw.map((r) => r.raw)).toEqual(originalLines);
  });

  test("materializes one trace_chunks row per lean chunk plus the trace_meta envelope", async () => {
    useProjectTree({ subagents: false });

    await ingestSession(jsonlPath, workspaceId, true);

    const expected = shapeTraceForResponse(
      await buildTraceFromFile(jsonlPath, WORKSPACE_DIR_NAME, sessionId)
    );
    const chunks = memDb
      .prepare(
        `SELECT chunk_seq, chunk_type, started_at, ended_at, payload FROM trace_chunks WHERE session_id = ? ORDER BY chunk_seq`
      )
      .all(sessionId) as Array<{
      chunk_seq: number;
      chunk_type: string;
      started_at: string;
      ended_at: string;
      payload: string;
    }>;

    expect(chunks.map((c) => c.chunk_seq)).toEqual([0, 1]);
    expect(chunks.map((c) => c.chunk_type)).toEqual(["user", "ai"]);
    expect(chunks[0].started_at).toBe("2026-02-01T00:00:00.000Z");
    // Payload is the LeanChunk exactly as the trace endpoint serializes it, so
    // U5 can hand rows straight back to TraceView without reshaping.
    expect(chunks.map((c) => JSON.parse(c.payload))).toEqual(
      JSON.parse(JSON.stringify(expected.chunks))
    );

    // The LeanSessionDetail envelope minus `chunks`. `fingerprint` is optional
    // on the lean model and JSON.stringify drops it when undefined — exactly
    // what today's trace response does, so the stored envelope matches the
    // wire shape rather than adding a key the UI never saw.
    const meta = JSON.parse(sessionRow().trace_meta as string);
    expect(Object.keys(meta).sort()).toEqual(
      ["metrics", "models", "session", "subagentCount", "unattachedSubagents"].sort()
    );
    expect(meta).toEqual(JSON.parse(JSON.stringify({ ...expected, chunks: undefined })));
    expect(meta.models).toEqual(["claude-opus-4"]);
    expect(meta.subagentCount).toBe(0);
  });

  test("extracts session_files and lands the right counts on the session row", async () => {
    useProjectTree({ subagents: true });

    await ingestSession(jsonlPath, workspaceId, true);

    const files = memDb
      .prepare(`SELECT file_path, operation FROM session_files WHERE session_id = ? ORDER BY sequence`)
      .all(sessionId) as Array<{ file_path: string; operation: string }>;
    // The Read comes from the SUBAGENT's messages — proof file extraction runs
    // over the resolver output too.
    expect(files).toEqual([{ file_path: "/repo/server/trace/index.ts", operation: "read" }]);

    const row = sessionRow();
    expect(row.message_count).toBe(messageCount());
    expect(row.user_message_count).toBe(
      count(`SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND role = 'user'`)
    );
    expect(row.git_branch).toBe("main");
    expect(row.started_at).toBe("2026-02-01T00:00:00.000Z");
  });
});

describe("ingestSession — subagents come from the resolver, not a second parse", () => {
  test("merges subagent rows with source='subagent' and subagent_prompt for user text", async () => {
    useProjectTree({ subagents: true });

    expect(await ingestSession(jsonlPath, workspaceId, true)).toBe(true);

    const rows = messageRows();
    expect(rows.map((r) => `${r.role}/${r.message_type}/${r.source}`)).toEqual([
      "user/text/parent",
      "assistant/text/parent",
      "assistant/tool_use/parent",
      "user/tool_result/parent",
      // Subagent user text is an agent-to-agent prompt, never a human turn.
      "user/subagent_prompt/subagent",
      "assistant/text/subagent",
      "assistant/tool_use/subagent",
      "user/tool_result/subagent",
    ]);
    // Sequences are unique and monotonic across the parent/subagent boundary.
    expect(rows.map((r) => r.sequence)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    // Subagent records are in raw_records too (the resolver's files are read
    // for their raw lines alongside the parent's).
    const rawUuids = (
      memDb
        .prepare(`SELECT uuid FROM raw_records WHERE session_id = ? ORDER BY seq`)
        .all(sessionId) as Array<{ uuid: string }>
    ).map((r) => r.uuid);
    expect(rawUuids).toEqual(["p0", "p1", "p2", "s0", "s1", "s2"]);
  });

  test("a subagent whose every record is isSidechain still yields non-zero trace steps", async () => {
    useProjectTree({ subagents: true });

    await ingestSession(jsonlPath, workspaceId, true);

    const payloads = (
      memDb
        .prepare(`SELECT payload FROM trace_chunks WHERE session_id = ? ORDER BY chunk_seq`)
        .all(sessionId) as Array<{ payload: string }>
    ).map((r) => JSON.parse(r.payload) as { chunkType: string; subagents?: Array<{ steps: unknown[] }> });

    const subagentStepCounts = payloads
      .filter((p) => p.chunkType === "ai")
      .flatMap((p) => (p.subagents ?? []).map((s) => s.steps.length));
    expect(subagentStepCounts).toHaveLength(1);
    expect(subagentStepCounts[0]).toBeGreaterThan(0);
  });

  test("a malformed subagent file is skipped without failing the parent", async () => {
    useProjectTree({ subagents: true, brokenSubagent: true });

    expect(await ingestSession(jsonlPath, workspaceId, true)).toBe(true);

    // Parent rows AND the good subagent's rows both survive; the broken file
    // contributes nothing.
    expect(messageCount()).toBe(8);
    expect(
      count(`SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND source = 'subagent'`)
    ).toBe(4);
  });
});

describe("ingestSession — the gzip archive is a load-bearing parse source", () => {
  test("ingests from data/archive/<id>.jsonl.gz when the original file is gone", async () => {
    useProjectTree({ subagents: false });
    const originalBytes = readFileSync(jsonlPath);
    writeFileSync(realArchive.archivePathFor(sessionId), Bun.gzipSync(originalBytes));
    rmSync(jsonlPath);

    expect(await ingestSession(jsonlPath, workspaceId, true)).toBe(true);

    // Same projection as the on-disk parse produced.
    expect(messageRows().map((r) => `${r.role}/${r.message_type}`)).toEqual([
      "user/text",
      "assistant/text",
      "assistant/tool_use",
      "user/tool_result",
    ]);
    // source_path stays the canonical location even though the bytes came
    // from the archive — the file may come back, and the stale-sweep keys off it.
    expect(sessionRow().source_path).toBe(jsonlPath);
    // No file to stat: size/mtime are unknown rather than wrong.
    expect(sessionRow().file_size).toBeNull();
    expect(sessionRow().file_mtime).toBeNull();
  });

  test("no original and no archive: the session is skipped, prior rows kept", async () => {
    useProjectTree({ subagents: false });
    await ingestSession(jsonlPath, workspaceId, true);
    const before = messageCount();
    rmSync(jsonlPath);

    expect(await ingestSession(jsonlPath, workspaceId, true)).toBe(false);

    expect(messageCount()).toBe(before);
  });
});

// ── Ingest health (plan U6): truthful lastTickAt / pendingCount / recentFailures ──

describe("getIngestHealth — before any tick has run", () => {
  test("returns nulls/zeros rather than throwing", () => {
    expect(() => getIngestHealth()).not.toThrow();
    const health = getIngestHealth();
    expect(health.lastTickAt).toBeNull();
    expect(health.pendingCount).toBe(0);
    expect(health.recentFailures).toEqual([]);
  });
});

describe("ingestSession — recentFailures capture real failures, not routine skips", () => {
  test("a session that fails parse appears in recentFailures with its error", async () => {
    writeTranscript(3);
    await reingestSession(jsonlPath, workspaceId);
    expect(getIngestHealth().recentFailures).toEqual([]);

    // Same "replace file with a directory" trick the parse-failure
    // characterization test above uses to force the catch branch.
    rmSync(jsonlPath);
    mkdirSync(jsonlPath);
    expect(await reingestSession(jsonlPath, workspaceId)).toBe(false);

    const { recentFailures } = getIngestHealth();
    expect(recentFailures).toHaveLength(1);
    expect(recentFailures[0].sessionId).toBe(sessionId);
    expect(recentFailures[0].message).toContain("Failed to parse");
    expect(() => new Date(recentFailures[0].timestamp).toISOString()).not.toThrow();
  });

  test("no transcript and no archive also records a failure", async () => {
    writeTranscript(3);
    await reingestSession(jsonlPath, workspaceId);
    rmSync(jsonlPath);

    expect(await reingestSession(jsonlPath, workspaceId)).toBe(false);

    const { recentFailures } = getIngestHealth();
    expect(recentFailures).toHaveLength(1);
    expect(recentFailures[0].sessionId).toBe(sessionId);
  });

  test("an unchanged file (routine no-op skip) is NOT recorded as a failure", async () => {
    writeTranscript(3);
    expect(await ingestSession(jsonlPath, workspaceId, false)).toBe(true);

    expect(await ingestSession(jsonlPath, workspaceId, false)).toBe(false);

    expect(getIngestHealth().recentFailures).toEqual([]);
  });

  test(`ring buffer caps at ${20} entries and evicts the oldest first`, async () => {
    const total = MAX_RECENT_FAILURES + 5;
    for (let i = 0; i < total; i++) {
      const fakeId = `fake-${i}`;
      const fakePath = join(fixtureDir, `${fakeId}.jsonl`);
      // Neither a transcript nor an archive exists at this path — every call
      // hits the "no transcript or archive" skip branch.
      expect(await ingestSession(fakePath, workspaceId, false)).toBe(false);
    }

    const { recentFailures } = getIngestHealth();
    expect(recentFailures).toHaveLength(MAX_RECENT_FAILURES);
    // Oldest 5 (fake-0..fake-4) evicted; newest MAX_RECENT_FAILURES survive,
    // oldest-first order preserved.
    expect(recentFailures.map((f) => f.sessionId)).toEqual(
      Array.from({ length: MAX_RECENT_FAILURES }, (_, i) => `fake-${i + 5}`)
    );
  });
});

describe("getPendingCount — shares the size+mtime predicate with the reingest trigger", () => {
  test("0 once a session is freshly ingested (nothing pending)", async () => {
    writeTranscript(3);
    await reingestSession(jsonlPath, workspaceId);

    expect(getPendingCount()).toBe(0);
  });

  test("reflects an mtime-only stale session (byte-identical rewrite, newer mtime)", async () => {
    writeTranscript(3);
    await reingestSession(jsonlPath, workspaceId);
    expect(getPendingCount()).toBe(0);
    const sizeBefore = statSync(jsonlPath).size;

    writeTranscript(3); // byte-identical content
    const future = new Date(Date.now() + 60_000);
    utimesSync(jsonlPath, future, future);
    expect(statSync(jsonlPath).size).toBe(sizeBefore);

    expect(getPendingCount()).toBe(1);
  });

  test("a session whose file is gone (archived, no longer on disk) is not counted as pending", async () => {
    writeTranscript(3);
    await reingestSession(jsonlPath, workspaceId);
    rmSync(jsonlPath);

    expect(getPendingCount()).toBe(0);
  });
});

// ── Force-mode archive sweep (plan U8, D13) ─────────────────────────
//
// `runIngestion`'s disk walk only ever visits files that still exist under
// the fixture's `projects/` tree — once a session's file is gone, the walk
// can never see it again. The sweep below is the second pass that finds it
// through the DB instead and hands it back into `ingestSession`, which
// already knows how to fall back to the archive (covered above by "the
// gzip archive is a load-bearing parse source"). These tests were written
// after the implementation (the enumeration query and the `runIngestion`
// wiring), not before — they pin the behavior down, they didn't drive it.

describe("getPrunedSessionsForArchiveSweep — plan U8, D13", () => {
  test("finds a session whose source file no longer exists on disk", async () => {
    writeTranscript(3);
    await reingestSession(jsonlPath, workspaceId);
    rmSync(jsonlPath);

    expect(getPrunedSessionsForArchiveSweep()).toEqual([
      { sessionId, sourcePath: jsonlPath, workspaceId },
    ]);
  });

  test("excludes a session whose source file still exists", async () => {
    writeTranscript(3);
    await reingestSession(jsonlPath, workspaceId);

    expect(getPrunedSessionsForArchiveSweep()).toEqual([]);
  });

  test("includes a pruned session even when it has no archive either", async () => {
    // D13: "sessions with neither file nor archive keep their old lossy
    // rows" is `ingestSession`'s job to decide, not this enumeration's — the
    // sweep must still surface the session so `runIngestion` can hand it off
    // and let `ingestSession` log/count the skip.
    writeTranscript(3);
    await reingestSession(jsonlPath, workspaceId);
    rmSync(jsonlPath);

    expect(getPrunedSessionsForArchiveSweep()).toHaveLength(1);
  });
});

describe("runIngestion({ force: true }) — archive sweep integration (plan U8, D13)", () => {
  test("reingests an archive-only session the disk walk can never see", async () => {
    useProjectTree({ subagents: false });
    const projectsDir = dirname(dirname(jsonlPath)); // .../projects
    await ingestSession(jsonlPath, workspaceId, true);
    const originalBytes = readFileSync(jsonlPath);
    writeFileSync(realArchive.archivePathFor(sessionId), Bun.gzipSync(originalBytes));
    rmSync(jsonlPath); // pruned by Claude Code — invisible to the disk walk from here on

    const before = messageCount();
    const result = await runIngestion({ projectsDir, force: true });

    expect(result.ingested).toBeGreaterThanOrEqual(1);
    expect(messageCount()).toBe(before); // same content, reingested from the archive
    expect(sessionRow().source_path).toBe(jsonlPath);
    expect(sessionRow().file_size).toBeNull();
  });

  test("a session with neither the file nor an archive keeps its old rows untouched", async () => {
    useProjectTree({ subagents: false });
    const projectsDir = dirname(dirname(jsonlPath));
    await ingestSession(jsonlPath, workspaceId, true);
    const before = messageCount();
    rmSync(jsonlPath); // no archive was ever written for this session

    const result = await runIngestion({ projectsDir, force: true });

    expect(messageCount()).toBe(before);
    expect(result.skipped).toBeGreaterThanOrEqual(1);
  });
});

describe("runIngestion — lastTickAt (plan U6)", () => {
  test("a successful tick sets lastTickAt and leaves recentFailures empty", async () => {
    expect(getIngestHealth().lastTickAt).toBeNull();

    // Point runIngestion at a synthetic projects-shaped tree instead of the
    // real ~/.claude/projects — a unit test must not touch (or depend on the
    // contents of) whatever real transcripts happen to exist on the machine
    // running it.
    useProjectTree({ subagents: false });
    const projectsDir = dirname(dirname(jsonlPath)); // .../projects
    const before = Date.now();

    const result = await runIngestion({ projectsDir });

    expect(result.running).toBe(false);
    const health = getIngestHealth();
    expect(health.lastTickAt).not.toBeNull();
    expect(new Date(health.lastTickAt as string).getTime()).toBeGreaterThanOrEqual(before);
    expect(health.recentFailures).toEqual([]);
  });
});
