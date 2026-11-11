import type { Downgrade, GateVerdict } from './types.ts'

export type DowngradeInput = {
  files: string[]
  lines: number
  fixRoundsExhausted: boolean
  beadScopes: Record<string, string[]>
  beads: string[]
}

function matchesAny(globs: string[], file: string): string | null {
  return globs.find((g) => new Bun.Glob(g).match(file)) ?? null
}

function ruleReason(rule: Downgrade, input: DowngradeInput): string | null {
  switch (rule.kind) {
    case 'touches': {
      for (const f of input.files) {
        const glob = matchesAny(rule.globs, f)
        if (glob) return `touches ${glob}: ${f}`
      }
      return null
    }
    case 'diffLinesOver':
      return input.lines > rule.n ? `diff is ${input.lines} lines, over ${rule.n}` : null
    case 'fixRoundsExhausted':
      return input.fixRoundsExhausted ? 'review fix rounds exhausted' : null
    case 'filesOutsideBeadScope': {
      const scopes = input.beads.flatMap((b) => input.beadScopes[b] ?? [])
      if (scopes.length === 0) return null
      const outside = input.files.filter((f) => matchesAny(scopes, f) === null)
      return outside.length > 0 ? `files outside bead scope: ${outside.slice(0, 5).join(', ')}` : null
    }
  }
}

export function downgradeReason(rules: Downgrade[], input: DowngradeInput): string | null {
  for (const rule of rules) {
    const reason = ruleReason(rule, input)
    if (reason) return reason
  }
  return null
}

export function currentVerdicts(verdicts: GateVerdict[], head: string): GateVerdict[] {
  return verdicts.filter((v) => v.head === head)
}
