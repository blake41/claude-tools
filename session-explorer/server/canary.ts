// ── Schema-Drift Canary ────────────────────────────────────────────
//
// The ingest parse step silently drops JSONL record `type` values it doesn't
// recognize. That is now the VENDORED claude-devtools parser
// (`server/trace/vendor/`, driven through `server/trace/index.ts` and
// projected by `server/projection.ts`): its `parseJsonlLine` only builds a
// ParsedMessage for the conversational record types, and `projectMessage`
// additionally skips a small set of structural types outright
// (`SKIP_RECORD_TYPES` in projection.ts). If Claude Code ever introduces a new
// record type, that data quietly vanishes with no signal anywhere.
//
// This module independently tallies `type` values seen in a raw JSONL file
// against the set of types the parse step is known to understand, so ingest.ts
// can flag genuinely new ones. Duplicating the vocabulary here rather than
// importing it is deliberate on two counts: `server/trace/vendor/` is pinned
// and must not be imported for anything but parsing, and a canary that shares
// its subject's own type table cannot notice that table going stale. Keep
// KNOWN_RECORD_TYPES in sync by hand when the parser's or the projection's
// vocabulary changes.
//
// (U8 checked whether any of these entries could now be retired: no, except
// "progress" is now legacy — see its inline comment below. This set was
// re-derived against the vendored parser's `parseMessageType` and
// projection.ts's `SKIP_RECORD_TYPES`, not carried over from strip.ts, which
// is gone as of U8. canary.test.ts pins this set behaviorally against both.)

/** Record types the parse step turns into rows, or deliberately ignores.
 * Anything outside this set is a record type nothing downstream has ever seen
 * and is silently dropping. */
export const KNOWN_RECORD_TYPES = new Set([
  "user",
  "assistant",
  "system",
  "summary", // real type; deliberately skipped by projection.ts's SKIP_RECORD_TYPES
  "file-history-snapshot",
  "queue-operation",
  "progress", // legacy type (2026-02/03 transcripts only); the vendored parser
              // no longer recognizes it and silently drops it by design — kept
              // here so re-ingesting those old sessions doesn't spam "unknown"
]);

export interface RawRecordLike {
  type?: string;
  [key: string]: unknown;
}

/**
 * Parse a raw JSONL blob into records, skipping malformed lines. Mirrors the
 * parse step's own line-splitting behavior (blank lines skipped, unparseable
 * lines silently dropped) so the tally reflects exactly the records the
 * parser itself would have looked at.
 */
export function parseJsonlLines(raw: string): RawRecordLike[] {
  const records: RawRecordLike[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      // skip malformed lines
    }
  }
  return records;
}

/**
 * Tally record `type` values that are neither handled nor in the known-skip
 * set. Pure function — no disk/DB access — so it's unit-testable in
 * isolation. Returns `{}` when every record's type is recognized.
 */
export function tallyUnknownRecordTypes(
  records: RawRecordLike[]
): Record<string, number> {
  const tally: Record<string, number> = {};
  for (const record of records) {
    const type = record.type;
    if (!type || KNOWN_RECORD_TYPES.has(type)) continue;
    tally[type] = (tally[type] || 0) + 1;
  }
  return tally;
}
