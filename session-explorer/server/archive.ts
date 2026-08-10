// ── Raw JSONL Archive ─────────────────────────────────────────────
//
// Claude Code prunes transcripts after `cleanupPeriodDays`. Once that
// happens, the DB's stripped/lossy rows are all that's left of a session —
// the raw JSONL (tool inputs/outputs, full message trees, subagent detail)
// is gone forever. This module gzip-copies the raw JSONL to
// `data/archive/<session-id>.jsonl.gz` on every ingest/reingest so a fallback
// exists after pruning.
//
// Contract: the archive path is exactly `data/archive/<session-id>.jsonl.gz`
// (latest-only, overwritten on every re-archive). Another agent's trace
// endpoint depends on this exact path as a fallback when the original file
// is gone — do not change it without updating that consumer.

import { mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import db from "./db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ARCHIVE_DIR = join(__dirname, "..", "data", "archive");

export function archivePathFor(sessionId: string): string {
  return join(ARCHIVE_DIR, `${sessionId}.jsonl.gz`);
}

// ── Manifest (skip-if-unchanged) ──────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS archive_manifest (
    session_id TEXT PRIMARY KEY,
    source_size INTEGER NOT NULL,
    source_mtime_ms INTEGER NOT NULL,
    archived_at TEXT NOT NULL
  );
`);

const getManifestEntry = db.prepare(
  `SELECT source_size, source_mtime_ms FROM archive_manifest WHERE session_id = ?`
);
const upsertManifestEntry = db.prepare(`
  INSERT INTO archive_manifest (session_id, source_size, source_mtime_ms, archived_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(session_id) DO UPDATE SET
    source_size = excluded.source_size,
    source_mtime_ms = excluded.source_mtime_ms,
    archived_at = excluded.archived_at
`);

export interface ArchiveStat {
  size: number;
  mtimeMs: number;
}

/**
 * Pure decision: should the archive be (re)written given what's on record
 * vs. the source file's current stat? No disk/DB access — unit-testable in
 * isolation. `stored` is `null`/`undefined` when there's no manifest entry
 * yet (first archive for this session).
 */
export function shouldArchive(
  stored: ArchiveStat | null | undefined,
  current: ArchiveStat
): boolean {
  if (!stored) return true;
  return stored.size !== current.size || stored.mtimeMs !== current.mtimeMs;
}

/**
 * Gzip-copy `sourcePath` to `data/archive/<sessionId>.jsonl.gz`, skipping
 * the write (and the full-file read) when the manifest shows the source's
 * size+mtime haven't changed since the last archive. Only a single stat()
 * call is paid on the unchanged-file fast path — no hashing, no read.
 *
 * Returns true if a (re)write happened, false if skipped or the source
 * couldn't be stat'd (e.g. removed between discovery and archiving).
 */
export function archiveSession(sessionId: string, sourcePath: string): boolean {
  let stat;
  try {
    stat = statSync(sourcePath);
  } catch {
    return false;
  }

  const current: ArchiveStat = { size: stat.size, mtimeMs: stat.mtimeMs };
  const storedRow = getManifestEntry.get(sessionId) as
    | { source_size: number; source_mtime_ms: number }
    | undefined;
  const stored: ArchiveStat | null = storedRow
    ? { size: storedRow.source_size, mtimeMs: storedRow.source_mtime_ms }
    : null;

  if (!shouldArchive(stored, current)) return false;

  mkdirSync(ARCHIVE_DIR, { recursive: true });
  const raw = readFileSync(sourcePath);
  const gz = Bun.gzipSync(raw);
  writeFileSync(archivePathFor(sessionId), gz);

  upsertManifestEntry.run(
    sessionId,
    current.size,
    current.mtimeMs,
    new Date().toISOString()
  );
  return true;
}
