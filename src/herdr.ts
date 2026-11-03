import { z } from 'zod'
import type { Exec, ExecRequest, ExecResult } from './exec.ts'
import type { AgentObservation, HerdrAgentStatus } from './liveness.ts'

const ErrorEnvelopeSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) })

const AgentStatusSchema = z.enum(['idle', 'working', 'blocked', 'done', 'unknown'])

const PaneSchema = z.object({
  pane_id: z.string(),
  agent: z.string().nullable().optional(),
  agent_status: z.string().optional(),
  agent_session: z.object({ value: z.string() }).nullable().optional(),
})

const PaneGetSchema = z.object({ result: z.object({ pane: PaneSchema }) })
const WorkspaceCreateSchema = z.object({
  result: z.object({ workspace: z.object({ workspace_id: z.string() }), root_pane: z.object({ pane_id: z.string() }) }),
})

export type WorkerLaunch =
  | { mode: 'new'; sessionId: string }
  | { mode: 'resume'; sessionId: string }

export type WorkerFlags = { model: string; settingsPath: string }

export function claudeWorkerArgs(launch: WorkerLaunch, flags: WorkerFlags): string[] {
  const session = launch.mode === 'new' ? ['--session-id', launch.sessionId] : ['--resume', launch.sessionId]
  return [...session, '--permission-mode', 'auto', '--model', flags.model, '--settings', flags.settingsPath]
}

export type StartResult = { ok: true } | { ok: false; code: string; message: string }
export type PromptResult = { ok: true; recovered: boolean } | { ok: false; code: string; message: string }

export function agentName(sessionId: string): string {
  return `er-${sessionId.replace(/[^a-z0-9]/g, '').slice(0, 12)}`
}

function herdrError(r: ExecResult): { code: string; message: string } {
  for (const text of [r.stderr, r.stdout]) {
    for (const line of text.split('\n')) {
      try {
        const parsed = ErrorEnvelopeSchema.safeParse(JSON.parse(line))
        if (parsed.success) return parsed.data.error
      } catch {}
    }
  }
  return { code: r.timedOut ? 'timeout' : `exit_${r.code}`, message: (r.stderr || r.stdout).trim().slice(0, 300) }
}

const BUSY_PANE_RETRY_MS = 3_000
const BUSY_PANE_MAX_ATTEMPTS = 20

export class Herdr {
  constructor(
    private readonly exec: Exec,
    private readonly session: string,
    private readonly sleep: (ms: number) => Promise<void>,
  ) {}

  private call(args: string[], timeoutMs = 60_000): Promise<ExecResult> {
    const req: ExecRequest = { cmd: 'herdr', args: ['--session', this.session, ...args], timeoutMs }
    return this.exec(req)
  }

  async createWorkspace(cwd: string, label: string): Promise<{ workspaceId: string; paneId: string }> {
    const r = await this.call(['workspace', 'create', '--cwd', cwd, '--label', label, '--no-focus'])
    if (r.code !== 0) throw new Error(`herdr workspace create failed: ${herdrError(r).message}`)
    const parsed = WorkspaceCreateSchema.parse(JSON.parse(r.stdout))
    return { workspaceId: parsed.result.workspace.workspace_id, paneId: parsed.result.root_pane.pane_id }
  }

  async observe(pane: string): Promise<AgentObservation> {
    const r = await this.call(['pane', 'get', pane])
    if (r.code !== 0) {
      const err = herdrError(r)
      if (err.code === 'pane_not_found') return { k: 'pane_missing' }
      throw new Error(`herdr pane get ${pane} failed: ${err.code} ${err.message}`)
    }
    const pane_ = PaneGetSchema.parse(JSON.parse(r.stdout)).result.pane
    if (!pane_.agent) return { k: 'dead' }
    const status = AgentStatusSchema.safeParse(pane_.agent_status)
    return { k: 'live', status: status.success ? status.data : ('unknown' satisfies HerdrAgentStatus) }
  }

  async startClaude(pane: string, sessionId: string, claudeArgs: string[]): Promise<StartResult> {
    const args = ['agent', 'start', agentName(sessionId), '--kind', 'claude', '--pane', pane, '--timeout', '60000', '--', ...claudeArgs]
    let r = await this.call(args, 90_000)
    for (let attempt = 1; r.code !== 0 && attempt < BUSY_PANE_MAX_ATTEMPTS && herdrError(r).code === 'agent_pane_busy'; attempt++) {
      await this.sleep(BUSY_PANE_RETRY_MS)
      r = await this.call(args, 90_000)
    }
    if (r.code !== 0) return { ok: false, ...herdrError(r) }
    await this.sendKeys(pane, ['esc'])
    return { ok: true }
  }

  async sendKeys(pane: string, keys: string[]): Promise<void> {
    const r = await this.call(['agent', 'send-keys', pane, ...keys])
    if (r.code !== 0) throw new Error(`herdr send-keys ${pane} failed: ${herdrError(r).message}`)
  }

  async prompt(pane: string, text: string): Promise<PromptResult> {
    const r = await this.call(['agent', 'prompt', pane, text, '--wait', '--timeout', '20000'], 30_000)
    if (r.code === 0) return { ok: true, recovered: false }
    const err = herdrError(r)
    if (err.code === 'timeout') return { ok: true, recovered: false }
    if (err.code !== 'agent_prompt_stalled') return { ok: false, ...err }
    await this.sendKeys(pane, ['esc'])
    await this.sendKeys(pane, ['enter'])
    await this.sleep(3_000)
    const after = await this.observe(pane)
    if (after.k === 'live' && (after.status === 'working' || after.status === 'blocked')) return { ok: true, recovered: true }
    return { ok: false, code: 'agent_prompt_stalled', message: 'prompt stalled; esc+enter did not start a turn' }
  }

  async readPane(pane: string, source: 'visible' | 'recent-unwrapped', lines = 80): Promise<string> {
    const r = await this.call(['agent', 'read', pane, '--source', source, '--lines', String(lines)])
    return r.code === 0 ? r.stdout : ''
  }

  async stopAgent(pane: string): Promise<boolean> {
    await this.call(['agent', 'prompt', pane, '/exit'])
    for (const fallback of [false, true]) {
      if (fallback) await this.call(['agent', 'send-keys', pane, 'ctrl+c', 'ctrl+c'])
      for (let i = 0; i < 10; i++) {
        const o = await this.observe(pane)
        if (o.k !== 'live') return true
        await this.sleep(1_000)
      }
    }
    return false
  }
}
