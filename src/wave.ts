import { join } from 'node:path'
import { fixBrief } from './brief.ts'
import type { Ctx } from './context.ts'
import { mustRun } from './exec.ts'
import { currentVerdicts, downgradeReason } from './gates.ts'
import { ciState } from './gh.ts'
import { nmRunArgs, parseAxiOutput } from './nomistakes.ts'
import { buildReviewArgs, parseReviewOutput, reviewPasses } from './review.ts'
import type { Gate, GateVerdict, ReviewGate } from './types.ts'
import { jobKey, startWorker } from './worker.ts'

type Step = 'progressed' | 'idle'

export function durationMs(s: string): number {
  const m = s.match(/^(\d+)(ms|s|m|h)$/)
  const n = Number(m?.[1] ?? 0)
  switch (m?.[2]) {
    case 'ms':
      return n
    case 's':
      return n * 1_000
    case 'm':
      return n * 60_000
    case 'h':
      return n * 3_600_000
    default:
      return 10 * 60_000
  }
}

function intentPath(ctx: Ctx, wave: number): string {
  return join(ctx.store.dir, `intent-wave-${wave + 1}.md`)
}

async function writeIntent(ctx: Ctx, wave: number): Promise<string> {
  const w = ctx.wave(wave)
  const p = ctx.policy
  const text = [
    `Epic ${p.epicId}, wave ${wave + 1} of ${ctx.state.waves.length}: deliver beads ${w.beads.join(', ')} from the beads tracker (\`br show <id>\` in ${p.repo}).`,
    `Each bead is one commit on ${p.branch}. Open one PR against ${p.base} for this wave.`,
  ].join('\n')
  const path = intentPath(ctx, wave)
  await ctx.fs.writeAtomic(path, `${text}\n`)
  return path
}

export async function stepValidating(ctx: Ctx, wave: number): Promise<Step> {
  const w = ctx.wave(wave)
  if (w.state.s !== 'validating') return 'idle'
  const p = ctx.policy
  const intentFile = w.nmStarted ? undefined : await writeIntent(ctx, wave)
  const args = nmRunArgs({ intentFile, wait: p.nmWait })
  await ctx.event('nm_run', { wave: wave + 1, args })
  const r = await ctx.deps.exec({ cmd: 'no-mistakes', args, cwd: p.worktree, timeoutMs: durationMs(p.nmWait) + 120_000 })
  const out = parseAxiOutput(r.stdout)
  await ctx.event('nm_result', { wave: wave + 1, code: r.code, timedOut: r.timedOut, result: out.k, runId: out.runId, tail: r.stdout.slice(-1500), stderr: r.stderr.slice(-500) })
  const nmRun = out.runId ?? w.state.nmRun
  if (r.code !== 0 && out.k === 'running') {
    await ctx.halt(`no-mistakes exited ${r.code} in wave ${wave + 1}`, {
      key: `${p.epicId}:nm-exit:${wave}:${nmRun || 'none'}:${r.code}`,
      subject: `no-mistakes failed on wave ${wave + 1}`,
      body: `\`no-mistakes ${args.join(' ')}\` exited ${r.code}.\n\n\`\`\`\n${(r.stderr || r.stdout).slice(-2500)}\n\`\`\``,
    })
    return 'progressed'
  }
  switch (out.k) {
    case 'running':
      await ctx.setWave(wave, { s: 'validating', nmRun }, { nmStarted: true })
      return 'progressed'
    case 'gate':
      await ctx.setWave(wave, { s: 'validating', nmRun }, { nmStarted: true })
      await ctx.halt(`no-mistakes needs a decision on wave ${wave + 1}`, {
        key: `${p.epicId}:nm-gate:${wave}:${nmRun}`,
        subject: `no-mistakes needs a decision on wave ${wave + 1}`,
        body: `Run \`no-mistakes axi status\` in \`${p.worktree}\` and respond, then \`epic-runner resume <policy>\`.\n\n\`\`\`\n${out.text}\n\`\`\``,
      })
      return 'progressed'
    case 'outcome': {
      if (!out.ok) {
        await ctx.setWave(wave, { s: 'validating', nmRun }, { nmStarted: true })
        await ctx.halt(`no-mistakes outcome ${out.value} on wave ${wave + 1}`, {
          key: `${p.epicId}:nm-outcome:${wave}:${nmRun}:${out.value}`,
          subject: `no-mistakes ${out.value} on wave ${wave + 1}`,
          body: `\`\`\`\n${r.stdout.slice(-2500)}\n\`\`\``,
        })
        return 'progressed'
      }
      const pr = await ctx.gh.prForBranch(p.branch)
      if (!pr) {
        await ctx.halt(`no-mistakes reported ${out.value} but no PR exists for ${p.branch}`)
        return 'progressed'
      }
      await ctx.setWave(wave, { s: 'pr_open', pr: pr.number, head: pr.headRefOid }, { nmStarted: false })
      return 'progressed'
    }
  }
}

