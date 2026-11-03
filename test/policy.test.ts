import { describe, expect, it } from 'bun:test'
import { parsePolicyText, DEFAULT_DOWNGRADES } from '../src/policy.ts'

const yaml = `
epicId: bd-43aa7
repo: /Users/blake/Documents/Development/clay/terra
branch: epic/bd-43aa7
onPass: merge
waves:
  - beads: [bd-43aa7.1, bd-43aa7.2]
    onPass: stop_at_pr
  - [bd-43aa7.8]
gates:
  - kind: ci_green_at_head
  - kind: review
    skill: p:thermonuclear-code-quality-review
    model: opus
    passWhen: { maxSeverity: minor }
    fixLoop: { model: sonnet, maxRounds: 3 }
downgradeToStopIf:
  - kind: touches
    globs: ['src/auth/**']
`

describe('parsePolicyText', () => {
  it('parses YAML, normalises waves and fills defaults', () => {
    const p = parsePolicyText(yaml, 'policy.yaml')
    expect(p.waves).toEqual([
      { beads: ['bd-43aa7.1', 'bd-43aa7.2'], onPass: 'stop_at_pr' },
      { beads: ['bd-43aa7.8'], onPass: 'merge' },
    ])
    expect(p.rotateAtTokens).toBe(300_000)
    expect(p.workerModel).toBe('sonnet')
    expect(p.workerSandbox).toBe(true)
    expect(p.base).toBe('master')
    expect(p.herdrSession).toBe('epic')
    expect(p.worktree).toBe('/Users/blake/Documents/Development/clay/terra/.claude/worktrees/epic-bd-43aa7')
    expect(p.gates[1]).toEqual({
      kind: 'review',
      skill: 'p:thermonuclear-code-quality-review',
      model: 'opus',
      passWhen: { maxSeverity: 'minor' },
      fixLoop: { model: 'sonnet', maxRounds: 3 },
    })
  })

  it('uses the PLAN default downgrades when none are given', () => {
    const p = parsePolicyText(
      JSON.stringify({ epicId: 'e', repo: '/r', branch: 'epic/e', onPass: 'stop_at_pr' }),
      'p.json',
    )
    expect(p.downgradeToStopIf).toEqual(DEFAULT_DOWNGRADES)
    expect(p.waves).toEqual([])
  })

  it('splits waves per bead when prUnit is bead and merges them when prUnit is epic', () => {
    const base = { epicId: 'e', repo: '/r', branch: 'b', onPass: 'merge', waves: [['a', 'b'], ['c']] }
    expect(parsePolicyText(JSON.stringify({ ...base, prUnit: 'bead' }), 'p.json').waves.map((w) => w.beads)).toEqual([
      ['a'],
      ['b'],
      ['c'],
    ])
    expect(parsePolicyText(JSON.stringify({ ...base, prUnit: 'epic' }), 'p.json').waves.map((w) => w.beads)).toEqual([
      ['a', 'b', 'c'],
    ])
  })

  it('rejects a relative repo path and an unknown gate kind', () => {
    expect(() => parsePolicyText(JSON.stringify({ epicId: 'e', repo: 'rel', branch: 'b', onPass: 'merge' }), 'p.json')).toThrow(
      /repo/,
    )
    expect(() =>
      parsePolicyText(
        JSON.stringify({ epicId: 'e', repo: '/r', branch: 'b', onPass: 'merge', gates: [{ kind: 'vibes' }] }),
        'p.json',
      ),
    ).toThrow()
  })
})
