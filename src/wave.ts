import { join } from 'node:path'
import { fixBrief } from './brief.ts'
import { actionBlock, type Ctx } from './context.ts'
import { mustRun } from './exec.ts'
import { currentVerdicts, downgradeReason } from './gates.ts'
import { ciState } from './gh.ts'
import { isRecoverablePushFailure, MAX_NM_RECOVERIES, nmRunArgs, parseAxiFailure, parseAxiOutput } from './nomistakes.ts'
import { buildReviewArgs, judgeVerify, parseReviewOutput, parseVerifyOutput, reviewPasses, VERIFY_JSON_SCHEMA } from './review.ts'
import type { Finding, Gate, GateVerdict, ReviewGate } from './types.ts'
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
        body: `Run \`no-mistakes axi status\` in \`${p.worktree}\` and respond, then resume.\n\n\`\`\`\n${out.text}\n\`\`\``,
      })
      return 'progressed'
    case 'outcome': {
      if (!out.ok) {
        const status = await ctx.deps.exec({ cmd: 'no-mistakes', args: ['axi', 'status'], cwd: p.worktree, timeoutMs: 60_000 })
        const failure = parseAxiFailure(status.stdout)
        const tries = w.nmRecoveries ?? 0
        if (isRecoverablePushFailure(failure) && tries < MAX_NM_RECOVERIES) {
          const rec = await ctx.deps.exec({ cmd: 'no-mistakes', args: ['axi', 'sync', '--recover'], cwd: p.worktree, timeoutMs: 120_000 })
          await ctx.event('nm_recovered', { wave: wave + 1, attempt: tries + 1, code: rec.code, error: failure.error?.slice(0, 300) })
          if (rec.code === 0) {
            await ctx.setWave(wave, { s: 'validating', nmRun }, { nmStarted: true, nmRecoveries: tries + 1 })
            return 'progressed'
          }
        }
        await ctx.setWave(wave, { s: 'validating', nmRun }, { nmStarted: true })
        const detail = failure.error ? `Error: ${failure.error}\n${failure.nextAction ? `Next action: \`${failure.nextAction}\`\n` : ''}\n` : ''
        await ctx.halt(`no-mistakes outcome ${out.value} on wave ${wave + 1}`, {
          key: `${p.epicId}:nm-outcome:${wave}:${nmRun}:${out.value}`,
          subject: `no-mistakes ${out.value} on wave ${wave + 1}`,
          body: `${detail}\`\`\`\n${(status.stdout || r.stdout).slice(-2500)}\n\`\`\``,
        })
        return 'progressed'
      }
      const pr = await ctx.gh.prForBranch(p.branch)
      if (!pr) {
        await ctx.halt(`no-mistakes reported ${out.value} but no PR exists for ${p.branch}`)
        return 'progressed'
      }
      const adopted = await adoptPublishedHead(ctx, pr.headRefOid)
      if (adopted !== null) {
        await ctx.halt(`wave ${wave + 1}: cannot move ${p.branch} to the published head ${pr.headRefOid.slice(0, 9)}: ${adopted}`)
        return 'progressed'
      }
      await ctx.setWave(wave, { s: 'pr_open', pr: pr.number, head: pr.headRefOid }, { nmStarted: false })
      return 'progressed'
    }
  }
}

