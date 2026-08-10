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
