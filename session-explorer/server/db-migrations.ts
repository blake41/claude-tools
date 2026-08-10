// Structural type for bun:sqlite's Database, duck-typed instead of imported
// so this module (and its tests) don't depend on bun's ambient types being
// resolvable by whatever tsc/editor is looking at it.
interface PreparedStatementLike {
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): unknown;
}
interface DatabaseLike {
  prepare(sql: string): PreparedStatementLike;
}
interface ExecutableDatabaseLike extends DatabaseLike {
  exec(sql: string): unknown;
}

/**
 * Runs `fn` at most once against `db`, tracked via a key/value table with a
 * `(key TEXT PRIMARY KEY, value TEXT)` shape (the app's `settings` table).
 * Used for one-time migrations — e.g. a full FTS5 rebuild over 1.4M rows —
 * that must not re-run on every process boot.
 *
 * Returns true if `fn` ran (first time), false if it was already done.
 */
export function runOnce(db: DatabaseLike, key: string, fn: () => void): boolean {
  const already = db.prepare(`SELECT 1 FROM settings WHERE key = ?`).get(key);
  if (already) return false;

  fn();

  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, '1', datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
  ).run(key);
  return true;
}

// ── SQLite version floor ────────────────────────────────────────────
//
// Bun's bundled SQLite regressed to 3.43.2 in some builds (oven-sh/bun#31247).
// That version has an FTS5 bug where the external-content `'delete'` special
// insert can raise SQLITE_CORRUPT_VTAB. This codebase performs exactly that on
// EVERY reingest (the `messages_fts_delete` trigger), so a bun upgrade that
// drags in 3.43.2 would silently start corrupting the search index instead of
// failing at a spot anyone would notice. Fail loudly at boot instead.
//
// 3.46 is the floor rather than "anything newer than 3.43.2" because that is
// the first release the bug is known-fixed in across the affected series.
export const MIN_SQLITE_VERSION = "3.46.0";

/**
 * Parses a SQLite version string ("3.51.0", "3.46") into comparable parts.
 * Returns null when the string is not a recognizable dotted numeric version —
 * callers treat that as a failure, not as a pass, because an unreadable
 * version means we cannot prove the FTS5 bug is absent.
 */
