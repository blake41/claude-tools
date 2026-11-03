import { DONE_REJECTED_PROMPT, grabPrompt, PROTOCOL_NUDGE, RESTART_PROMPT, ROTATE_DROP_PROMPT } from './brief.ts'
import type { Ctx } from './context.ts'
import { claudeWorkerArgs, type WorkerLaunch } from './herdr.ts'
import { decide, needsPaneText, type LivenessAction } from './liveness.ts'
import { isTerminal, newStatusLines, statusLineCount } from './status-protocol.ts'
import { contextTokens, transcriptPath } from './transcript.ts'
import type { WorkerJob, WorkerRun } from './types.ts'
import { workerSettings } from './worker-files.ts'

export type Launch =
  | { k: 'fresh' }
  | { k: 'baton'; baton: string }
  | { k: 'grab'; fromSession: string }
  | { k: 'resume'; sessionId: string }

export type WorkerEnd = { k: 'done'; sha: string } | { k: 'failed'; reason: string } | { k: 'parked'; reason: string }

const TOKEN_EVENT_STEP = 10_000
const MAX_DONE_REJECTIONS = 2

export function jobKey(job: WorkerJob): string {
  switch (job.kind) {
    case 'bead':
      return job.beadId
    case 'fix':
      return `fix-w${job.wave + 1}-r${job.round}`
  }
}

function jobLabel(job: WorkerJob): string {
  return job.kind === 'bead' ? job.beadId : `review fixes for wave ${job.wave + 1} (round ${job.round})`
}

function firstPrompt(job: WorkerJob, launch: Launch, briefPath: string, statusFile: string): string {
  switch (launch.k) {
    case 'fresh':
      return job.kind === 'bead' ? `Follow the bead brief at ${briefPath}.` : `Follow the review-fix brief at ${briefPath}.`
    case 'baton':
      return grabPrompt(briefPath)
    case 'grab':
      return grabPrompt(briefPath, launch.fromSession)
    case 'resume':
      return RESTART_PROMPT(statusFile, briefPath)
  }
}

async function ensurePane(ctx: Ctx): Promise<{ pane: string } | { error: string }> {
  const ws = ctx.state.workspace
  if (ws) {
    const o = await ctx.herdr.observe(ws.pane)
    if (o.k === 'dead') return { pane: ws.pane }
    if (o.k === 'live') {
      if (o.status === 'blocked') return { error: `pane ${ws.pane} is blocked on a dialog` }
      if (await ctx.herdr.stopAgent(ws.pane)) return { pane: ws.pane }
      return { error: `could not stop the agent in ${ws.pane}` }
    }
  }
  const created = await ctx.herdr.createWorkspace(ctx.policy.worktree, `epic ${ctx.policy.epicId}`)
  ctx.state.workspace = { id: created.workspaceId, pane: created.paneId }
  await ctx.save()
  await ctx.event('workspace_created', { workspace: created.workspaceId, pane: created.paneId })
  return { pane: created.paneId }
}

export async function writeSettings(ctx: Ctx): Promise<void> {
  await ctx.fs.writeAtomic(ctx.paths.gitignore, '*\n')
  await ctx.fs.writeAtomic(
    ctx.paths.settings,
    workerSettings({ hookPath: ctx.deps.hookPath, rotateAt: ctx.policy.rotateAtTokens, paths: ctx.paths, sandbox: ctx.policy.workerSandbox }),
  )
}

export async function startWorker(
  ctx: Ctx,
  job: WorkerJob,
  opts: { model: string; launch: Launch; restarts: number },
): Promise<WorkerRun | WorkerEnd> {
  await writeSettings(ctx)
  const pane = await ensurePane(ctx)
  if ('error' in pane) return parkJob(ctx, job, null, pane.error, null, 'parked')
  const sessionId = opts.launch.k === 'resume' ? opts.launch.sessionId : ctx.deps.uuid()
  const launch: WorkerLaunch = opts.launch.k === 'resume' ? { mode: 'resume', sessionId } : { mode: 'new', sessionId }
  const args = claudeWorkerArgs(launch, { model: opts.model, settingsPath: ctx.paths.settings })
  const started = await ctx.herdr.startClaude(pane.pane, sessionId, args)
  if (!started.ok) {
    const text = await ctx.herdr.readPane(pane.pane, 'visible')
    const why = started.code === 'agent_not_ready' ? 'blocked at startup' : `agent start failed: ${started.code} ${started.message}`
    return parkJob(ctx, job, null, why, text, started.code === 'agent_not_ready' ? 'blocked' : 'parked')
  }
  const briefPath = ctx.paths.brief(jobKey(job))
  const prompted = await ctx.herdr.prompt(pane.pane, firstPrompt(job, opts.launch, briefPath, ctx.paths.status))
  if (!prompted.ok) {
    const text = await ctx.herdr.readPane(pane.pane, 'visible')
    return parkJob(ctx, job, null, `first prompt failed: ${prompted.code}`, text, 'parked')
  }
  const now = ctx.now()
  const run: WorkerRun = {
    job,
    sessionId,
    pane: pane.pane,
    model: opts.model,
    startedAt: now,
    restarts: opts.restarts,
    statusCursor: statusLineCount(await ctx.fs.readText(ctx.paths.status)),
    lastPromptAt: now,
    protocolNudged: false,
    stallNudges: 0,
    lastStallNudgeAt: null,
    rotateRequested: false,
    waitingOnOwner: false,
    doneRejections: 0,
    lastTokens: 0,
  }
  await ctx.setWorker(run)
  await ctx.event('worker_started', { job, sessionId, pane: pane.pane, model: opts.model, launch: opts.launch.k, args, promptRecovered: prompted.recovered })
  if (job.kind === 'bead') {
    await ctx.setBead(job.beadId, { s: 'working', sessionId, pane: pane.pane, startedAt: now, restarts: opts.restarts })
  }
  return run
}

