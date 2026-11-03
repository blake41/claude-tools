export type StatusLine =
  | { k: 'working'; note: string }
  | { k: 'needs_decision'; thread: string; question: string }
  | { k: 'rotate'; baton: string }
  | { k: 'done'; sha: string }
  | { k: 'failed'; reason: string }
  | { k: 'unknown'; raw: string }

export type TerminalStatusLine = Exclude<StatusLine, { k: 'working' } | { k: 'unknown' }>

export function parseStatusLine(raw: string): StatusLine {
  const line = raw.trim()
  let m: RegExpMatchArray | null
  if ((m = line.match(/^working:\s*(.*)$/))) return { k: 'working', note: m[1] ?? '' }
  if ((m = line.match(/^needs-decision\s+thread=(\S+?):\s*(.*)$/))) return { k: 'needs_decision', thread: m[1] ?? '', question: m[2] ?? '' }
  if ((m = line.match(/^rotate\s+baton=(\S+)$/))) return { k: 'rotate', baton: m[1] ?? '' }
  if ((m = line.match(/^done\s+sha=([0-9a-f]{7,40})$/))) return { k: 'done', sha: m[1] ?? '' }
  if ((m = line.match(/^failed:\s*(.*)$/))) return { k: 'failed', reason: m[1] ?? '' }
  return { k: 'unknown', raw: line }
}

export function isTerminal(line: StatusLine): line is TerminalStatusLine {
  return line.k !== 'working' && line.k !== 'unknown'
}

export function statusLineCount(text: string | null): number {
  return (text ?? '').split('\n').filter((l) => l.trim() !== '').length
}

export function newStatusLines(text: string | null, cursor: number): { lines: StatusLine[]; cursor: number } {
  const all = (text ?? '').split('\n').filter((l) => l.trim() !== '')
  return { lines: all.slice(cursor).map(parseStatusLine), cursor: all.length }
}
