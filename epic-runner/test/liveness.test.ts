import { describe, expect, it } from 'bun:test'
import { decide, type Observation } from '../src/liveness.ts'
import type { WorkerRun } from '../src/types.ts'

const cfg = { stallMs: 480_000, idleGraceMs: 60_000, rotateAtTokens: 300_000, maxRestarts: 3, maxStallNudges: 3 }
const T0 = 1_000_000_000

function run(over: Partial<WorkerRun> = {}): WorkerRun {
  return {
    job: { kind: 'bead', beadId: 'bd-43aa7.1' },
    sessionId: 'b7c9fcbc-205d-427d-aee7-d016e6906813',
    pane: 'w1:p1',
    model: 'sonnet',
    startedAt: T0,
    restarts: 0,
    statusCursor: 0,
    lastPromptAt: T0,
    protocolNudged: false,
    stallNudges: 0,
    lastStallNudgeAt: null,
    rotateRequested: false,
    waitingOnOwner: false,
    doneRejections: 0,
    lastTokens: 0,
    ...over,
  }
}

function obs(over: Partial<Observation> = {}): Observation {
  return {
    now: T0 + 120_000,
    terminal: null,
    agent: { k: 'live', status: 'working' },
    transcriptMtime: T0 + 100_000,
    tokens: 61_000,
    paneText: null,
    waitingOnOwner: false,
    ...over,
  }
}

describe('liveness ladder', () => {
  it('a terminal status line wins over every other signal', () => {
    expect(decide(obs({ terminal: { k: 'done', sha: '96a276fa4' }, agent: { k: 'dead' } }), run(), cfg)).toEqual({
      a: 'status',
      line: { k: 'done', sha: '96a276fa4' },
    })
  })

  it('a dead agent is resumed, or grabbed from its transcript past the rotation threshold, and parked after max restarts', () => {
    expect(decide(obs({ agent: { k: 'dead' } }), run(), cfg)).toEqual({ a: 'restart', mode: 'resume' })
    expect(decide(obs({ agent: { k: 'pane_missing' } }), run(), cfg)).toEqual({ a: 'restart', mode: 'resume' })
    expect(decide(obs({ agent: { k: 'dead' }, tokens: 320_000 }), run(), cfg)).toEqual({ a: 'restart', mode: 'grab' })
    expect(decide(obs({ agent: { k: 'dead' } }), run({ restarts: 3 }), cfg)).toMatchObject({ a: 'park', notify: 'parked' })
  })

  it('a blocked dialog parks with the pane text', () => {
    expect(decide(obs({ agent: { k: 'live', status: 'blocked' }, paneText: 'Allow Bash(touch x)?' }), run(), cfg)).toEqual({
      a: 'park',
      reason: 'blocked on a permission or question dialog',
      paneText: 'Allow Bash(touch x)?',
      notify: 'blocked',
    })
  })

  it('interrupts for rotation at 1.3x the threshold, once', () => {
    expect(decide(obs({ tokens: 390_000 }), run(), cfg)).toEqual({ a: 'rotate_interrupt' })
    expect(decide(obs({ tokens: 390_000 }), run({ rotateRequested: true }), cfg)).toEqual({ a: 'wait' })
  })

  it('a working agent with a stale transcript gets a stall nudge; API error text waits for a backoff first', () => {
    const stale = { now: T0 + 520_000, transcriptMtime: T0 + 10_000 }
    expect(decide(obs(stale), run(), cfg)).toEqual({ a: 'stall_nudge', apiError: false })
    expect(decide(obs({ ...stale, paneText: 'API Error: 529 overloaded' }), run(), cfg)).toEqual({ a: 'wait' })
    expect(decide(obs({ now: T0 + 700_000, transcriptMtime: T0, paneText: 'API Error: 529 overloaded' }), run(), cfg)).toEqual({
      a: 'stall_nudge',
      apiError: true,
    })
    expect(decide(obs(stale), run({ stallNudges: 3 }), cfg)).toMatchObject({ a: 'park', notify: 'parked' })
  })

  it('idle without a status line: grace, then one nudge, then park', () => {
    const idle = { agent: { k: 'live', status: 'idle' } as const }
    expect(decide(obs({ ...idle, now: T0 + 30_000 }), run(), cfg)).toEqual({ a: 'wait' })
    expect(decide(obs(idle), run(), cfg)).toEqual({ a: 'protocol_nudge' })
    expect(decide(obs(idle), run({ protocolNudged: true }), cfg)).toEqual({
      a: 'park',
      reason: 'idle with no status line after a nudge',
      paneText: null,
      notify: 'parked',
    })
  })

  it('an agent waiting on an owner decision is left alone while idle', () => {
    expect(decide(obs({ agent: { k: 'live', status: 'idle' }, waitingOnOwner: true }), run(), cfg)).toEqual({ a: 'wait' })
  })
})
