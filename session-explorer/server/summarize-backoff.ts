// ── Summarization Retry Backoff ──────────────────────────────────────
//
// A failed summary parse used to leave `summary`/`summary_short` as NULL
// forever, so the ~30s auto-summarize tick re-selected the same handful of
// broken sessions and re-billed a Haiku call every cycle, indefinitely.
//
// This module is the single source of truth for the retry/backoff rule,
// expressed two ways that must stay in sync:
//   - `isRetryEligible` — a pure JS predicate, unit-testable in isolation.
//   - `UNSUMMARIZED_BACKOFF_SQL` — the equivalent SQLite WHERE-clause
//     fragment, shared by both unsummarized-session queries in index.ts so
//     they can't drift from each other.

/** After this many failed attempts, a session is permanently excluded from
 * auto-summarization (it can still be retried manually). */
export const MAX_SUMMARY_RETRIES = 8;

/** Backoff never waits longer than this, regardless of retry count. */
export const BACKOFF_CAP_MINUTES = 1440; // 24h

/** Exponential backoff (2^retryCount minutes), capped at 24h. */
export function backoffMinutes(retryCount: number): number {
  return Math.min(BACKOFF_CAP_MINUTES, 2 ** Math.max(0, retryCount));
}

/**
 * Whether a session with the given retry state should be attempted again
 * right now. Mirrors `UNSUMMARIZED_BACKOFF_SQL` below — keep both in sync.
 */
export function isRetryEligible(
  retryCount: number,
  failedAt: string | null,
  now: Date = new Date()
): boolean {
  if (retryCount >= MAX_SUMMARY_RETRIES) return false;
  if (!failedAt) return true;

  const failedAtMs = new Date(failedAt).getTime();
  if (Number.isNaN(failedAtMs)) return true;

  const waitMs = backoffMinutes(retryCount) * 60_000;
  return now.getTime() - failedAtMs >= waitMs;
}

/**
 * SQL WHERE-clause fragment implementing the same rule in SQLite. Expects
 * the query to select from a table with `summary_retry_count` (INTEGER,
 * default 0) and `summary_failed_at` (TEXT, nullable ISO8601) columns.
 * Intentionally has no leading/trailing `AND` — splice it in with `AND`.
 */
export const UNSUMMARIZED_BACKOFF_SQL = `
  summary_retry_count < ${MAX_SUMMARY_RETRIES}
  AND (
    summary_failed_at IS NULL
    OR datetime(summary_failed_at, '+' || MIN(${BACKOFF_CAP_MINUTES}, (1 << summary_retry_count)) || ' minutes') <= datetime('now')
  )
`;
