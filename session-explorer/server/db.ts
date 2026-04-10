import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_DIR = join(__dirname, "..", "data");
const DB_PATH = join(DB_DIR, "sessions.db");

mkdirSync(DB_DIR, { recursive: true });

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA busy_timeout = 5000");

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
try {
  db.exec(`ALTER TABLE sessions ADD COLUMN insights_extracted INTEGER DEFAULT 0`);
} catch {
  // Column already exists
}

// Migration: add message_type column to messages
try {
  db.exec(`ALTER TABLE messages ADD COLUMN message_type TEXT DEFAULT 'text'`);
} catch {
  // Column already exists
}

// Migration: add source column to messages
try {
  db.exec(`ALTER TABLE messages ADD COLUMN source TEXT DEFAULT 'parent'`);
} catch {
  // Column already exists
}

// Migration: drop legacy tool_calls table
db.exec(`DROP TABLE IF EXISTS tool_calls`);
db.exec(`DROP INDEX IF EXISTS idx_tool_calls_session`);
db.exec(`DROP INDEX IF EXISTS idx_tool_calls_name`);

// Rebuild FTS index to cover any data ingested before FTS5 was added
db.exec(`INSERT INTO messages_fts(messages_fts) VALUES('rebuild')`);

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
try {
  db.exec(`ALTER TABLE sessions ADD COLUMN events_extracted INTEGER DEFAULT 0`);
} catch {
  // Column already exists
}

export default db;
export { DB_PATH };
