import { describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realFs } from '../src/fs.ts'
import { ciState } from '../src/gh.ts'
import { claudeWorkerArgs } from '../src/herdr.ts'
import { ensureNoMistakesConfig, nmRunArgs, parseAxiOutput } from '../src/nomistakes.ts'
import { buildReviewArgs, parseReviewOutput, reviewPasses } from '../src/review.ts'
import { downgradeReason } from '../src/gates.ts'
import { DEFAULT_DOWNGRADES } from '../src/types.ts'

describe('claude worker flags', () => {
  it('uses identical flags for a new session and a resume, differing only in the session flag', () => {
    const flags = { model: 'sonnet', settingsPath: '/wt/.epic-runner/settings.json' }
    const fresh = claudeWorkerArgs({ mode: 'new', sessionId: 'sid-1' }, flags)
    const resume = claudeWorkerArgs({ mode: 'resume', sessionId: 'sid-1' }, flags)
    expect(fresh).toEqual(['--session-id', 'sid-1', '--permission-mode', 'auto', '--model', 'sonnet', '--settings', '/wt/.epic-runner/settings.json'])
    expect(resume.slice(2)).toEqual(fresh.slice(2))
    expect(resume.slice(0, 2)).toEqual(['--resume', 'sid-1'])
  })
})

describe('no-mistakes axi', () => {
  it('builds a new-run and a reattach invocation', () => {
    expect(nmRunArgs({ intentFile: '/s/intent-w1.md', wait: '8m' })).toEqual([
      'axi', 'run', '--intent-file', '/s/intent-w1.md', '--yes', '--skip', 'test,document,lint', '--wait', '8m',
    ])
    expect(nmRunArgs({ wait: '8m' })).toEqual(['axi', 'run', '--yes', '--wait', '8m'])
  })

  it('classifies TOON output into outcome, gate or still running', () => {
    expect(parseAxiOutput('run:\n  id: r-01\n  branch: epic/x\noutcome: passed\n')).toEqual({ k: 'outcome', value: 'passed', ok: true, runId: 'r-01' })
    expect(parseAxiOutput('run:\n  id: r-01\noutcome: failed\nerror: lint\n')).toMatchObject({ k: 'outcome', ok: false })
    expect(parseAxiOutput('run:\n  id: r-02\ngate:\n  step: review\n')).toMatchObject({ k: 'gate', runId: 'r-02' })
    expect(parseAxiOutput('run:\n  id: r-03\n  status: running\n')).toEqual({ k: 'running', runId: 'r-03' })
  })

  it('writes the global config when absent and verifies it when present', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'er-nm-'))
    const path = join(dir, 'config.yaml')
    expect(await ensureNoMistakesConfig(realFs, path)).toEqual({ k: 'written' })
    expect(Bun.YAML.parse((await realFs.readText(path)) ?? '')).toEqual({ agent_crash_retries: 1, ci: { rerun_transient: 2 } })
    expect(await ensureNoMistakesConfig(realFs, path)).toEqual({ k: 'ok' })
    await realFs.writeAtomic(path, 'agent: claude\nagent_crash_retries: 0\n')
    expect(await ensureNoMistakesConfig(realFs, path)).toEqual({
      k: 'mismatch',
      reason: `${path}: agent_crash_retries is 0, want 1; ci.rerun_transient is unset, want 2`,
    })
  })
})

describe('review gate', () => {
  it('runs the skill headless with the findings schema', () => {
    const args = buildReviewArgs({ skill: 'p:thermonuclear-code-quality-review', model: 'opus', prompt: 'Review PR #12' })
    expect(args.slice(0, 6)).toEqual(['-p', '--model', 'opus', '--output-format', 'json', '--json-schema'])
    expect(JSON.parse(args[6] ?? '').properties.findings.items.properties.severity.enum).toEqual(['nit', 'minor', 'major', 'blocker'])
    expect(args[7]).toBe('/p:thermonuclear-code-quality-review Review PR #12')
  })

  it('parses structured_output and applies passWhen', () => {
    const stdout = JSON.stringify({
      type: 'result',
      is_error: false,
      total_cost_usd: 0.54,
      usage: { input_tokens: 10, cache_read_input_tokens: 369000, cache_creation_input_tokens: 81000, output_tokens: 3200 },
      structured_output: {
        findings: [
          { severity: 'minor', file: 'src/auth/resolve-terra-user.ts', line: 41, summary: 'cache key ignores org' },
          { severity: 'nit', file: 'src/auth/resolve-terra-user.ts', line: 3, summary: 'unused import' },
        ],
      },
    })
    const r = parseReviewOutput(stdout)
    expect(r.findings.map((f) => f.severity)).toEqual(['minor', 'nit'])
    expect(r.tokens).toBe(369000 + 81000 + 10 + 3200)
    expect(reviewPasses(r.findings, 'minor')).toBe(true)
    expect(reviewPasses([{ severity: 'major', file: 'a', line: 1, summary: 's' }], 'minor')).toBe(false)
    expect(reviewPasses([{ severity: 'major', file: 'a', line: 1, summary: 's' }], 'major')).toBe(true)
    expect(() => parseReviewOutput(JSON.stringify({ type: 'result', is_error: true, result: 'boom' }))).toThrow(/structured_output/)
  })
})

describe('ci and downgrades', () => {
  it('reads statusCheckRollup at head', () => {
    const run = (conclusion: string | null, status = 'COMPLETED') => ({ __typename: 'CheckRun' as const, name: 'backend-tests', status, conclusion })
    expect(ciState([run('SUCCESS'), run('SKIPPED')])).toEqual({ k: 'pass' })
    expect(ciState([run(null, 'IN_PROGRESS')])).toEqual({ k: 'pending', names: ['backend-tests'] })
    expect(ciState([run('FAILURE')])).toEqual({ k: 'fail', names: ['backend-tests'] })
    expect(ciState([])).toEqual({ k: 'pending', names: [] })
  })

  it('finds the first downgrade rule that applies to the PR diff', () => {
    const rules = [{ kind: 'touches' as const, globs: ['src/auth/**'] }, ...DEFAULT_DOWNGRADES]
    const input = { files: ['src/services/render-api.ts'], lines: 120, fixRoundsExhausted: false, beadScopes: {}, beads: ['b1'] }
    expect(downgradeReason(rules, input)).toBeNull()
    expect(downgradeReason(rules, { ...input, files: ['src/auth/clerk-user-email-cache.ts'] })).toBe('touches src/auth/**: src/auth/clerk-user-email-cache.ts')
    expect(downgradeReason(rules, { ...input, files: ['.github/workflows/ci.yml'] })).toMatch(/touches .github/)
    expect(downgradeReason(rules, { ...input, lines: 801 })).toBe('diff is 801 lines, over 800')
    expect(downgradeReason(rules, { ...input, fixRoundsExhausted: true })).toBe('review fix rounds exhausted')
    expect(downgradeReason(rules, { ...input, beadScopes: { b1: ['src/services/**'] }, files: ['src/jobs/x.ts'] })).toBe(
      'files outside bead scope: src/jobs/x.ts',
    )
  })
})
