// ── Schema-Drift Canary ────────────────────────────────────────────
//
// strip.ts silently skips JSONL record `type` values it doesn't recognize
// (see its SKIP_TYPES set) and only actively handles "user"/"assistant".
// If Claude Code ever introduces a new record type, that data quietly
// vanishes from stripSession's output with no signal anywhere.
//
// This module independently tallies `type` values seen in a raw JSONL file
// against the set of types strip.ts is known to understand, so ingest.ts can
// flag genuinely new ones. It intentionally duplicates strip.ts's type
// vocabulary rather than importing it, since strip.ts is out of scope here
// (see project CLAUDE.md-adjacent task boundary) — keep KNOWN_RECORD_TYPES
// in sync with strip.ts's handled types ("user", "assistant") plus its
// SKIP_TYPES set if either changes.

/** Record types strip.ts actively parses ("user", "assistant") or
 * deliberately ignores (SKIP_TYPES). Anything outside this set is a record
 * type strip.ts has never seen and is silently dropping. */
export const KNOWN_RECORD_TYPES = new Set([
  "user",
  "assistant",
  "file-history-snapshot",
  "progress",
  "queue-operation",
  "system",
]);

export interface RawRecordLike {
  type?: string;
  [key: string]: unknown;
}

/**
 * Parse a raw JSONL blob into records, skipping malformed lines. Mirrors
 * strip.ts's own line-splitting/parsing behavior (blank lines skipped,
 * unparseable lines silently dropped) so the tally reflects exactly the
 * records strip.ts itself would have looked at.
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