async function parkJob(
  ctx: Ctx,
  job: WorkerJob,
  run: WorkerRun | null,
  reason: string,
  paneText: string | null,
  kind: 'blocked' | 'parked',
): Promise<WorkerEnd> {
  if (job.kind === 'bead') await ctx.setBead(job.beadId, { s: 'parked', reason })
  const label = jobLabel(job)
  const body = [
    `epic-runner parked **${label}** in epic \`${ctx.policy.epicId}\`: ${reason}.`,
    run ? `Session \`${run.sessionId}\` in herdr pane \`${run.pane}\` (session \`${ctx.policy.herdrSession}\`).` : '',
    kind === 'blocked' ? 'The runner never types into a dialog. Answer it in the pane, then run `epic-runner resume <policy>`.' : 'Fix the cause, then run `epic-runner resume <policy>`.',
    paneText ? `\nPane:\n\n\`\`\`\n${paneText.trimEnd().slice(-3000)}\n\`\`\`` : '',
  ]
    .filter((l) => l !== '')
    .join('\n')
  await ctx.halt(`parked ${label}: ${reason}`, {
    key: `${ctx.policy.epicId}:park:${jobKey(job)}:${run?.sessionId ?? 'start'}:${run?.restarts ?? 0}:${kind}`,
    subject: kind === 'blocked' ? `Blocked dialog on ${label}` : `Parked ${label}`,
    body,
  })
  return { k: 'parked', reason }
}

async function promptRun(ctx: Ctx, run: WorkerRun, text: string): Promise<boolean> {
  const r = await ctx.herdr.prompt(run.pane, text)
  run.lastPromptAt = ctx.now()
  if (!r.ok) await ctx.event('prompt_failed', { pane: run.pane, code: r.code, message: r.message })
  return r.ok
}

async function restartAfterDeath(ctx: Ctx, run: WorkerRun, mode: 'resume' | 'grab', paneMissing: boolean): Promise<WorkerRun | WorkerEnd> {
  await ctx.event('worker_died', { job: run.job, sessionId: run.sessionId, restarts: run.restarts, paneMissing, recovery: mode })
  if (paneMissing) ctx.state.workspace = null
  const launch: Launch = mode === 'resume' ? { k: 'resume', sessionId: run.sessionId } : { k: 'grab', fromSession: run.sessionId }
  const next = await startWorker(ctx, run.job, { model: run.model, launch, restarts: run.restarts + 1 })
  if ('k' in next) return next
  await ctx.event('worker_recovered', { job: run.job, sessionId: next.sessionId, restarts: next.restarts })
  return next
}

export async function rotateHandover(ctx: Ctx, run: WorkerRun, baton: string): Promise<WorkerRun | WorkerEnd> {
  if (!(await ctx.herdr.stopAgent(run.pane))) return parkJob(ctx, run.job, run, 'could not stop the agent for rotation', null, 'parked')
  const next = await startWorker(ctx, run.job, { model: run.model, launch: { k: 'baton', baton }, restarts: run.restarts })
  if ('k' in next) return next
  await ctx.event('rotated', { job: run.job, from: run.sessionId, to: next.sessionId, baton })
  return next
}

