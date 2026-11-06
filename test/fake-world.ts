import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExecRequest, ExecResult } from '../src/exec.ts'
import type { Notice } from '../src/notifier.ts'
import { parsePolicyText } from '../src/policy.ts'
import type { RunnerDeps } from '../src/context.ts'
import { projectSlug } from '../src/transcript.ts'
import type { EpicPolicy } from '../src/types.ts'

type FakeAgent = { status: 'idle' | 'working' | 'blocked' | 'done'; sessionId: string; args: string[] }
type FakePr = { number: number; headRefOid: string; state: 'OPEN' | 'CLOSED' | 'MERGED'; files: string[]; additions: number; deletions: number; checks: unknown[] }

const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '', timedOut: false })
const herdrErr = (code: string, message: string): ExecResult => ({
  code: 1,
  stdout: '',
  stderr: JSON.stringify({ error: { code, message }, id: 'cli' }),
  timedOut: false,
})

export class FakeWorld {
  readonly root = mkdtempSync(join(tmpdir(), 'er-world-'))
  readonly repo = join(this.root, 'terra')
  readonly worktree = join(this.repo, '.claude', 'worktrees', 'epic-bd-43aa7')
  readonly stateRoot = join(this.root, 'state')
  readonly projectsDir = join(this.root, 'claude-projects')
  readonly calls: ExecRequest[] = []
  readonly notices: Notice[] = []
  clock = 1_800_000_000_000
  panes = new Map<string, FakeAgent | null>()
  workspaces = 0
  promptStalls = 0
  nmExit: { code: number; stderr: string } | null = null
  startBusy = 0
  onPrompt: ((text: string) => void) | null = null
  paneText = ''
  commits = new Set<string>()
  dirty: string[] = []
  unpublished: string[] = []
  merges: string[] = []
  baseSha = 'f00dfeed0000000000000000000000000000beef'
  nmOutputs: string[] = []
  reviewOutputs: string[] = []
  pr: FakePr | null = null
  herdrDown = false
  serverStartFails = false
  serverStarts = 0
  nextHerdrError: string | null = null
  private uuids = 0

  constructor() {
    mkdirSync(this.worktree, { recursive: true })
  }

  policy(extra: Record<string, unknown> = {}): EpicPolicy {
    return parsePolicyText(
      JSON.stringify({
        epicId: 'bd-43aa7',
        repo: this.repo,
        branch: 'epic/bd-43aa7',
        onPass: 'stop_at_pr',
        waves: [['bd-43aa7.1']],
        gates: [],
        ...extra,
      }),
      'policy.json',
    )
  }

  deps(): RunnerDeps {
    return {
      exec: async (req) => {
        this.calls.push(req)
        return this.handle(req)
      },
      now: () => this.clock,
      sleep: async (ms) => {
        this.clock += ms
      },
      uuid: () => `00000000-0000-4000-8000-${String(++this.uuids).padStart(12, '0')}`,
      stateRoot: this.stateRoot,
      claudeProjectsDir: this.projectsDir,
      nmConfigPath: join(this.root, 'nm', 'config.yaml'),
      hookPath: '/opt/epic-runner/hooks/rotate.sh',
      resumeCommand: 'bun run /opt/epic-runner/src/cli.ts resume /work/policy.json',
      notifier: { send: async (n) => void this.notices.push(n) },
      quota: async () => ({ ok: true }),
      startServer: async () => {
        this.serverStarts++
        if (this.serverStartFails) return { ok: false, message: 'fake: herdr server failed to start' }
        this.herdrDown = false
        this.panes = new Map()
        return { ok: true }
      },
    }
  }

  get statusFile(): string {
    return join(this.worktree, '.epic-runner', 'status')
  }

  writeStatus(line: string): void {
    mkdirSync(join(this.worktree, '.epic-runner'), { recursive: true })
    appendFileSync(this.statusFile, `${line}\n`)
  }