async function runGate(ctx: Ctx, wave: number, gate: Gate, pr: number, head: string, rollup: Parameters<typeof ciState>[0]): Promise<GateVerdict | 'pending'> {
  const at = ctx.now()
  switch (gate.kind) {
    case 'ci_green_at_head': {
      const ci = ciState(rollup)
      if (ci.k === 'pending') {
        const since = ctx.wave(wave).gatingSince ?? at
        if (at - since <= ctx.policy.ciWaitMs) return 'pending'
        return { gate: gate.kind, head, pass: false, at }
      }
      return { gate: gate.kind, head, pass: ci.k === 'pass', at }
    }
    case 'linear_on_base': {
      await mustRun(ctx.deps.exec, { cmd: 'git', args: ['fetch', 'origin', ctx.policy.base], cwd: ctx.policy.worktree, timeoutMs: 300_000 })
      const merges = await ctx.git.mergesBetween(`origin/${ctx.policy.base}`, head)
      return { gate: gate.kind, head, pass: merges.length === 0, at }
    }
    case 'review':
      return runReview(ctx, wave, gate, pr, head)
  }
}

async function runReview(ctx: Ctx, wave: number, gate: ReviewGate, pr: number, head: string): Promise<GateVerdict> {
  const w = ctx.wave(wave)
  const prompt = [
    `Review PR #${pr} at head ${head} in this worktree: the change is \`git diff origin/${ctx.policy.base}...${head}\`.`,
    `It delivers beads ${w.beads.join(', ')} of epic ${ctx.policy.epicId} (\`br show <id>\` for the bead text).`,
    'Report every finding with severity nit, minor, major or blocker, file and line.',
  ].join(' ')
  const args = buildReviewArgs({ skill: gate.skill, model: gate.model, prompt })
  const r = await mustRun(ctx.deps.exec, { cmd: 'claude', args, cwd: ctx.policy.worktree, timeoutMs: 30 * 60_000 })
  const out = parseReviewOutput(r)
  const pass = reviewPasses(out.findings, gate.passWhen.maxSeverity)
  await ctx.event('review_verdict', { wave: wave + 1, pr, head, skill: gate.skill, model: gate.model, pass, findings: out.findings.length, tokens: out.tokens, costUsd: out.costUsd })
  return { gate: 'review', head, pass, findings: out.findings, at: ctx.now() }
}

async function stopAtPr(ctx: Ctx, wave: number, pr: number, why: string): Promise<void> {
  await ctx.setWave(wave, { s: 'stopped_at_pr', pr, why })
  await ctx.notify({
    key: `${ctx.policy.epicId}:stopped:${wave}:${pr}:${why}`,
    subject: `PR #${pr} stopped at PR`,
    body: `Wave ${wave + 1} of epic \`${ctx.policy.epicId}\` stopped at PR #${pr}: ${why}.\n\nMerge it yourself to continue; the runner picks up the next wave once it sees the PR merged.`,
  })
}

