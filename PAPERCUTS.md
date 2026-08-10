# Papercuts

2026-08-04T22:03:52.066Z - fable - blake johnson

Diagnosing 'pool saturation' reports post tab-teardown fix: ab ps counts /tmp/.ab-session-* marker files (30-min gc idle grace keeps 100+ rows on busy days), while real Chrome load is tabCounts in ab status — agents keep misreading marker sprawl as saturation.

2026-08-09T20:10:59.127Z - fable - blake johnson

QA'ing session-explorer: cross-referenced DB ingested_at (UTC) against file mtimes (local EDT) and got a false 'regression after the fix' verdict — sessions.ingested_at has no timezone marker in some rows and mixed ISO-T/space formats, so string comparisons and tz math both lie. Normalize with datetime() and compare in one zone.

2026-08-09T20:10:59.170Z - fable - blake johnson

IDE diagnostics repeatedly reported stale errors mid-session (Cannot find module './active-path', params unknown[] errors that were already fixed) while bunx tsc --noEmit showed zero — trust the real tsc run, not the LSP echo, when agents edit concurrently.

2026-08-09T20:10:59.204Z - fable - blake johnson

macOS has no coreutils 'timeout' command — a sandboxed test run using 'timeout 15 bun ...' died with exit 127; use the Bash tool's timeout parameter instead.
