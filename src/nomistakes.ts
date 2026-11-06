import { z } from 'zod'
import type { Fs } from './fs.ts'

export type AxiResult =
  | { k: 'outcome'; value: string; ok: boolean; runId: string | null }
  | { k: 'gate'; text: string; runId: string | null }
  | { k: 'running'; runId: string | null }

const OK_OUTCOMES = new Set(['passed', 'success', 'succeeded', 'completed', 'checks_passed', 'checks-passed', 'ci_ready', 'handed_off', 'validated'])

export function nmRunArgs(opts: { intentFile?: string; wait: string }): string[] {
  const start = opts.intentFile ? ['--intent-file', opts.intentFile] : []
  const skip = opts.intentFile ? ['--skip', 'test,document,lint'] : []
  return ['axi', 'run', ...start, '--yes', ...skip, '--wait', opts.wait]
}

function topLevel(text: string, key: string): string | null {
  const m = text.match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'))
  return m ? (m[1] ?? '').trim() : null
}

function runId(text: string): string | null {
  const block = text.match(/^run:[ \t]*\n((?:[ \t]+.*\n?)*)/m)
  const id = block?.[1]?.match(/^[ \t]+(?:id|run_id):[ \t]*(\S+)/m)
  return id?.[1] ?? null
}

export function parseAxiOutput(text: string): AxiResult {
  const id = runId(text)
  const outcome = topLevel(text, 'outcome')
  if (outcome !== null && outcome !== '') {
    const value = outcome.split(/\s+/)[0] ?? outcome
    return { k: 'outcome', value, ok: OK_OUTCOMES.has(value.toLowerCase()), runId: id }
  }
  if (topLevel(text, 'gate') !== null) return { k: 'gate', text: text.slice(0, 4000), runId: id }
  return { k: 'running', runId: id }
}

export type AxiFailure = { error: string | null; nextAction: string | null }

/** Pull the `error:` line and `branch_sync.next_action.command` out of `no-mistakes axi status` output. */
export function parseAxiFailure(text: string): AxiFailure {
  const error = topLevel(text, 'error')
  const cmd = text.match(/^[ \t]+next_action:[ \t]*\n(?:[ \t]+code:.*\n)?[ \t]+command:[ \t]*(.+)$/m)
  return { error: error ? error.replace(/^"|"$/g, '') : null, nextAction: cmd?.[1]?.trim() ?? null }
}

const TRANSIENT_PUSH = /step push failed[\s\S]*(remote rejected|fatal error in commit_refs|timed out|connection (reset|refused)|could not resolve host|http 5\d\d|internal server error)/i

/** A push the pipeline can safely redo: the remote failed, our commits were not rejected on merit. */
export function isRecoverablePushFailure(f: AxiFailure): boolean {
  return f.error !== null && f.nextAction === 'no-mistakes axi sync --recover' && TRANSIENT_PUSH.test(f.error)
}

export const MAX_NM_RECOVERIES = 2

export type NmConfigCheck = { k: 'ok' } | { k: 'written' } | { k: 'mismatch'; reason: string }

const NmConfigSchema = z.looseObject({
  agent_crash_retries: z.unknown().optional(),
  ci: z.looseObject({ rerun_transient: z.unknown().optional() }).nullable().optional(),
})

const WANT = { agent_crash_retries: 1, rerun_transient: 2 }

export async function ensureNoMistakesConfig(fs: Fs, path: string): Promise<NmConfigCheck> {
  const text = await fs.readText(path)
  if (text === null) {
    await fs.writeAtomic(path, `agent_crash_retries: ${WANT.agent_crash_retries}\nci:\n  rerun_transient: ${WANT.rerun_transient}\n`)
    return { k: 'written' }
  }
  const parsed = NmConfigSchema.safeParse(Bun.YAML.parse(text) ?? {})
  if (!parsed.success) return { k: 'mismatch', reason: `${path}: not a YAML mapping` }
  const root = parsed.data
  const ci = root.ci ?? {}
  const problems: string[] = []
  if (root.agent_crash_retries !== WANT.agent_crash_retries) {
    problems.push(`agent_crash_retries is ${String(root.agent_crash_retries ?? 'unset')}, want ${WANT.agent_crash_retries}`)
  }
  if (ci.rerun_transient !== WANT.rerun_transient) {
    problems.push(`ci.rerun_transient is ${String(ci.rerun_transient ?? 'unset')}, want ${WANT.rerun_transient}`)
  }
  return problems.length === 0 ? { k: 'ok' } : { k: 'mismatch', reason: `${path}: ${problems.join('; ')}` }
}