function parseVersion(version: string): [number, number, number] | null {
  const match = /^\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(version);
  if (!match) return null;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

/**
 * Throws unless `version` (the value of `sqlite_version()`) is at least
 * MIN_SQLITE_VERSION. Pure so tests can feed it a fake "3.43.2" without
 * needing a differently-built bun.
 */
export function assertSqliteVersionSupported(version: string): void {
  const found = parseVersion(version);
  const floor = parseVersion(MIN_SQLITE_VERSION)!;

  const tooOld =
    found === null ||
    found[0] < floor[0] ||
    (found[0] === floor[0] && found[1] < floor[1]) ||
    (found[0] === floor[0] && found[1] === floor[1] && found[2] < floor[2]);

  if (tooOld) {
    throw new Error(
      `session-explorer requires SQLite >= ${MIN_SQLITE_VERSION}, but this runtime reports ` +
        `"${version}". Bun's bundled SQLite regressed to 3.43.2 in some builds ` +
        `(oven-sh/bun#31247), which corrupts FTS5 external-content tables on the ` +
        `'delete' special insert — something this app does on every reingest. ` +
        `Upgrade bun (or point bun:sqlite at a newer libsqlite) before starting.`
    );
  }
}

// ── Schema ──────────────────────────────────────────────────────────
//
// The whole schema lives here, as a function taking a database handle, rather
// than as top-level side effects in `server/db.ts`. Two reasons:
//
//  1. `server/db.ts` opens the real, file-backed `data/sessions.db` (1.6 GB,
//     1.4M message rows) at import time. If the schema lived there, any test
//     that wanted to assert on it would have to import that module — opening
//     production data and running one-time migrations (including a full FTS5
//     rebuild) as a side effect of `bun test`.
//  2. Idempotency is a property worth testing directly: `applySchema` can be
//     called twice against the same handle, which is what a server restart
//     does.
//
// `db.ts` stays the owner of the singleton handle, the data directory, and the
// pragmas; it calls this once at boot.

/**
 * Creates every table/index/trigger and applies every additive migration.
 * Safe to call repeatedly against the same database (that is exactly what a
 * process restart does). Expensive one-time work is guarded by `runOnce`.
 */
export function applySchema(db: ExecutableDatabaseLike): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id INTEGER PRIMARY KEY,
      path TEXT UNIQUE NOT NULL,
      dir_name TEXT NOT NULL,
      display_name TEXT NOT NULL,
      session_count INTEGER DEFAULT 0,
      last_activity TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      workspace_id INTEGER REFERENCES workspaces(id),
      source_path TEXT NOT NULL,
      started_at TEXT,
      ended_at TEXT,
      git_branch TEXT,
      title TEXT,
      message_count INTEGER DEFAULT 0,
      user_message_count INTEGER DEFAULT 0,
      summary TEXT,
      file_size INTEGER,
      ingested_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY,
      session_id TEXT REFERENCES sessions(id),
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp TEXT,
      sequence INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at);
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);

    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      color TEXT DEFAULT '#58a6ff',
      description TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session_tags (
      session_id TEXT REFERENCES sessions(id),
      tag_id INTEGER REFERENCES tags(id),
      added_at TEXT NOT NULL,
      PRIMARY KEY (session_id, tag_id)
    );

    CREATE TABLE IF NOT EXISTS session_files (
      id INTEGER PRIMARY KEY,
      session_id TEXT REFERENCES sessions(id),
      file_path TEXT NOT NULL,
      file_name TEXT NOT NULL,
      operation TEXT NOT NULL,
      timestamp TEXT,
      sequence INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_files_path ON session_files(file_path);
    CREATE INDEX IF NOT EXISTS idx_files_session ON session_files(session_id);
    CREATE INDEX IF NOT EXISTS idx_files_name ON session_files(file_name);

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      details TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS saved_searches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      query_text TEXT NOT NULL,
      last_run_at TEXT,
      last_run_count INTEGER,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query_text TEXT NOT NULL,
      answer_text TEXT,
      session_ids TEXT,
      session_count INTEGER DEFAULT 0,
      queries TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content,
      content='messages',
      content_rowid='id'
    );

    CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
    END;
  `);

  // ── Insights Tables ─────────────────────────────────────────────────

  db.exec(`
    CREATE TABLE IF NOT EXISTS insights (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      canonical_form TEXT,
      canonical_hash TEXT,
      context TEXT,
      entities TEXT,
      source TEXT DEFAULT 'parent',
      observation_count INTEGER DEFAULT 1,
      score REAL DEFAULT 1.0,
      upvotes INTEGER DEFAULT 0,
      downvotes INTEGER DEFAULT 0,
      deleted_at TEXT,
      extracted_at TEXT NOT NULL,
      last_observed_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_insights_session ON insights(session_id);
    CREATE INDEX IF NOT EXISTS idx_insights_type ON insights(type);
    CREATE INDEX IF NOT EXISTS idx_insights_hash ON insights(canonical_hash);
    CREATE INDEX IF NOT EXISTS idx_insights_score ON insights(score DESC);

    CREATE TABLE IF NOT EXISTS insight_files (
      insight_id INTEGER NOT NULL REFERENCES insights(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL,
      PRIMARY KEY (insight_id, file_path)
    );

    CREATE INDEX IF NOT EXISTS idx_insight_files_path ON insight_files(file_path);

    CREATE TABLE IF NOT EXISTS insight_sessions (
      insight_id INTEGER NOT NULL REFERENCES insights(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      extracted_at TEXT NOT NULL,
      PRIMARY KEY (insight_id, session_id)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Migration: add insights_extracted column to sessions
  addColumn(db, `ALTER TABLE sessions ADD COLUMN insights_extracted INTEGER DEFAULT 0`);

  // Migration: add message_type column to messages
  addColumn(db, `ALTER TABLE messages ADD COLUMN message_type TEXT DEFAULT 'text'`);

  // Migration: add source column to messages
  addColumn(db, `ALTER TABLE messages ADD COLUMN source TEXT DEFAULT 'parent'`);

  // Migration: add tool linkage columns to messages — tool_use_id pairs a
  // tool_use with its tool_result; tool_name/tool_input let the UI render
  // per-tool blocks (Edit diff, Bash code, TodoWrite checklist, etc.)
  addColumn(db, `ALTER TABLE messages ADD COLUMN tool_use_id TEXT`);
  addColumn(db, `ALTER TABLE messages ADD COLUMN tool_name TEXT`);
  addColumn(db, `ALTER TABLE messages ADD COLUMN tool_input TEXT`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_tool_use_id ON messages(tool_use_id)`);

  // Migration: drop legacy tool_calls table
  db.exec(`DROP TABLE IF EXISTS tool_calls`);
  db.exec(`DROP INDEX IF EXISTS idx_tool_calls_session`);
  db.exec(`DROP INDEX IF EXISTS idx_tool_calls_name`);

  // Rebuild FTS index to cover any data ingested before FTS5 was added — this
  // is a full scan of every row in `messages` (1.4M+), so it must run exactly
  // once, not on every server boot. Tracked via the `settings` table (created
  // above, in the Insights Tables block).
  runOnce(db, "fts_rebuild_v1", () => {
    db.exec(`INSERT INTO messages_fts(messages_fts) VALUES('rebuild')`);
  });

  // ── Meta Layer Tables ─────────────────────────────────────────────

  db.exec(`
    CREATE TABLE IF NOT EXISTS session_scores (
      id INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      tool_efficiency REAL,
      fix_convergence REAL,
      context_discipline REAL,
      verification_rigor REAL,
      architectural_alignment REAL,
      composite_score REAL,
      raw_event_count INTEGER,
      scored_at TEXT NOT NULL,
      UNIQUE(session_id)
    );

    CREATE TABLE IF NOT EXISTS proposals (
      id INTEGER PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'proposed',
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      detail TEXT NOT NULL,
      evidence_session_ids TEXT NOT NULL,
      confidence REAL NOT NULL,
      score_impact TEXT,
      created_at TEXT NOT NULL,
      reviewed_at TEXT,
      review_note TEXT,
      applied_at TEXT,
      applied_ref TEXT,
      UNIQUE(type, title)
    );

    CREATE TABLE IF NOT EXISTS meta_runs (
      id INTEGER PRIMARY KEY,
      trigger TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      sessions_analyzed INTEGER,
      proposals_created INTEGER,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS session_events (
      id INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      sequence INTEGER NOT NULL,
      type TEXT NOT NULL,
      tool TEXT,
      target_file TEXT,
      success INTEGER NOT NULL DEFAULT 1,
      token_cost INTEGER,
      timestamp TEXT NOT NULL,
      metadata TEXT,
      UNIQUE(session_id, sequence)
    );

    CREATE INDEX IF NOT EXISTS idx_session_events_session ON session_events(session_id);
    CREATE INDEX IF NOT EXISTS idx_session_events_type ON session_events(type);
    CREATE INDEX IF NOT EXISTS idx_session_scores_composite ON session_scores(composite_score);
    CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status);
    CREATE INDEX IF NOT EXISTS idx_proposals_type ON proposals(type);
    CREATE INDEX IF NOT EXISTS idx_meta_runs_started ON meta_runs(started_at);
  `);

  // Migration: add events_extracted column to sessions
  addColumn(db, `ALTER TABLE sessions ADD COLUMN events_extracted INTEGER DEFAULT 0`);

  // Migration: add summary_short column to sessions — one-line session summary
  addColumn(db, `ALTER TABLE sessions ADD COLUMN summary_short TEXT`);

  // Migration: add note column to session_tags — personal note for why a session was tagged
  addColumn(db, `ALTER TABLE session_tags ADD COLUMN note TEXT`);

  // Migration: add summarization retry/backoff tracking to sessions — without
  // this, a session whose summary parse fails writes NULL forever and gets
  // re-selected (and re-billed against the Haiku API) on every ~30s
  // auto-summarize tick. See server/summarize-backoff.ts for the backoff rule.
  addColumn(db, `ALTER TABLE sessions ADD COLUMN summary_retry_count INTEGER DEFAULT 0`);
  addColumn(db, `ALTER TABLE sessions ADD COLUMN summary_failed_at TEXT`);

  // Migration: schema-drift canary — per-session tally of JSONL record `type`
  // values ingest.ts saw that strip.ts neither actively handles nor
  // deliberately skips (JSON: {type: count}). NULL means none seen. See
  // server/canary.ts.
  addColumn(db, `ALTER TABLE sessions ADD COLUMN unknown_record_types TEXT`);

  // Migration: summary staleness tracking — the message_count a session had
  // at the moment its summary/summary_short were last written. NULL means
  // "never summarized" OR "summarized before this column existed" — both
  // treated as never-stale by server/summary-staleness.ts so pre-existing
  // sessions aren't stampede-resummarized. Set wherever a summary is recorded
  // (see server/summary-staleness.ts for the restore-time predicate).
  addColumn(db, `ALTER TABLE sessions ADD COLUMN summarized_message_count INTEGER`);

  // Migration: timestamp of the last successful summarize — lets the
  // staleness rule debounce by elapsed time (not just message-count growth)
  // so an actively-growing session doesn't get re-summarized on every ~30s
  // reingest tick. NULL means "never summarized" (never-stale, same as
  // summarized_message_count). See server/summary-staleness.ts.
  addColumn(db, `ALTER TABLE sessions ADD COLUMN summarized_at TEXT`);

  applyUnifiedParserSchema(db);
}

/**
 * `ALTER TABLE ... ADD COLUMN` is not idempotent in SQLite and there is no
 * `IF NOT EXISTS` form, so the repo's migration idiom is try/catch-and-ignore
 * ("column already exists" is the only realistic failure for an additive
 * column on a table we just created above).
 */
function addColumn(db: ExecutableDatabaseLike, sql: string): void {
  try {
    db.exec(sql);
  } catch {
    // Column already exists
  }
}

// ── Unified parser migration (plan U1) ──────────────────────────────
//
// Everything below exists so the DB can hold FULL-FIDELITY session data
// before any ingest logic changes. Today ingest stores a lossy projection
// only (tool results truncated at 500 chars, short assistant text dropped);
// these tables/columns are the storage side of moving to
// "clean projection + raw payload, side by side".

function applyUnifiedParserSchema(db: ExecutableDatabaseLike): void {
  // Migration: link a projection row back to the raw JSONL record it came
  // from (D2). NULL on every row ingested before the unified parser lands —
  // the UI must treat "no record_uuid" as "expand unavailable", not as an
  // error, until the U8 force-reingest backfills it.
  addColumn(db, `ALTER TABLE messages ADD COLUMN record_uuid TEXT`);

  // Migration: FTS facet columns, denormalized onto messages (D4). An
  // external-content FTS5 table reads each indexed column from the SAME-NAMED
  // column of its content table, so faceting search by session title or
  // workspace REQUIRES these to exist on `messages` — a separate sessions_fts
  // table cannot answer `{title workspace}: term AND content-term` in one
  // MATCH. Staleness is a non-issue: reingest rewrites all of a session's
  // message rows. Cost is ~1.4M rows x ~80 bytes ~= 120 MB, inside the
  // 3-5 GB envelope.
  addColumn(db, `ALTER TABLE messages ADD COLUMN title TEXT`);
  addColumn(db, `ALTER TABLE messages ADD COLUMN workspace TEXT`);

  // Migration: mtime half of the reingest trigger (D10). The trigger was
  // file-size-only, so an in-place rewrite that happened to keep the same
  // size was never re-ingested. Reingest now fires when size OR mtime differs.
  addColumn(db, `ALTER TABLE sessions ADD COLUMN file_mtime INTEGER`);

  // Migration: the LeanSessionDetail envelope (session, metrics, models,
  // subagentCount, unattachedSubagents, fingerprint) as JSON, alongside the
  // per-chunk rows in trace_chunks (D3). Session-level scalars that the trace
  // endpoint reassembles around the chunks; NULL means "never ingested with
  // the unified parser" and the endpoint answers 404-with-reingest-hint.
  addColumn(db, `ALTER TABLE sessions ADD COLUMN trace_meta TEXT`);

  // raw_records — one row per RAW JSONL record, verbatim, keyed by the
  // record's own uuid (D2). Deliberately NOT a `raw` column on `messages`:
  // message rows are block-level (one assistant record carrying
  // thinking+text+tool_use becomes 2-3 rows), so a per-row raw column would
  // store the same record 2-3 times and blow past the 3-5 GB size envelope.
  // `messages.record_uuid` links a projection row back to its source record;
  // full-fidelity reads (expand-on-click, Ask/chat `json_extract`) join here.
  // `seq` preserves file order for records that never became a message row.
  db.exec(`
    CREATE TABLE IF NOT EXISTS raw_records (
      session_id TEXT NOT NULL,
      uuid TEXT NOT NULL,
      seq INTEGER NOT NULL,
      raw TEXT NOT NULL,
      PRIMARY KEY (session_id, uuid)
    );

    CREATE INDEX IF NOT EXISTS idx_raw_records_session ON raw_records(session_id);
  `);

  // trace_chunks — the lean trace model, materialized at ingest, one row per
  // chunk (D3). Today `GET /api/sessions/:id/trace` re-parses the original
  // JSONL on every request, which breaks once Claude Code prunes the file.
  // Storing chunks makes the trace a pure SQL read.
  //
  // `payload` is one LeanChunk JSON with its steps embedded: a chunk is the
  // UI's atomic render unit and its payload strings are already capped by
  // shapeTraceForResponse. Chunk granularity (not one blob per session) is
  // what keeps windowed/paginated fetch possible by row.
  // started_at/ended_at are nullable ISO strings, denormalized out of the
  // payload so ordering/windowing never needs to parse JSON.
  db.exec(`
    CREATE TABLE IF NOT EXISTS trace_chunks (
      session_id TEXT NOT NULL,
      chunk_seq INTEGER NOT NULL,
      chunk_type TEXT NOT NULL,
      started_at TEXT,
      ended_at TEXT,
      payload TEXT NOT NULL,
      PRIMARY KEY (session_id, chunk_seq)
    );
  `);

  applyFtsPorterFacetsMigration(db);
}

/**
 * Swaps `messages_fts` for a porter-stemmed, faceted index (D4, D5).
 *
 * FTS5 fixes `tokenize` at CREATE VIRTUAL TABLE time and column sets are not
 * alterable, so adding porter stemming plus the title/workspace facet columns
 * is necessarily DROP + recreate, not a rebuild.
 *
 * Load-bearing details:
 *  - `content` MUST stay column 0. `server/index.ts`'s search statements call
 *    `snippet(messages_fts, 0, ...)` by index; moving it silently starts
 *    returning title/workspace snippets instead of message text.
 *  - The facet columns work because this is an external-content table: FTS5
 *    reads each indexed column from the same-named column of `messages`, so
 *    both triggers must write all three columns.
 *  - The rebuild at the end initially indexes the OLD lossy row content. That
 *    is intentional: search keeps working between this deploy and the later
 *    force-reingest, which rewrites row content and re-syncs FTS through the
 *    triggers.
 *
 * BOOT DELAY: the rebuild is a full scan of `messages`. Measured 2026-08-10
 * against a copy of the production DB (1,421,643 rows / 1.6 GB, bun 1.3.14,
 * SQLite 3.51.0): 21 s for the whole drop+recreate+rebuild, one time. Every
 * later boot skips it via `runOnce` (measured 0.00 s). Do not "optimize" the
 * rebuild away — an unrebuilt index after a DROP is an EMPTY index, i.e.
 * search silently returns nothing.
 */
function applyFtsPorterFacetsMigration(db: ExecutableDatabaseLike): void {
  runOnce(db, "fts_porter_facets_v1", () => {
    db.exec(`
      DROP TRIGGER IF EXISTS messages_fts_insert;
      DROP TRIGGER IF EXISTS messages_fts_delete;
      DROP TABLE IF EXISTS messages_fts;

      CREATE VIRTUAL TABLE messages_fts USING fts5(
        content,
        title,
        workspace,
        tokenize='porter unicode61',
        content='messages',
        content_rowid='id'
      );

      CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content, title, workspace)
        VALUES (new.id, new.content, new.title, new.workspace);
      END;

      CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content, title, workspace)
        VALUES ('delete', old.id, old.content, old.title, old.workspace);
      END;

      INSERT INTO messages_fts(messages_fts) VALUES('rebuild');
    `);
  });
}