async function adoptPublishedHead(ctx: Ctx, head: string): Promise<string | null> {
  const p = ctx.policy
  const run = (cmd: string, args: string[]) => ctx.deps.exec({ cmd, args, cwd: p.worktree, timeoutMs: 120_000 })
  await run('no-mistakes', ['axi', 'handoff'])
  const fetched = await run('git', ['fetch', 'origin', p.branch])
  if (fetched.code !== 0) return `git fetch failed: ${fetched.stderr.trim()}`
  const status = await run('git', ['status', '--porcelain'])
  const dirty = status.stdout.split('\n').filter((l) => l.trim() !== '' && !/\s\.(epic-runner|baton)\//.test(l))
  if (dirty.length > 0) return `worktree is dirty: ${dirty.join(', ')}`
  const cherry = await run('git', ['cherry', head, 'HEAD'])
  if (cherry.code !== 0) return `git cherry failed: ${cherry.stderr.trim()}`
  const missing = cherry.stdout.split('\n').filter((l) => l.startsWith('+'))
  if (missing.length > 0) return `local commits not in the published head: ${missing.join(', ')}`
  const reset = await run('git', ['reset', '--hard', head])
  if (reset.code !== 0) return `git reset failed: ${reset.stderr.trim()}`
  await ctx.event('adopted_published_head', { head })
  return null
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
  const prev = w.lastReview
  const verify = prev !== undefined && prev.head !== head && (gate.fixLoop?.reReview ?? 'verify') === 'verify'
  const base = `origin/${ctx.policy.base}`
  const beadsLine = `It delivers beads ${w.beads.join(', ')} of epic ${ctx.policy.epicId} (\`br show <id>\` for the bead text).`
  const prompt =
    verify && prev
      ? [
          `Re-review PR #${pr} at head ${head} in this worktree. ${beadsLine}`,
          `The previous review at ${prev.head} raised these findings:`,
          ...prev.findings.map((f) => `- ${f.id} [${f.severity}] ${f.file}:${f.line} ${f.summary}`),
          `The fix diff is \`git diff ${prev.head} ${head}\`. The branch may have been rebased onto a moved base: ignore changes that came in from ${base}.`,
          '(1) For EACH previous finding, report its id with resolved true or false and a one-line note.',
          '(2) Report NEW findings ONLY for problems introduced or exposed by lines changed in the fix diff, each with severity nit, minor, major or blocker, file and line.',
          'Do not re-review untouched code.',
        ].join('\n')
      : [
          `Review PR #${pr} at head ${head} in this worktree: the change is \`git diff ${base}...${head}\`.`,
          beadsLine,
          'Report every finding with severity nit, minor, major or blocker, file and line.',
        ].join(' ')
  const args = buildReviewArgs({ skill: gate.skill, model: gate.model, prompt, ...(verify ? { schema: VERIFY_JSON_SCHEMA } : {}) })
  const r = await mustRun(ctx.deps.exec, { cmd: 'claude', args, cwd: ctx.policy.worktree, timeoutMs: 30 * 60_000 })
  const common = { wave: wave + 1, pr, head, skill: gate.skill, model: gate.model }
  let pass: boolean
  let findings: Finding[]
  if (verify && prev) {
    const out = parseVerifyOutput(r)
    const v = judgeVerify(prev.findings, out, gate.passWhen.maxSeverity)
    pass = v.pass
    findings = v.findings
    await ctx.event('review_verdict', { ...common, mode: 'verify', pass, findings: findings.length, resolved: v.resolved, unresolved: v.unresolved, newFindings: v.newFindings, tokens: out.tokens, costUsd: out.costUsd })
  } else {
    const out = parseReviewOutput(r)
    pass = reviewPasses(out.findings, gate.passWhen.maxSeverity)
    findings = out.findings
    await ctx.event('review_verdict', { ...common, mode: 'full', pass, findings: findings.length, tokens: out.tokens, costUsd: out.costUsd })
  }
  w.lastReview = pass ? undefined : { head, findings: findings.map((f, i) => ({ ...f, id: `F${i + 1}` })) }
  await ctx.save()
  return { gate: 'review', head, pass, findings, at: ctx.now() }
}

async function stopAtPr(ctx: Ctx, wave: number, pr: number, why: string, url?: string): Promise<void> {
  const id = ctx.policy.epicId
  const last = wave + 1 >= ctx.state.waves.length
  const action = actionBlock(`Review and merge PR #${pr} for wave ${wave + 1} of ${id}`, why, [
    ...(url ? [`Where: ${url}`] : []),
    `Stopped: ${last ? `epic ${id}` : `wave ${wave + 2} of ${id}`} waits until PR #${pr} is merged`,
  ])
  await ctx.setWave(wave, { s: 'stopped_at_pr', pr, why })
  await ctx.notify({
    key: `${ctx.policy.epicId}:stopped:${wave}:${pr}:${why}`,
    subject: `PR #${pr} stopped at PR`,
    body: `Wave ${wave + 1} of epic \`${ctx.policy.epicId}\` stopped at PR #${pr}: ${why}.\n\nMerge it yourself to continue; the runner picks up the next wave once it sees the PR merged.\n\n${action}`,
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
  const started = await startWorker(ctx, job, { model: gate.fixLoop?.model ?? p.workerModel, launch: { k: 'fresh' }, restarts: 0 })
  if ('k' in started) {
    // The start parked: no round ran, so a resume retries this same round number.
    w.fixRounds = round - 1
    await ctx.save()
  }
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
  const view = await ctx.gh.view(String(st.pr), ['number', 'headRefOid', 'state', 'url', 'statusCheckRollup', 'additions', 'deletions'])
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
      await stopAtPr(ctx, wave, st.pr, why, view.url)
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
    await stopAtPr(ctx, wave, st.pr, `downgraded: ${downgrade}`, view.url)
    return 'progressed'
  }
  if (w.onPass === 'stop_at_pr') {
    await stopAtPr(ctx, wave, st.pr, 'policy onPass is stop_at_pr', view.url)
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
  await ctx.setWave(wave, { s: 'merged', pr, sha }, { lastReview: undefined })
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
