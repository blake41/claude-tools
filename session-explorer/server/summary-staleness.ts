// ── Summary Staleness Predicate ──────────────────────────────────────
//
// Reingest used to restore summary/summary_short unconditionally, so a
// session that kept growing after it was first summarized carried a stale
// summary forever — the auto-summarize tick only ever picks up sessions
// where summary IS NULL, and restoring a non-null (but outdated) summary
// on every reingest permanently hid the session from that query.
//
// This predicate decides whether a restored summary should instead be
// dropped (forcing one fresh re-summarization pass). Pure and DB-free so
// it's unit-testable in isolation — mirrored by the restore logic in
// ingest.ts.
//
// Rule: debounce by elapsed time, not message-count thresholds. Any growth
// since the last summary is enough to go stale, once at least
// STALE_DEBOUNCE_MS has passed since that summary was produced. A pure
// count/percentage gate let an actively-growing session sit on a
// several-hundred-message-stale summary for a long stretch; a pure
// no-debounce time gate would re-summarize on every single ~30s reingest
// tick for a busy session (the original cost leak). This combines both:
// bounded call volume, bounded staleness window.

export interface SummaryStalenessInput {
  /** Message count recorded at the time the summary was produced. `null`
   * covers both "never summarized" and "summarized before this column
   * existed" (legacy rows) — both must be treated as never-stale so we
   * don't stampede-resummarize every pre-existing session. */
  storedSummarizedCount: number | null;
  /** The session's current (post-reingest) message count. */
  freshMessageCount: number;
  /** ISO timestamp of when the stored summary was produced. `null` covers
   * "never summarized" and legacy rows predating this column — treated as
   * never-stale, same as `storedSummarizedCount`. */
  storedSummarizedAt: string | null;
  /** Current time in epoch ms, injected so the predicate stays pure/testable. */
  now: number;
}

/** Minimum time that must elapse since the last summarize before a
 * grown session is eligible to be re-summarized. Bounds call volume from
 * the ~30s auto-ingest tick without letting a busy session's summary go
 * stale for long. */
export const STALE_DEBOUNCE_MS = 2 * 60 * 1000;

/**
 * True when a previously-recorded summary should NOT be restored on
 * reingest because the session has grown since it was summarized AND
 * enough time has passed since that summary was produced.
 */
export function isSummaryStale(input: SummaryStalenessInput): boolean {
  const { storedSummarizedCount, freshMessageCount, storedSummarizedAt, now } = input;

  // Never summarized, or summarized before these columns existed — treat as
  // never-stale rather than force-resummarizing every legacy session.
  if (storedSummarizedCount === null || storedSummarizedCount === undefined) {
    return false;
  }
  if (!storedSummarizedAt) {
    return false;
  }

  if (freshMessageCount <= storedSummarizedCount) return false;

  const elapsed = now - new Date(storedSummarizedAt).getTime();
  return elapsed >= STALE_DEBOUNCE_MS;
}
