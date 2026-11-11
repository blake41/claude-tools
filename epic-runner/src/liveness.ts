import type { TerminalStatusLine } from './status-protocol.ts'
import type { WorkerRun } from './types.ts'

export type HerdrAgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown'

export type AgentObservation = { k: 'pane_missing' } | { k: 'dead' } | { k: 'live'; status: HerdrAgentStatus }

export type Observation = {
  now: number
  terminal: TerminalStatusLine | null
  agent: AgentObservation
  transcriptMtime: number | null
  tokens: number | null
  paneText: string | null
  waitingOnOwner: boolean
}

export type LivenessConfig = {
  stallMs: number
  idleGraceMs: number
  rotateAtTokens: number
  maxRestarts: number
  maxStallNudges: number
}

export type LivenessAction =
  | { a: 'status'; line: TerminalStatusLine }
  | { a: 'restart'; mode: 'resume' | 'grab' }
  | { a: 'park'; reason: string; paneText: string | null; notify: 'blocked' | 'parked' }
  | { a: 'rotate_interrupt' }
  | { a: 'stall_nudge'; apiError: boolean }
  | { a: 'protocol_nudge' }
  | { a: 'wait' }

const API_ERROR = /API Error|overloaded|\b529\b|\b5\d\d\b.*error|rate limit|Request timed out|ECONNRESET|socket hang up/i
const API_BACKOFF_BASE_MS = 60_000

export const ROTATE_INTERRUPT_FACTOR = 1.3

export function hasApiError(paneText: string | null): boolean {
  return paneText !== null && API_ERROR.test(paneText)
}

export function needsPaneText(o: Pick<Observation, 'now' | 'agent' | 'transcriptMtime'>, run: WorkerRun, cfg: LivenessConfig): boolean {
  if (o.agent.k !== 'live') return false
  if (o.agent.status === 'blocked') return true
  return isStalled(o, run, cfg)
}

function isStalled(o: Pick<Observation, 'now' | 'agent' | 'transcriptMtime'>, run: WorkerRun, cfg: LivenessConfig): boolean {
  if (o.agent.k !== 'live' || (o.agent.status !== 'working' && o.agent.status !== 'unknown')) return false
  return o.now - activityRef(o.transcriptMtime, run) > cfg.stallMs
}

function activityRef(transcriptMtime: number | null, run: WorkerRun): number {
  return Math.max(transcriptMtime ?? run.startedAt, run.lastPromptAt)
}

export function decide(o: Observation, run: WorkerRun, cfg: LivenessConfig): LivenessAction {
  if (o.terminal) return { a: 'status', line: o.terminal }

  if (o.agent.k === 'dead' || o.agent.k === 'pane_missing') {
    if (run.restarts >= cfg.maxRestarts) {
      return { a: 'park', reason: `agent died ${run.restarts + 1} times`, paneText: null, notify: 'parked' }
    }
    return { a: 'restart', mode: (o.tokens ?? 0) >= cfg.rotateAtTokens ? 'grab' : 'resume' }
  }

  const status = o.agent.status
  if (status === 'blocked') {
    return { a: 'park', reason: 'blocked on a permission or question dialog', paneText: o.paneText, notify: 'blocked' }
  }

  if (!run.rotateRequested && (o.tokens ?? 0) >= cfg.rotateAtTokens * ROTATE_INTERRUPT_FACTOR) return { a: 'rotate_interrupt' }

  switch (status) {
    case 'working':
    case 'unknown': {
      if (!isStalled(o, run, cfg)) return { a: 'wait' }
      if (run.stallNudges >= cfg.maxStallNudges) {
        return { a: 'park', reason: `stalled after ${run.stallNudges} nudges`, paneText: o.paneText, notify: 'parked' }
      }
      const apiError = hasApiError(o.paneText)
      if (apiError) {
        const backoff = API_BACKOFF_BASE_MS * 2 ** run.stallNudges
        if (o.now - activityRef(o.transcriptMtime, run) <= cfg.stallMs + backoff) return { a: 'wait' }
      }
      return { a: 'stall_nudge', apiError }
    }
    case 'idle':
    case 'done': {
      if (o.waitingOnOwner) return { a: 'wait' }
      if (o.now - run.lastPromptAt < cfg.idleGraceMs) return { a: 'wait' }
      if (!run.protocolNudged) return { a: 'protocol_nudge' }
      return { a: 'park', reason: 'idle with no status line after a nudge', paneText: null, notify: 'parked' }
    }
  }
}
