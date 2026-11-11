import { describe, expect, it } from 'bun:test'
import { beadBrief } from '../src/brief.ts'

const brief = beadBrief({
  beadId: 'bd-1.2',
  epicId: 'bd-1',
  branch: 'epic/bd-1',
  repoRoot: '/repo',
  worktree: '/repo/.claude/worktrees/epic-bd-1',
  statusFile: '/repo/.claude/worktrees/epic-bd-1/.epic-runner/status',
  inboxThread: 'bd-1/bd-1.2',
  beadText: 'do the thing',
  epicText: 'the epic',
})

describe('E2 escalation template in the bead brief', () => {
  it('allows a question only on disagreement with a recorded rule or bead instruction', () => {
    expect(brief).toContain('Ask only when you disagree with a recorded rule or a bead instruction')
    expect(brief).toContain('"I feel it is right" is not a reason.')
  })

  it('pins the four parts and their order', () => {
    const parts = ['**The rule.**', '**What I found.**', '**Why this case differs.**', '**My proposal.**']
    const at = parts.map((p) => brief.indexOf(p))
    expect(at.every((i) => i > 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    expect(brief).toContain('with its date')
    expect(brief).toContain('`file:line`')
    expect(brief).toContain('what the rule assumed that is not true here')
    expect(brief).toContain('what you will do if the owner does not answer (the default)')
  })

  it('rejects a menu-only question and does not restate the rule', () => {
    expect(brief).toContain('A question that is only a menu')
    expect(brief).toContain('is rejected: do not send it.')
    expect(brief).toContain('name the doc by path')
    expect(brief).toContain('/repo/.claude/worktrees/epic-bd-1/.epic-runner/decisions.md')
  })

  it('keeps the deferred status line and the old item 6/7 wording is gone', () => {
    expect(brief).toContain('`deferred: <what is waiting>`')
    expect(brief).toContain('A skipped question is not a failure.')
    expect(brief).not.toContain('A question is allowed only for a one-way door')
    expect(brief).not.toContain('so the owner can answer in one click')
  })
})
