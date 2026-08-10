// ── Text Sampling ─────────────────────────────────────────────────────
//
// Pure helper for building bounded-length excerpts of long transcripts.

/**
 * Sample the head and tail of `text`, dropping the middle, so downstream
 * consumers (e.g. session summarization) see both how something started and
 * how it ended instead of only the beginning. Returns `text` unchanged if it
 * already fits within `headChars + tailChars`.
 */
export function sampleHeadTail(
  text: string,
  headChars: number,
  tailChars: number
): string {
  if (text.length <= headChars + tailChars) return text;
  const head = text.slice(0, headChars);
  const tail = text.slice(-tailChars);
  return `${head}\n\n[... middle of session omitted ...]\n\n${tail}`;
}
