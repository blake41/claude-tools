import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { applySchema, assertSqliteVersionSupported } from "./db-migrations.js";

/**
 * A fresh in-memory database with the full app schema applied — the same
 * entry point `server/db.ts` calls against the real file-backed DB. Tests use
 * `:memory:` so they never touch (or trigger a 1.4M-row FTS rebuild against)
 * the production `data/sessions.db`.
 */
function freshDb(): Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function columnsOf(db: Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name);
}

let nextSequence = 0;
function insertMessage(
  db: Database,
  fields: { sessionId: string; content: string; title?: string; workspace?: string }
): number {
  const info = db
    .prepare(
      `INSERT INTO messages (session_id, role, content, timestamp, sequence, title, workspace)
       VALUES (?, 'assistant', ?, '2026-08-10T00:00:00Z', ?, ?, ?)`
    )
    .run(
      fields.sessionId,
      fields.content,
      nextSequence++,
      fields.title ?? null,
      fields.workspace ?? null
    );
  return Number(info.lastInsertRowid);
}

describe("assertSqliteVersionSupported", () => {
  test("throws on 3.43.2 — the bundled-bun SQLite with the FTS5 external-content 'delete' corruption bug", () => {
    expect(() => assertSqliteVersionSupported("3.43.2")).toThrow(/oven-sh\/bun#31247/);
  });

  test("passes on 3.51.0", () => {
    expect(() => assertSqliteVersionSupported("3.51.0")).not.toThrow();
  });
});

describe("applySchema — raw_records (D2)", () => {
  test("creates raw_records keyed by (session_id, uuid) with a session index", () => {
    const db = freshDb();

    expect(columnsOf(db, "raw_records").sort()).toEqual(["raw", "seq", "session_id", "uuid"]);

    // One raw JSONL record per (session, uuid) — the dedup that keeps
    // block-level message rows from storing the same record 2-3 times.
    db.prepare(`INSERT INTO raw_records (session_id, uuid, seq, raw) VALUES (?, ?, ?, ?)`).run(
      "s1",
      "u1",
      0,
      '{"uuid":"u1"}'
    );
    expect(() =>
      db
        .prepare(`INSERT INTO raw_records (session_id, uuid, seq, raw) VALUES (?, ?, ?, ?)`)
        .run("s1", "u1", 1, '{"uuid":"u1"}')
    ).toThrow(/UNIQUE constraint failed/);

    const indexes = (
      db.prepare(`PRAGMA index_list(raw_records)`).all() as { name: string }[]
    ).map((r) => r.name);
    expect(indexes).toContain("idx_raw_records_session");

    db.close();
  });
});

describe("applySchema — additive columns", () => {
  test("messages gains record_uuid/title/workspace and sessions gains file_mtime/trace_meta", () => {
    const db = freshDb();

    const messageCols = columnsOf(db, "messages");
    expect(messageCols).toContain("record_uuid"); // join key into raw_records (D2)
    expect(messageCols).toContain("title"); // FTS facet column (D4)
    expect(messageCols).toContain("workspace"); // FTS facet column (D4)

    const sessionCols = columnsOf(db, "sessions");
    expect(sessionCols).toContain("file_mtime"); // mtime reingest trigger (D10)
    expect(sessionCols).toContain("trace_meta"); // LeanSessionDetail envelope (D3)

    // Pre-existing rows must survive the ALTERs with NULL in the new columns.
    db.prepare(
      `INSERT INTO messages (session_id, role, content, timestamp, sequence) VALUES (?, ?, ?, ?, ?)`
    ).run("s1", "user", "hello", "2026-08-10T00:00:00Z", 0);
    const row = db
      .prepare(`SELECT record_uuid, title, workspace FROM messages WHERE session_id = ?`)
      .get("s1") as { record_uuid: string | null; title: string | null; workspace: string | null };
    expect(row).toEqual({ record_uuid: null, title: null, workspace: null });

    db.close();
  });
});

describe("applySchema — trace_chunks (D3)", () => {
  test("creates trace_chunks keyed by (session_id, chunk_seq)", () => {
    const db = freshDb();

    expect(columnsOf(db, "trace_chunks").sort()).toEqual([
      "chunk_seq",
      "chunk_type",
      "ended_at",
      "payload",
      "session_id",
      "started_at",
    ]);

    const insert = db.prepare(
      `INSERT INTO trace_chunks (session_id, chunk_seq, chunk_type, started_at, ended_at, payload)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    // started_at/ended_at are nullable — a chunk can carry no timestamps.
    insert.run("s1", 0, "user-turn", null, null, '{"steps":[]}');
    expect(() => insert.run("s1", 0, "user-turn", null, null, '{"steps":[]}')).toThrow(
      /UNIQUE constraint failed/
    );

    // Rows are per-chunk (not one blob per session) so the trace endpoint can
    // window by chunk_seq later.
    insert.run("s1", 1, "assistant-turn", "2026-08-10T00:00:00Z", null, '{"steps":[]}');
    const rows = db
      .prepare(`SELECT chunk_seq FROM trace_chunks WHERE session_id = ? ORDER BY chunk_seq`)
      .all("s1") as { chunk_seq: number }[];
    expect(rows.map((r) => r.chunk_seq)).toEqual([0, 1]);

    db.close();
  });
});

describe("applySchema — messages_fts porter + facets (D4, D5)", () => {
  test("porter stemming: MATCH 'search' finds a message containing 'searching'", () => {
    const db = freshDb();
    insertMessage(db, { sessionId: "s1", content: "I am searching the corpus for a bug" });

    const hits = db
      .prepare(`SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?`)
      .all("search") as { rowid: number }[];

    expect(hits.length).toBe(1);
    db.close();
  });

  test("faceted MATCH 'workspace: <name>' filters to that workspace", () => {
    const db = freshDb();
    insertMessage(db, { sessionId: "s1", content: "deploy failed", workspace: "terra" });
    insertMessage(db, { sessionId: "s2", content: "deploy failed", workspace: "keystone" });

    const hits = db
      .prepare(
        `SELECT m.session_id FROM messages_fts f JOIN messages m ON m.id = f.rowid
         WHERE messages_fts MATCH ?`
      )
      .all("workspace: terra AND deploy") as { session_id: string }[];

    expect(hits.map((h) => h.session_id)).toEqual(["s1"]);
    db.close();
  });

  // CHARACTERIZATION (not a requirement — a documented consequence of D4).
  // Written after the migration, to pin behavior the serving layer must
  // decide about in U5, not to drive the implementation.
  test("an UNQUALIFIED MATCH now searches the facet columns too", () => {
    const db = freshDb();
    insertMessage(db, {
      sessionId: "s1",
      content: "nothing relevant here",
      workspace: "terra",
      title: "Deploy postmortem",
    });

    // server/index.ts's search runs `WHERE messages_fts MATCH ?` with the
    // user's raw query. Adding title/workspace as indexed columns widens
    // recall: a search for a workspace name now matches every message in that
    // workspace, and its snippet(…, 0, …) comes back unhighlighted. Harmless
    // today (both columns are NULL until ingest populates them), but U5 must
    // choose deliberately between this and scoping the query to `{content}:`.
    const hits = db
      .prepare(`SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?`)
      .all("terra") as unknown[];
    expect(hits.length).toBe(1);

    db.close();
  });

  test("snippet(messages_fts, 0, ...) still snippets CONTENT — column 0 is a contract", () => {
    // server/index.ts's search statements address the snippet column by index.
    // If the recreate ever puts title/workspace first, search results silently
    // become workspace names instead of message text.
    const db = freshDb();
    insertMessage(db, {
      sessionId: "s1",
      content: "the deploy pipeline exploded during the migration step",
      title: "Deploy postmortem",
      workspace: "terra",
    });

    const row = db
      .prepare(
        `SELECT snippet(messages_fts, 0, '[', ']', '...', 8) AS s
         FROM messages_fts WHERE messages_fts MATCH ?`
      )
      .get("exploded") as { s: string };

    expect(row.s).toContain("[exploded]");
    expect(row.s).toContain("pipeline");
    db.close();
  });

  test("external-content delete round trip works after the recreate", () => {
    // The bug class this guards: SQLite 3.43.2's FTS5 raises
    // SQLITE_CORRUPT_VTAB on the 'delete' special insert, and every reingest
    // deletes a session's rows. A broken delete trigger leaves orphan index
    // entries that keep matching after the row is gone.
    const db = freshDb();
    const id = insertMessage(db, {
      sessionId: "s1",
      content: "ephemeral needle",
      title: "throwaway",
      workspace: "wsdelete",
    });

    expect(
      (db.prepare(`SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?`).all("needle") as
        unknown[]).length
    ).toBe(1);

    db.prepare(`DELETE FROM messages WHERE id = ?`).run(id);

    expect(
      (db.prepare(`SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?`).all("needle") as
        unknown[]).length
    ).toBe(0);

    // The facet columns must be deleted too: a trigger that passes the right
    // content but the wrong title/workspace leaves those tokens orphaned, and
    // a faceted search keeps matching a row that no longer exists.
    expect(
      (
        db
          .prepare(`SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?`)
          .all("workspace: wsdelete") as unknown[]
      ).length
    ).toBe(0);
    expect(
      (
        db
          .prepare(`SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?`)
          .all("title: throwaway") as unknown[]
      ).length
    ).toBe(0);

    // An orphaned index entry shows up here even when MATCH happens to miss.
    expect(() =>
      db.exec(`INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')`)
    ).not.toThrow();
    db.close();
  });
});

describe("applySchema — idempotency", () => {
  test("applying the schema twice (a server restart) throws nothing and duplicates nothing", () => {
    const db = freshDb();

    expect(() => applySchema(db)).not.toThrow();

    // The FTS swap is one-time work behind runOnce — a second apply must not
    // drop and rebuild the index again (minutes of boot time in production).
    const settings = db.prepare(`SELECT COUNT(*) AS n FROM settings WHERE key = ?`).get(
      "fts_porter_facets_v1"
    ) as { n: number };
    expect(settings.n).toBe(1);

    const triggers = (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name`)
        .all() as { name: string }[]
    ).map((t) => t.name);
    expect(triggers).toEqual(["messages_fts_delete", "messages_fts_insert"]);

    // No duplicated columns from re-running the additive ALTERs.
    const messageCols = columnsOf(db, "messages");
    expect(new Set(messageCols).size).toBe(messageCols.length);

    // And the index still works end to end after the second apply.
    insertMessage(db, { sessionId: "s9", content: "still indexing after restart" });
    const hits = db
      .prepare(`SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?`)
      .all("index") as unknown[];
    expect(hits.length).toBe(1);

    db.close();
  });
});