async function startFix(ctx: Ctx, wave: number, gate: ReviewGate, pr: number, verdict: GateVerdict): Promise<void> {
  const w = ctx.wave(wave)
  const round = w.fixRounds + 1
  const job = { kind: 'fix' as const, wave, round }
  const p = ctx.policy
  await ctx.fs.writeAtomic(
    ctx.paths.brief(jobKey(job)),
    fixBrief({
      beadId: w.beads.join(', '),
      epicId: p.epicId,
      branch: p.branch,
      repoRoot: p.repo,
      worktree: p.worktree,
      statusFile: ctx.paths.status,
      inboxThread: `${p.epicId}/runner`,
      pr,
      round,
      findings: verdict.findings ?? [],
    }),
  )
  w.fixRounds = round
  await ctx.save()
  await ctx.event('fix_round_started', { wave: wave + 1, round, pr, head: verdict.head })
  await startWorker(ctx, job, { model: gate.fixLoop?.model ?? p.workerModel, launch: { k: 'fresh' }, restarts: 0 })
}

export async function stepGating(ctx: Ctx, wave: number): Promise<Step> {
  const w = ctx.wave(wave)
  const st = w.state
  const p = ctx.policy
  if (st.s === 'pr_open') {
    await ctx.setWave(wave, { s: 'gating', pr: st.pr, head: st.head, verdicts: [] }, { gatingSince: ctx.now() })
    return 'progressed'
  }
  if (st.s !== 'gating') return 'idle'
  const view = await ctx.gh.view(String(st.pr), ['number', 'headRefOid', 'state', 'statusCheckRollup', 'additions', 'deletions'])
  if (view.state === 'MERGED') return markMerged(ctx, wave, st.pr, 'merged outside the runner')
  if (view.state === 'CLOSED') {
    await ctx.halt(`PR #${st.pr} was closed`)
    return 'progressed'
  }
  if (view.headRefOid !== st.head) {
    await ctx.event('verdicts_voided', { wave: wave + 1, pr: st.pr, from: st.head, to: view.headRefOid, voided: st.verdicts.length })
    await ctx.setWave(wave, { s: 'gating', pr: st.pr, head: view.headRefOid, verdicts: [] }, { gatingSince: ctx.now() })
    return 'progressed'
  }

  const verdicts = currentVerdicts(st.verdicts, st.head)
  for (const gate of p.gates) {
    let v = verdicts.find((x) => x.gate === gate.kind)
    if (!v) {
      const result = await runGate(ctx, wave, gate, st.pr, st.head, view.statusCheckRollup ?? [])
      if (result === 'pending') {
        if (verdicts.length !== st.verdicts.length) await ctx.setWave(wave, { ...st, verdicts })
        return 'idle'
      }
      v = result
      verdicts.push(v)
      await ctx.setWave(wave, { ...st, verdicts: [...verdicts] })
      await ctx.event('gate_verdict', { wave: wave + 1, pr: st.pr, verdict: { ...v, findings: v.findings?.length } })
    }
    if (!v.pass) {
      const fix = gate.kind === 'review' ? gate.fixLoop : undefined
      if (gate.kind === 'review' && fix && w.fixRounds < fix.maxRounds) {
        await startFix(ctx, wave, gate, st.pr, v)
        return 'progressed'
      }
      const why = gate.kind === 'review' && fix ? `${gate.kind} failed and fix rounds are exhausted (${w.fixRounds}/${fix.maxRounds})` : `${gate.kind} failed at ${st.head}`
      await stopAtPr(ctx, wave, st.pr, why)
      return 'progressed'
    }
  }

  const maxRounds = p.gates.reduce((m, g) => (g.kind === 'review' && g.fixLoop ? Math.max(m, g.fixLoop.maxRounds) : m), 0)
  const downgrade = downgradeReason(p.downgradeToStopIf, {
    files: await ctx.gh.changedFiles(st.pr),
    lines: (view.additions ?? 0) + (view.deletions ?? 0),
    fixRoundsExhausted: maxRounds > 0 && w.fixRounds >= maxRounds,
    beadScopes: p.beadScopes,
    beads: w.beads,
  })
  await ctx.event('gates_passed', { wave: wave + 1, pr: st.pr, head: st.head, downgrade, onPass: w.onPass })
  if (downgrade) {
    await stopAtPr(ctx, wave, st.pr, `downgraded: ${downgrade}`)
    return 'progressed'
  }
  if (w.onPass === 'stop_at_pr') {
    await stopAtPr(ctx, wave, st.pr, 'policy onPass is stop_at_pr')
    return 'progressed'
  }
  await ctx.setWave(wave, { s: 'merge_ready', pr: st.pr, head: st.head })
  return 'progressed'
}