async function apply(ctx: Ctx, run: WorkerRun, action: LivenessAction, paneMissing: boolean): Promise<WorkerRun | WorkerEnd> {
  switch (action.a) {
    case 'wait':
      return run
    case 'status': {
      const line = action.line
      switch (line.k) {
        case 'done': {
          const check = await ctx.git.verifyDone(line.sha, ctx.policy.branch)
          if (check.ok) return { k: 'done', sha: line.sha }
          run.doneRejections++
          await ctx.event('done_rejected', { job: run.job, sha: line.sha, reason: check.reason, rejections: run.doneRejections })
          if (run.doneRejections >= MAX_DONE_REJECTIONS) return parkJob(ctx, run.job, run, `done rejected twice: ${check.reason}`, null, 'parked')
          await promptRun(ctx, run, DONE_REJECTED_PROMPT(ctx.paths.status, check.reason))
          return run
        }
        case 'failed':
          return { k: 'failed', reason: line.reason }
        case 'needs_decision': {
          run.waitingOnOwner = true
          await ctx.event('needs_decision', { job: run.job, thread: line.thread, question: line.question })
          if (run.job.kind === 'bead') {
            await ctx.setBead(run.job.beadId, { s: 'needs_decision', sessionId: run.sessionId, inboxThread: line.thread, since: ctx.now() })
          }
          return run
        }
        case 'rotate': {
          if (run.job.kind === 'bead') await ctx.setBead(run.job.beadId, { s: 'rotating', fromSession: run.sessionId, baton: line.baton })
          return rotateHandover(ctx, run, line.baton)
        }
      }
    }
    case 'restart':
      return restartAfterDeath(ctx, run, action.mode, paneMissing)
    case 'park':
      return parkJob(ctx, run.job, run, action.reason, action.paneText, action.notify)
    case 'rotate_interrupt':
      run.rotateRequested = true
      await ctx.event('rotate_interrupt', { job: run.job, tokens: run.lastTokens })
      await ctx.herdr.sendKeys(run.pane, ['esc'])
      await promptRun(ctx, run, ROTATE_DROP_PROMPT(ctx.paths.status))
      return run
    case 'stall_nudge':
      run.stallNudges++
      run.lastStallNudgeAt = ctx.now()
      await ctx.event('stall_nudge', { job: run.job, apiError: action.apiError, nudges: run.stallNudges })
      if (!action.apiError) await ctx.herdr.sendKeys(run.pane, ['esc'])
      await promptRun(ctx, run, 'continue')
      return run
    case 'protocol_nudge':
      run.protocolNudged = true
      await ctx.event('protocol_nudge', { job: run.job })
      await promptRun(ctx, run, PROTOCOL_NUDGE(ctx.paths.status))
      return run
  }
}

export async function superviseWorker(ctx: Ctx, run: WorkerRun): Promise<WorkerRun | WorkerEnd> {
  const p = ctx.policy
  if (run.job.kind === 'bead') {
    const bead = ctx.state.beads[run.job.beadId]
    if (bead?.s === 'rotating') return rotateHandover(ctx, run, bead.baton)
  }

  const status = newStatusLines(await ctx.fs.readText(ctx.paths.status), run.statusCursor)
  if (status.lines.length > 0) await ctx.event('status_lines', { job: run.job, lines: status.lines })
  run.statusCursor = status.cursor
  const terminal = status.lines.filter(isTerminal).at(-1) ?? null

  const agent = await ctx.herdr.observe(run.pane)
  const tPath = transcriptPath(ctx.deps.claudeProjectsDir, p.worktree, run.sessionId)
  const transcriptMtime = await ctx.fs.mtimeMs(tPath)
  const transcript = await ctx.fs.readText(tPath)
  const tokens = transcript === null ? null : contextTokens(transcript)
  if (tokens !== null && Math.abs(tokens - run.lastTokens) >= TOKEN_EVENT_STEP) {
    run.lastTokens = tokens
    await ctx.event('tokens', { job: run.job, sessionId: run.sessionId, tokens })
  }
  if (run.lastStallNudgeAt !== null && transcriptMtime !== null && transcriptMtime > run.lastStallNudgeAt) {
    run.stallNudges = 0
    run.lastStallNudgeAt = null
  }
  if (run.waitingOnOwner && agent.k === 'live' && agent.status === 'working') {
    run.waitingOnOwner = false
    run.lastPromptAt = ctx.now()
    await ctx.event('decision_resumed', { job: run.job })
    if (run.job.kind === 'bead') {
      await ctx.setBead(run.job.beadId, { s: 'working', sessionId: run.sessionId, pane: run.pane, startedAt: run.startedAt, restarts: run.restarts })
    }
  }

  const cfg = {
    stallMs: p.stallMs,
    idleGraceMs: p.idleGraceMs,
    rotateAtTokens: p.rotateAtTokens,
    maxRestarts: p.maxRestarts,
    maxStallNudges: p.maxStallNudges,
  }
  const now = ctx.now()
  const paneText = needsPaneText({ now, agent, transcriptMtime }, run, cfg) ? await ctx.herdr.readPane(run.pane, 'visible') : null
  const action = decide({ now, terminal, agent, transcriptMtime, tokens, paneText, waitingOnOwner: run.waitingOnOwner }, run, cfg)
  const result = await apply(ctx, run, action, agent.k === 'pane_missing')
  if (result === run) await ctx.setWorker(run)
  return result
}
