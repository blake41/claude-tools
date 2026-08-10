import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { runOnce } from "./db-migrations.js";

function makeDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
  return db;
}

describe("runOnce", () => {
  test("runs fn the first time and records completion", () => {
    const db = makeDb();
    let calls = 0;

    const ran = runOnce(db, "fts_rebuild_v1", () => {
      calls++;
    });

    expect(ran).toBe(true);
    expect(calls).toBe(1);
    const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get("fts_rebuild_v1");
    expect(row).toBeTruthy();

    db.close();
  });

  test("does not run fn again on a subsequent call with the same key", () => {
    const db = makeDb();
    let calls = 0;

    runOnce(db, "fts_rebuild_v1", () => {
      calls++;
    });
    const ranAgain = runOnce(db, "fts_rebuild_v1", () => {
      calls++;
    });

    expect(ranAgain).toBe(false);
    expect(calls).toBe(1);

    db.close();
  });

  test("this is the regression case: a full-table rebuild must not repeat on every boot", () => {
    // Simulates three server restarts against the same persisted DB. Before
    // this fix, `INSERT INTO messages_fts(messages_fts) VALUES('rebuild')`
    // ran unconditionally at module load — a full scan of the messages
    // table (1.4M+ rows in production) on every single boot.
    const db = makeDb();
    let rebuildCount = 0;
    const simulateBoot = () =>
      runOnce(db, "fts_rebuild_v1", () => {
        rebuildCount++;
      });

    simulateBoot();
    simulateBoot();
    simulateBoot();

    expect(rebuildCount).toBe(1);

    db.close();
  });

  test("different keys are tracked independently", () => {
    const db = makeDb();
    let aCalls = 0;
    let bCalls = 0;

    runOnce(db, "migration-a", () => {
      aCalls++;
    });
    runOnce(db, "migration-b", () => {
      bCalls++;
    });
    runOnce(db, "migration-a", () => {
      aCalls++;
    });

    expect(aCalls).toBe(1);
    expect(bCalls).toBe(1);

    db.close();
  });
});