async function markMerged(ctx: Ctx, wave: number, pr: number, how: string): Promise<Step> {
  const p = ctx.policy
  await mustRun(ctx.deps.exec, { cmd: 'git', args: ['fetch', 'origin', p.base], cwd: p.worktree, timeoutMs: 300_000 })
  const sha = await ctx.git.out(['rev-parse', `origin/${p.base}`])
  const rebase = await ctx.deps.exec({ cmd: 'git', args: ['rebase', `origin/${p.base}`], cwd: p.worktree, timeoutMs: 300_000 })
  if (rebase.code !== 0) {
    await ctx.deps.exec({ cmd: 'git', args: ['rebase', '--abort'], cwd: p.worktree, timeoutMs: 60_000 })
    await ctx.setWave(wave, { s: 'merged', pr, sha })
    await ctx.halt(`rebase of ${p.branch} onto origin/${p.base} failed after merging PR #${pr}`)
    return 'progressed'
  }
  await ctx.setWave(wave, { s: 'merged', pr, sha })
  await ctx.event('merged', { wave: wave + 1, pr, sha, how })
  await ctx.notify({
    key: `${p.epicId}:merged:${wave}:${pr}`,
    subject: `Merged PR #${pr}`,
    body: `Wave ${wave + 1} of epic \`${p.epicId}\` is on ${p.base} at \`${sha}\` (${how}). ${p.branch} is rebased for the next wave.`,
  })
  return 'progressed'
}

export async function stepMerge(ctx: Ctx, wave: number): Promise<Step> {
  const st = ctx.wave(wave).state
  if (st.s !== 'merge_ready') return 'idle'
  const view = await ctx.gh.view(String(st.pr), ['number', 'headRefOid', 'state'])
  if (view.state === 'MERGED') return markMerged(ctx, wave, st.pr, 'merged outside the runner')
  if (view.headRefOid !== st.head) {
    await ctx.event('verdicts_voided', { wave: wave + 1, pr: st.pr, from: st.head, to: view.headRefOid, voided: ctx.policy.gates.length })
    await ctx.setWave(wave, { s: 'gating', pr: st.pr, head: view.headRefOid, verdicts: [] }, { gatingSince: ctx.now() })
    return 'progressed'
  }
  await ctx.event('merge_requested', { wave: wave + 1, pr: st.pr, head: st.head })
  await ctx.gh.merge(st.pr, st.head)
  return markMerged(ctx, wave, st.pr, 'merged by the runner')
}

export async function stepStopped(ctx: Ctx, wave: number): Promise<Step> {
  const st = ctx.wave(wave).state
  if (st.s !== 'stopped_at_pr') return 'idle'
  const view = await ctx.gh.view(String(st.pr), ['number', 'headRefOid', 'state'])
  if (view.state === 'MERGED') return markMerged(ctx, wave, st.pr, 'merged by the owner')
  if (view.state === 'CLOSED') {
    await ctx.halt(`PR #${st.pr} was closed while stopped at PR`)
    return 'progressed'
  }
  return 'idle'
}
