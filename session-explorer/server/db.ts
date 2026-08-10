import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { applySchema, assertSqliteVersionSupported } from "./db-migrations.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_DIR = join(__dirname, "..", "data");
const DB_PATH = join(DB_DIR, "sessions.db");

mkdirSync(DB_DIR, { recursive: true });

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA busy_timeout = 5000");

// Fail loudly on a SQLite build with the FTS5 external-content corruption bug
// BEFORE any schema work runs — see assertSqliteVersionSupported (D12,
// oven-sh/bun#31247). A corrupt search index is silent damage; a failed boot
// is not.
assertSqliteVersionSupported(
  (db.prepare(`SELECT sqlite_version() AS v`).get() as { v: string }).v
);

// The schema itself lives in ./db-migrations.ts as a function over a database
// handle, so it can be applied to a fresh :memory: DB in tests without
// importing this module (which opens the real 1.6 GB data/sessions.db and
// would run one-time migrations against it as a side effect of `bun test`).
applySchema(db);

export default db;
export { DB_PATH };
