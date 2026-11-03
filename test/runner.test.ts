import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Runner } from '../src/runner.ts'
import { StateStore } from '../src/store.ts'
import { realFs } from '../src/fs.ts'
import type { EpicPolicy, RunnerState } from '../src/types.ts'
import { FakeWorld, greenCheck } from './fake-world.ts'

const SHA1 = '1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const SHA2 = '2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const HEAD1 = 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1'
const HEAD2 = 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2'
const SID1 = '00000000-0000-4000-8000-000000000001'
const SID2 = '00000000-0000-4000-8000-000000000002'

async function ticks(r: Runner, n: number): Promise<RunnerState> {
  for (let i = 0; i < n; i++) await r.tick()
  return r.mustState()
}

async function startedBead(w: FakeWorld, policy: EpicPolicy = w.policy()): Promise<Runner> {
  const r = new Runner(policy, w.deps())
  await ticks(r, 2)
  return r
}

function events(w: FakeWorld): Array<{ type: string } & Record<string, unknown>> {
  return readFileSync(join(w.stateRoot, 'bd-43aa7', 'events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
}

describe('bead lifecycle', () => {
  it('happy path: start a fresh worker, verify done, commit, then hand the wave to no-mistakes', async () => {
    const w = new FakeWorld()
    const r = await startedBead(w)
    const st = r.mustState()
    expect(st.beads['bd-43aa7.1']).toEqual({ s: 'working', sessionId: SID1, pane: 'w1:p1', startedAt: w.clock, restarts: 0 })

    const create = w.herdrCalls('workspace create')[0]
    expect(create?.args).toEqual(['--session', 'epic', 'workspace', 'create', '--cwd', w.worktree, '--label', 'epic bd-43aa7', '--no-focus'])
    expect(w.agent()?.args).toEqual([
      '--session-id', SID1, '--permission-mode', 'auto', '--model', 'sonnet', '--settings', join(w.worktree, '.epic-runner', 'settings.json'),
    ])
    const order = w.calls.filter((c) => c.cmd === 'herdr').map((c) => `${c.args[2]} ${c.args[3]} ${c.args[5] ?? ''}`.trim())
    expect(order.slice(order.indexOf('agent start --kind'))).toEqual([
      'agent start --kind',
      'agent send-keys esc',
      expect.stringMatching(/^agent prompt Follow the bead brief at /),
    ])
    const settings = JSON.parse(readFileSync(join(w.worktree, '.epic-runner', 'settings.json'), 'utf8'))
    expect(settings.sandbox).toEqual({ enabled: true })
    expect(settings.hooks.PostToolUse[0].hooks[0].command).toContain('EPIC_RUNNER_ROTATE_AT=300000')
    const brief = readFileSync(join(w.worktree, '.epic-runner', 'brief-bd-43aa7.1.md'), 'utf8')
    expect(brief).toContain('## Bead bd-43aa7.1')
    expect(brief).toContain('thread: "bd-43aa7/bd-43aa7.1"')
    expect(brief).toContain(`project_path: "${w.repo}"`)

    w.commits.add(SHA1)
    w.dirty = ['?? .epic-runner/status', '?? .baton/2026-11-03.md']
    w.writeStatus('working: writing the test')
    w.writeStatus(`done sha=${SHA1}`)
    const after = await ticks(r, 1)
    expect(after.beads['bd-43aa7.1']).toEqual({ s: 'committed', sha: SHA1 })
    expect(after.worker).toBeNull()

    w.nmOutputs.push('run:\n  id: r-01\noutcome: passed\n')
    w.pr = { number: 4242, headRefOid: HEAD1, state: 'OPEN', files: ['src/services/skills/skill-registry.ts'], additions: 40, deletions: 12, checks: [greenCheck] }
    const validated = await ticks(r, 2)
    const nm = w.callsTo('no-mistakes', 'axi', 'run')[0]
    expect(nm?.cwd).toBe(w.worktree)
    expect(nm?.args).toEqual(['axi', 'run', '--intent-file', join(w.stateRoot, 'bd-43aa7', 'intent-wave-1.md'), '--yes', '--skip', 'test,document,lint', '--wait', '8m'])
    expect(validated.waves[0]?.state).toEqual({ s: 'pr_open', pr: 4242, head: HEAD1 })
  })

  it('kill: resumes the same session with identical flags and a restart note', async () => {
    const w = new FakeWorld()
    const r = await startedBead(w)
    const firstArgs = w.agent()?.args ?? []
    w.panes.set('w1:p1', null)
    const st = await ticks(r, 1)
    const resumed = w.agent()?.args ?? []
    expect(resumed.slice(0, 2)).toEqual(['--resume', SID1])
    expect(resumed.slice(2)).toEqual(firstArgs.slice(2))
    expect(st.beads['bd-43aa7.1']).toMatchObject({ s: 'working', sessionId: SID1, restarts: 1 })
    const prompts = w.herdrCalls('agent prompt').map((c) => c.args[5])
    expect(prompts.at(-1)).toMatch(/^You were restarted by epic-runner/)
    expect(events(w).some((e) => e.type === 'worker_died')).toBe(true)
  })

  it('stall: a working agent with a stale transcript gets esc then "continue"', async () => {
    const w = new FakeWorld()
    const r = await startedBead(w)
    w.transcript(SID1, 80_000, w.clock)
    w.clock += 9 * 60_000
    const before = w.calls.length
    const st = await ticks(r, 1)
    const sent = w.calls.slice(before).filter((c) => c.cmd === 'herdr' && c.args[2] === 'agent' && c.args[3] !== 'read')
    expect(sent.map((c) => [c.args[3], c.args[5]])).toEqual([
      ['send-keys', 'esc'],
      ['prompt', 'continue'],
    ])
    expect(st.worker?.stallNudges).toBe(1)
  })

  it('blocked: parks the bead, notifies with the pane text, and never sends keys', async () => {
    const w = new FakeWorld()
    const r = await startedBead(w)
    const agent = w.agent()
    if (agent) agent.status = 'blocked'
    w.paneText = 'Bash command\n  touch ~/x\nDo you want to proceed?\n❯ 1. Yes\n  2. No'
    const before = w.calls.length
    const st = await ticks(r, 3)
    const after = w.calls.slice(before)
    expect(after.filter((c) => c.cmd === 'herdr' && ['send-keys', 'prompt'].includes(c.args[3] ?? ''))).toEqual([])
    expect(st.beads['bd-43aa7.1']).toEqual({ s: 'parked', reason: 'blocked on a permission or question dialog' })
    expect(st.halted?.reason).toContain('bd-43aa7.1')
    expect(w.notices).toHaveLength(1)
    expect(w.notices[0]?.body).toContain('Do you want to proceed?')
  })

  it('a status line written while the first prompt is in flight is not skipped', async () => {
    const w = new FakeWorld()
    w.onPrompt = (text) => {
      if (text.includes('bead brief')) w.writeStatus('failed: br blocked by the sandbox')
    }
    const r = new Runner(w.policy(), w.deps())
    const st = await ticks(r, 4)
    expect(st.beads['bd-43aa7.1']).toEqual({ s: 'failed', reason: 'br blocked by the sandbox' })
    expect(w.herdrCalls('agent prompt').some((c) => (c.args[5] ?? '').includes('without a status line'))).toBe(false)
  })

  it('the brief carries the bead and epic text so workers never run br', async () => {
    const w = new FakeWorld()
    await startedBead(w)
    const brief = readFileSync(join(w.worktree, '.epic-runner', 'brief-bd-43aa7.1.md'), 'utf8')
    expect(brief).toContain('## Bead bd-43aa7.1')
    expect(brief).toContain('## Epic bd-43aa7')
    expect(brief).toContain('do not run `br` yourself')
  })

  it('idle without a status line: one nudge, then park and notify', async () => {
    const w = new FakeWorld()
    const r = await startedBead(w)
    const agent = w.agent()
    if (agent) agent.status = 'idle'
    w.clock += 2 * 60_000
    await ticks(r, 1)
    const nudge = w.herdrCalls('agent prompt').at(-1)?.args[5] ?? ''
    expect(nudge).toContain('without a status line')
    if (agent) agent.status = 'idle'
    w.clock += 2 * 60_000
    const st = await ticks(r, 1)
    expect(st.beads['bd-43aa7.1']).toEqual({ s: 'parked', reason: 'idle with no status line after a nudge' })
    expect(w.notices.map((n) => n.subject)).toEqual(['Parked bd-43aa7.1'])
  })

  it('done is rejected on a dirty tree and the worker is told why', async () => {
    const w = new FakeWorld()
    const r = await startedBead(w)
    w.commits.add(SHA1)
    w.dirty = [' M src/services/copilot-channels.ts']
    w.writeStatus(`done sha=${SHA1}`)
    const st = await ticks(r, 1)
    expect(st.beads['bd-43aa7.1']).toMatchObject({ s: 'working' })
    expect(st.worker?.doneRejections).toBe(1)
    expect(w.herdrCalls('agent prompt').at(-1)?.args[5]).toContain('working tree is not clean: src/services/copilot-channels.ts')
  })

  it('needs-decision waits on the owner without nudging, then resumes when the worker wakes', async () => {
    const w = new FakeWorld()
    const r = await startedBead(w)
    w.writeStatus('needs-decision thread=bd-43aa7/bd-43aa7.1: bust on SfAccount or TTL?')
    let st = await ticks(r, 1)
    expect(st.beads['bd-43aa7.1']).toEqual({ s: 'needs_decision', sessionId: SID1, inboxThread: 'bd-43aa7/bd-43aa7.1', since: w.clock })
    const agent = w.agent()
    if (agent) agent.status = 'idle'
    w.clock += 30 * 60_000
    const prompts = w.herdrCalls('agent prompt').length
    st = await ticks(r, 2)
    expect(w.herdrCalls('agent prompt').length).toBe(prompts)
    if (agent) agent.status = 'working'
    st = await ticks(r, 1)
    expect(st.beads['bd-43aa7.1']).toMatchObject({ s: 'working', sessionId: SID1 })
  })
})

describe('rotation', () => {
  it('rotate line: stops the agent and starts a fresh session with /baton grab in the same pane', async () => {
    const w = new FakeWorld()
    const r = await startedBead(w)
    w.writeStatus('rotate baton=.baton/2026-11-03-bd-43aa7.1.md')
    const st = await ticks(r, 1)
    expect(w.herdrCalls('agent prompt').map((c) => c.args[5])).toContain('/exit')
    expect(w.agent()?.args.slice(0, 2)).toEqual(['--session-id', SID2])
    expect(w.herdrCalls('agent prompt').at(-1)?.args[5]).toMatch(/^\/baton grab\n\nAfter grabbing, follow the brief at /)
    expect(st.beads['bd-43aa7.1']).toMatchObject({ s: 'working', sessionId: SID2, pane: 'w1:p1' })
  })

  it('at 1.3x the threshold the runner interrupts and prompts the drop itself, once', async () => {
    const w = new FakeWorld()
    const r = await startedBead(w)
    w.transcript(SID1, 400_000, w.clock)
    await ticks(r, 2)
    const prompts = w.herdrCalls('agent prompt').map((c) => c.args[5] ?? '')
    expect(prompts.filter((p) => p.includes('/baton drop'))).toHaveLength(1)
    expect(events(w).some((e) => e.type === 'tokens' && e.tokens === 400_000)).toBe(true)
  })

  it('death past the threshold with no baton: fresh session grabbing the dead transcript', async () => {
    const w = new FakeWorld()
    const r = await startedBead(w)
    w.transcript(SID1, 350_000, w.clock)
    w.panes.set('w1:p1', null)
    await ticks(r, 1)
    expect(w.agent()?.args.slice(0, 2)).toEqual(['--session-id', SID2])
    expect(w.herdrCalls('agent prompt').at(-1)?.args[5]).toMatch(new RegExp(`^/baton grab ${SID1}\\n`))
  })
})

describe('restart from persisted state', () => {
  it('a new runner resumes mid-epic without redoing a committed bead', async () => {
    const w = new FakeWorld()
    const policy = w.policy({ waves: [['bd-43aa7.1', 'bd-43aa7.2']] })
    const store = new StateStore(realFs, w.stateRoot, 'bd-43aa7', () => w.clock)
    await store.save({
      version: 1,
      epicId: 'bd-43aa7',
      createdAt: 1,
      prepared: true,
      beads: { 'bd-43aa7.1': { s: 'committed', sha: SHA1 }, 'bd-43aa7.2': { s: 'queued' } },
      waves: [{ beads: ['bd-43aa7.1', 'bd-43aa7.2'], onPass: 'stop_at_pr', state: { s: 'building' }, fixRounds: 0, gatingSince: null, nmStarted: false }],
      workspace: { id: 'w1', pane: 'w1:p1' },
      worker: null,
      halted: null,
      done: false,
    })
    w.panes.set('w1:p1', null)
    const st = await ticks(new Runner(policy, w.deps()), 1)
    expect(st.beads['bd-43aa7.1']).toEqual({ s: 'committed', sha: SHA1 })
    expect(st.beads['bd-43aa7.2']).toMatchObject({ s: 'working', sessionId: SID1 })
    expect(w.herdrCalls('workspace create')).toHaveLength(0)
    const prompts = w.herdrCalls('agent prompt').map((c) => c.args[5] ?? '')
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('brief-bd-43aa7.2.md')
  })
})

function gatingState(w: FakeWorld, onPass: 'merge' | 'stop_at_pr'): RunnerState {
  return {
    version: 1,
    epicId: 'bd-43aa7',
    createdAt: 1,
    prepared: true,
    beads: { 'bd-43aa7.1': { s: 'committed', sha: SHA1 } },
    waves: [{ beads: ['bd-43aa7.1'], onPass, state: { s: 'pr_open', pr: 4242, head: HEAD1 }, fixRounds: 0, gatingSince: null, nmStarted: true }],
    workspace: { id: 'w1', pane: 'w1:p1' },
    worker: null,
    halted: null,
    done: false,
  }
}

async function gatingRunner(w: FakeWorld, onPass: 'merge' | 'stop_at_pr', gates: unknown[], downgrades?: unknown[]) {
  const policy = w.policy({ onPass, gates, ...(downgrades ? { downgradeToStopIf: downgrades } : {}) })
  await new StateStore(realFs, w.stateRoot, 'bd-43aa7', () => w.clock).save(gatingState(w, onPass))
  return new Runner(policy, w.deps())
}

const review = { kind: 'review', skill: 'p:thermonuclear-code-quality-review', model: 'opus', passWhen: { maxSeverity: 'minor' }, fixLoop: { model: 'sonnet', maxRounds: 3 } }
const reviewOut = (severity: string) =>
  JSON.stringify({ type: 'result', is_error: false, total_cost_usd: 0.5, usage: { input_tokens: 5, output_tokens: 3000, cache_read_input_tokens: 300000, cache_creation_input_tokens: 80000 }, structured_output: { findings: [{ severity, file: 'src/services/render-api.ts', line: 12, summary: 'cache never invalidates' }] } })

describe('merge gates', () => {
  it('a verdict for an older head is void once the PR head moves', async () => {
    const w = new FakeWorld()
    w.pr = { number: 4242, headRefOid: HEAD1, state: 'OPEN', files: ['src/services/render-api.ts'], additions: 10, deletions: 2, checks: [{ ...greenCheck, status: 'IN_PROGRESS', conclusion: null }] }
    w.reviewOutputs.push(reviewOut('nit'))
    const r = await gatingRunner(w, 'merge', [{ kind: 'linear_on_base' }, { kind: 'ci_green_at_head' }])
    let st = await ticks(r, 2)
    const g = st.waves[0]?.state
    expect(g?.s === 'gating' && g.verdicts.map((v) => [v.gate, v.head, v.pass])).toEqual([['linear_on_base', HEAD1, true]])
    w.pr.headRefOid = HEAD2
    st = await ticks(r, 1)
    expect(st.waves[0]?.state).toEqual({ s: 'gating', pr: 4242, head: HEAD2, verdicts: [] })
    expect(events(w).find((e) => e.type === 'verdicts_voided')).toMatchObject({ from: HEAD1, to: HEAD2, voided: 1 })
  })

  it('a downgrade rule forces stop_at_pr even when every gate passes and policy says merge', async () => {
    const w = new FakeWorld()
    w.pr = { number: 4242, headRefOid: HEAD1, state: 'OPEN', files: ['src/auth/clerk-user-email-cache.ts', 'oxlint-suppressions.json'], additions: 30, deletions: 20, checks: [greenCheck] }
    const r = await gatingRunner(w, 'merge', [{ kind: 'ci_green_at_head' }, { kind: 'linear_on_base' }], [{ kind: 'touches', globs: ['src/auth/**'] }])
    const st = await ticks(r, 3)
    expect(st.waves[0]?.state).toEqual({ s: 'stopped_at_pr', pr: 4242, why: 'downgraded: touches src/auth/**: src/auth/clerk-user-email-cache.ts' })
    expect(w.callsTo('gh', 'pr', 'merge')).toHaveLength(0)
    expect(w.notices.map((n) => n.subject)).toEqual(['PR #4242 stopped at PR'])
  })

  it('merges serially with --match-head-commit at the gated head, then rebases the epic branch', async () => {
    const w = new FakeWorld()
    w.pr = { number: 4242, headRefOid: HEAD1, state: 'OPEN', files: ['src/services/render-api.ts'], additions: 30, deletions: 20, checks: [greenCheck] }
    w.reviewOutputs.push(reviewOut('minor'))
    const r = await gatingRunner(w, 'merge', [{ kind: 'ci_green_at_head' }, { kind: 'linear_on_base' }, review])
    const st = await ticks(r, 4)
    expect(w.callsTo('gh', 'pr', 'merge').map((c) => c.args)).toEqual([['pr', 'merge', '4242', '--rebase', '--match-head-commit', HEAD1]])
    expect(st.waves[0]?.state).toEqual({ s: 'merged', pr: 4242, sha: w.baseSha })
    expect(w.callsTo('git', 'rebase').map((c) => c.args)).toEqual([['rebase', 'origin/master']])
    const rev = w.callsTo('claude', '-p')[0]
    expect(rev?.args.slice(0, 3)).toEqual(['-p', '--model', 'opus'])
    expect(rev?.args.at(-1)).toMatch(/^\/p:thermonuclear-code-quality-review /)
    expect(events(w).find((e) => e.type === 'review_verdict')).toMatchObject({ tokens: 383005, pass: true, head: HEAD1 })
    const done = await ticks(r, 1)
    expect(done.done).toBe(true)
    expect(w.notices.map((n) => n.subject)).toEqual(['Merged PR #4242', 'Epic bd-43aa7 done'])
  })

  it('a failed review starts a fix worker with the findings, then re-validates through no-mistakes', async () => {
    const w = new FakeWorld()
    w.pr = { number: 4242, headRefOid: HEAD1, state: 'OPEN', files: ['src/services/render-api.ts'], additions: 30, deletions: 20, checks: [greenCheck] }
    w.reviewOutputs.push(reviewOut('major'))
    const r = await gatingRunner(w, 'merge', [{ kind: 'ci_green_at_head' }, review])
    let st = await ticks(r, 2)
    expect(st.worker?.job).toEqual({ kind: 'fix', wave: 0, round: 1 })
    expect(w.agent()?.args.slice(2, 6)).toEqual(['--permission-mode', 'auto', '--model', 'sonnet'])
    const brief = readFileSync(join(w.worktree, '.epic-runner', 'brief-fix-w1-r1.md'), 'utf8')
    expect(brief).toContain('[major] src/services/render-api.ts:12 cache never invalidates')
    w.commits.add(SHA2)
    w.writeStatus(`done sha=${SHA2}`)
    st = await ticks(r, 1)
    expect(st.worker).toBeNull()
    expect(st.waves[0]?.state).toEqual({ s: 'validating', nmRun: '' })
    expect(st.waves[0]?.fixRounds).toBe(1)
  })
})

describe('tick errors', () => {
  it('a failing command is logged, and a second consecutive failure halts with a notice', async () => {
    const w = new FakeWorld()
    const r = await gatingRunner(w, 'merge', [{ kind: 'ci_green_at_head' }])
    w.pr = null
    await r.tick()
    const first = await r.tick()
    expect(first.progressed).toBe(false)
    expect(r.mustState().halted).toBeNull()
    await r.tick()
    expect(r.mustState().halted?.reason).toMatch(/^tick failed twice: gh pr view 4242/)
    expect(events(w).filter((e) => e.type === 'tick_error')).toHaveLength(2)
    expect(w.notices.map((n) => n.subject)).toEqual(['epic-runner halted on bd-43aa7'])
  })
})