  transcript(sessionId: string, tokens: number, mtime: number): void {
    const dir = join(this.projectsDir, projectSlug(this.worktree))
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `${sessionId}.jsonl`)
    const line = { type: 'assistant', isSidechain: false, message: { usage: { input_tokens: 0, cache_read_input_tokens: tokens, cache_creation_input_tokens: 0, output_tokens: 10 } } }
    writeFileSync(path, `${JSON.stringify(line)}\n`)
    utimesSync(path, mtime / 1000, mtime / 1000)
  }

  agent(pane = 'w1:p1'): FakeAgent | null {
    return this.panes.get(pane) ?? null
  }

  herdrCalls(sub: string): ExecRequest[] {
    return this.calls.filter((c) => c.cmd === 'herdr' && `${c.args[2]} ${c.args[3]}` === sub)
  }

  callsTo(cmd: string, ...prefix: string[]): ExecRequest[] {
    return this.calls.filter((c) => c.cmd === cmd && prefix.every((p, i) => c.args[i] === p))
  }

  private handle(req: ExecRequest): ExecResult {
    switch (req.cmd) {
      case 'herdr':
        return this.herdr(req.args.slice(2))
      case 'git':
        return this.git(req.args)
      case 'gh':
        return this.gh(req.args)
      case 'no-mistakes':
      {
        const out = ok(this.nmOutputs.shift() ?? 'run:\n  id: r-idle\n  status: running\n')
        if (!this.nmExit) return out
        const exit = this.nmExit
        this.nmExit = null
        return { ...out, code: exit.code, stderr: exit.stderr }
      }
      case 'claude':
        return ok(this.reviewOutputs.shift() ?? '')
      case 'br':
        return ok('[]')
      default:
        return { code: 127, stdout: '', stderr: `fake: no ${req.cmd}`, timedOut: false }
    }
  }

  private herdr(a: string[]): ExecResult {
    if (this.herdrDown) {
      return herdrErr('server_not_running', 'no herdr server is running at /tmp/fake.sock; run `herdr session attach epic` to start or attach it')
    }
    if (this.nextHerdrError) return herdrErr(this.nextHerdrError, 'injected herdr error')
    const [group, sub] = a
    if (group === 'status' && sub === 'server') return ok('running\n')
    const target = group === 'agent' && sub === 'start' ? a[a.indexOf('--pane') + 1] : a[2]
    if (group === 'workspace' && sub === 'close') {
      this.panes.delete(`${a[2]}:p1`)
      return ok('{}')
    }
    if (group === 'workspace' && sub === 'create') {
      const n = ++this.workspaces
      this.panes.set(`w${n}:p1`, null)
      return ok(JSON.stringify({ result: { type: 'workspace_created', workspace: { workspace_id: `w${n}` }, tab: { tab_id: `w${n}:t1` }, root_pane: { pane_id: `w${n}:p1` } } }))
    }
    if (target === undefined || !this.panes.has(target)) {
      return group === 'pane' ? herdrErr('pane_not_found', `pane ${target} not found`) : herdrErr('agent_not_found', `agent target ${target} not found`)
    }
    const agent = this.panes.get(target) ?? null
    if (group === 'pane' && sub === 'get') {
      const pane = agent
        ? { pane_id: target, agent: 'claude', agent_status: agent.status, agent_session: { agent: 'claude', kind: 'id', source: 'herdr:claude', value: agent.sessionId } }
        : { pane_id: target, agent: null, agent_status: 'unknown' }
      return ok(JSON.stringify({ id: 'cli:pane:get', result: { pane, type: 'pane_info' } }))
    }
    if (group === 'agent' && sub === 'start') {
      if (this.startBusy > 0) {
        this.startBusy--
        return herdrErr('agent_pane_busy', `agent target pane ${target} is not an available shell`)
      }
      const dash = a.indexOf('--')
      const args = a.slice(dash + 1)
      const sid = args[args.indexOf('--session-id') + 1] ?? args[args.indexOf('--resume') + 1] ?? ''
      this.panes.set(target, { status: 'idle', sessionId: sid, args })
      return ok(JSON.stringify({ result: { type: 'agent_started' } }))
    }
    if (!agent) return herdrErr('agent_not_found', `agent target ${target} not found`)
    if (group === 'agent' && sub === 'send-keys') return ok('{}')
    if (group === 'agent' && sub === 'read') return ok(this.paneText)
    if (group === 'agent' && sub === 'prompt') {
      if (a[3] === '/exit') {
        this.panes.set(target, null)
        return ok('{}')
      }
      if (agent.status === 'blocked') return herdrErr('agent_blocked', 'agent is blocked')
      if (this.promptStalls > 0) {
        this.promptStalls--
        return herdrErr('agent_prompt_stalled', 'no activity observed')
      }
      agent.status = 'working'
      this.onPrompt?.(a[3] ?? '')
      return ok('{}')
    }
    return herdrErr('unsupported', a.join(' '))
  }

  private git(a: string[]): ExecResult {
    const fail = { code: 1, stdout: '', stderr: '', timedOut: false }
    switch (a[0]) {
      case 'cat-file':
        return this.commits.has((a[2] ?? '').replace('^{commit}', '')) ? ok() : fail
      case 'merge-base':
        return this.commits.has(a[2] ?? '') ? ok() : fail
      case 'status':
        return ok(this.dirty.map((d) => `${d}\n`).join(''))
      case 'log':
        return ok(this.merges.join('\n'))
      case 'rev-parse':
        return ok(`${this.baseSha}\n`)
      case 'cherry':
        return ok(this.unpublished.map((c) => `+ ${c}\n`).join(''))
      default:
        return ok()
    }
  }

  private gh(a: string[]): ExecResult {
    const pr = this.pr
    if (a[0] === 'pr' && a[1] === 'view') {
      if (!pr) return { code: 1, stdout: '', stderr: 'no pull requests found', timedOut: false }
      return ok(JSON.stringify({ number: pr.number, headRefOid: pr.headRefOid, state: pr.state, url: `https://github.com/clay-run/terra/pull/${pr.number}`, statusCheckRollup: pr.checks, additions: pr.additions, deletions: pr.deletions }))
    }
    if (a[0] === 'pr' && a[1] === 'diff' && pr) return ok(pr.files.join('\n'))
    if (a[0] === 'pr' && a[1] === 'merge' && pr) {
      pr.state = 'MERGED'
      return ok()
    }
    return { code: 1, stdout: '', stderr: 'fake gh: unsupported', timedOut: false }
  }
}

export const greenCheck = { __typename: 'CheckRun', name: 'backend-tests', status: 'COMPLETED', conclusion: 'SUCCESS', workflowName: 'CI' }
