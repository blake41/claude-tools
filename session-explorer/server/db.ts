import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_DIR = join(__dirname, "..", "data");
const DB_PATH = join(DB_DIR, "sessions.db");

mkdirSync(DB_DIR, { recursive: true });

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma("journal_mode = WAL");

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
`);

export default db;
export { DB_PATH };
