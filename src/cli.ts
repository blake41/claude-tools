#!/usr/bin/env bun
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { RunnerDeps } from './context.ts'
import { dryRunExec, realExec, type ExecRequest, type ExecResult } from './exec.ts'
import { dryRunFs, realFs } from './fs.ts'
import { inboxNotifier } from './notifier.ts'
import { loadPolicy } from './policy.ts'
import { alwaysOk } from './quota.ts'
import { Runner } from './runner.ts'
import { StateStore } from './store.ts'
import type { EpicPolicy } from './types.ts'

const USAGE = `epic-runner <command>

  run <policy> [--dry-run]          tick until the epic is done
  tick <policy> [--dry-run] [--steps N]
                                    one step (dry-run: N steps, nothing executed or written)
  resume <policy>                   clear a halt and re-arm parked beads
  status <epicId>                   state summary and the last events

  --state-root <dir>                default ~/.epic-runner`

const ROOT = join(import.meta.dir, '..')

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

function dryCanned(): (req: ExecRequest) => Partial<ExecResult> | undefined {
  const live = new Set<string>()
  return (req) => {
    const a = req.args
    if (req.cmd === 'herdr' && a[2] === 'workspace' && a[3] === 'create') {
      return { stdout: JSON.stringify({ result: { workspace: { workspace_id: 'w-dry' }, root_pane: { pane_id: 'w-dry:p1' } } }) }
    }
    if (req.cmd === 'herdr' && a[2] === 'agent' && a[3] === 'start') live.add(a[a.indexOf('--pane') + 1] ?? '')
    if (req.cmd === 'herdr' && a[2] === 'pane' && a[3] === 'get') {
      const pane = a[4] ?? ''
      const agent = live.has(pane) ? { agent: 'claude', agent_status: 'working' } : { agent: null, agent_status: 'unknown' }
      return { stdout: JSON.stringify({ result: { pane: { pane_id: pane, ...agent } } }) }
    }
    if (req.cmd === 'br') return { stdout: '[]' }
    return undefined
  }
}

function deps(policy: EpicPolicy, stateRoot: string, dry: boolean): RunnerDeps {
  const print = (l: string) => console.log(l)
  const exec = dry ? dryRunExec(print, dryCanned()) : realExec
  const nmHome = process.env.NM_HOME ?? join(homedir(), '.no-mistakes')
  return {
    exec,
    fs: dry ? dryRunFs(print) : realFs,
    now: () => Date.now(),
    sleep: (ms) => Bun.sleep(ms),
    uuid: () => crypto.randomUUID(),
    stateRoot,
    claudeProjectsDir: join(homedir(), '.claude', 'projects'),
    nmConfigPath: join(nmHome, 'config.yaml'),
    hookPath: join(ROOT, 'hooks', 'rotate.sh'),
    notifier: dry
      ? { send: async (n) => print(`# notify [${policy.epicId}/runner] ${n.subject} (key ${n.key})`) }
      : inboxNotifier(exec, { wrapperPath: join(ROOT, 'src', 'inbox-send.ts'), projectPath: policy.repo, thread: `${policy.epicId}/runner` }),
    quota: alwaysOk,
  }
}

async function status(stateRoot: string, epicId: string): Promise<void> {
  const store = new StateStore(realFs, stateRoot, epicId, () => Date.now())
  const st = await store.load()
  if (!st) {
    console.log(`no state for ${epicId} under ${stateRoot}`)
    return
  }
  console.log(`epic ${st.epicId}${st.done ? ' — done' : ''}${st.halted ? ` — HALTED: ${st.halted.reason}` : ''}`)
  st.waves.forEach((w, i) => {
    const s = w.state
    const detail = 'pr' in s ? ` PR #${s.pr}` : ''
    console.log(`  wave ${i + 1} [${w.onPass}] ${s.s}${detail}${s.s === 'stopped_at_pr' ? ` (${s.why})` : ''}${w.fixRounds ? ` fix rounds ${w.fixRounds}` : ''}`)
    for (const b of w.beads) {
      const bs = st.beads[b]
      const extra = bs?.s === 'committed' ? ` ${bs.sha.slice(0, 9)}` : bs?.s === 'parked' || bs?.s === 'failed' ? `: ${bs.reason}` : bs?.s === 'working' ? ` session ${bs.sessionId} pane ${bs.pane} restarts ${bs.restarts}` : ''
      console.log(`    ${b} ${bs?.s ?? '?'}${extra}`)
    }
  })
  if (st.worker) console.log(`  worker: ${JSON.stringify(st.worker.job)} session ${st.worker.sessionId} tokens ${st.worker.lastTokens}`)
  console.log('  last events:')
  for (const e of await store.lastEvents(12)) {
    const { ts, type, ...rest } = e
    console.log(`    ${new Date(ts).toISOString()} ${type} ${JSON.stringify(rest).slice(0, 160)}`)
  }
}

async function main(argv: string[]): Promise<number> {
  const [cmd, target] = argv
  const stateRoot = flag(argv, '--state-root') ?? join(homedir(), '.epic-runner')
  const dry = argv.includes('--dry-run')
  if (!cmd || !target || cmd === '--help' || cmd === 'help') {
    console.log(USAGE)
    return cmd ? 0 : 2
  }
  if (cmd === 'status') {
    await status(stateRoot, target)
    return 0
  }
  const policy = await loadPolicy(target)
  const runner = new Runner(policy, deps(policy, stateRoot, dry))
  switch (cmd) {
    case 'tick': {
      const steps = Number(flag(argv, '--steps') ?? '1')
      for (let i = 0; i < steps; i++) {
        const r = await runner.tick()
        console.log(`tick ${i + 1}: ${r.summary}${r.progressed ? '' : ' (no change)'}`)
      }
      return 0
    }
    case 'run': {
      for (;;) {
        const r = await runner.tick()
        console.log(`${new Date().toISOString()} ${r.summary}`)
        if (runner.mustState().done) return 0
        if (dry && !r.progressed) return 0
        await Bun.sleep(r.progressed ? 1_000 : policy.tickMs)
      }
    }
    case 'resume': {
      for (const note of await runner.resume()) console.log(note)
      return 0
    }
    default:
      console.error(`unknown command ${cmd}\n\n${USAGE}`)
      return 2
  }
}

process.exit(await main(process.argv.slice(2)))
