/** Parse summary into clean bullet points, stripping markdown noise */
const MAX_BULLETS = 4;

// Lines that are preamble noise, not actual summary content
const NOISE_PATTERNS = [
  /^#{1,4}\s/,                          // markdown headings
  /^\|?[-:|\s]+\|?$/,                   // table separators
  /^\*\*.*\*\*:?\s*$/,                  // bold-only lines
  /^here'?s?\s+(the\s+)?session\s+summary/i,  // "Here's the session summary:"
  /^summary\s*(of\s+this)?/i,           // "Summary of this session:"
  /^\[?(user|assistant|human|claude)\]?:/i, // role-prefixed lines
  /^(in this session|the user|this session)/i, // banned preamble
];

export function parseSummaryBullets(raw: string): string[] {
  return raw
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !NOISE_PATTERNS.some(p => p.test(l)))
    .map(l => l.startsWith('|') ? l.replace(/^\||\|$/g, '').split('|').map(c => c.trim()).filter(Boolean).join(' — ') : l)
    .map(l => l.replace(/^[-•*]\s*/, '').replace(/\*\*/g, ''))
    // Strip role prefixes that appear mid-bullet (e.g. "- [assistant]: Fixed X")
    .map(l => l.replace(/^\[?(user|assistant|human|claude)\]?:\s*/i, ''))
    .filter(l => l.length > 0)
    .slice(0, MAX_BULLETS);
}
