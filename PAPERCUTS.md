# Papercuts

2026-08-04T22:03:52.066Z - fable - blake johnson

Diagnosing 'pool saturation' reports post tab-teardown fix: ab ps counts /tmp/.ab-session-* marker files (30-min gc idle grace keeps 100+ rows on busy days), while real Chrome load is tabCounts in ab status — agents keep misreading marker sprawl as saturation.
