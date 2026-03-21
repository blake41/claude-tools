/** Parse summary into clean bullet points, stripping markdown noise */
const MAX_BULLETS = 4;

export function parseSummaryBullets(raw: string): string[] {
  return raw
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.match(/^#{1,4}\s/) && !l.match(/^\|?[-:|\s]+\|?$/) && !l.match(/^\*\*.*\*\*:?\s*$/))
    .map(l => l.startsWith('|') ? l.replace(/^\||\|$/g, '').split('|').map(c => c.trim()).filter(Boolean).join(' — ') : l)
    .map(l => l.replace(/^[-•*]\s*/, '').replace(/\*\*/g, ''))
    .filter(l => l.length > 0)
    .slice(0, MAX_BULLETS);
}
