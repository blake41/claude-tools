import { z } from 'zod'
import { beadBrief } from './brief.ts'
import { actionBlock, Ctx, type RunnerDeps } from './context.ts'
import { ExecError, mustRun } from './exec.ts'
import { realFs } from './fs.ts'
import { HerdrServerDownError } from './herdr.ts'
import { ensureNoMistakesConfig } from './nomistakes.ts'
import type { BeadState, EpicPolicy, RunnerState, WorkerJob, WorkerRun } from './types.ts'
import { stepGating, stepMerge, stepStopped, stepValidating } from './wave.ts'
import { jobKey, startWorker, superviseWorker, writeSettings, type Launch, type WorkerEnd } from './worker.ts'

export type TickResult = { progressed: boolean; summary: string }

const ReadySchema = z.array(z.object({ id: z.string() }))

const MAX_CONSECUTIVE_TICK_ERRORS = 2

function describeError(e: unknown): string {
  if (e instanceof ExecError) {
    const out = (e.result.stderr || e.result.stdout).trim().slice(0, 300)
    return `${[e.req.cmd, ...e.req.args].join(' ').slice(0, 200)} (${e.result.timedOut ? 'timeout' : `exit ${e.result.code}`}): ${out}`
  }
  return e instanceof Error ? e.message : String(e)
}

export class Runner {
  private readonly ctx: Ctx
  private consecutiveErrors = 0

  constructor(policy: EpicPolicy, deps: RunnerDeps) {
    this.ctx = new Ctx(policy, deps, deps.fs ?? realFs)
  }

  mustState(): RunnerState {
    return this.ctx.state
  }

  async tick(): Promise<TickResult> {
    this.ctx.herdr.beginTick()
    try {
      const r = await this.step()
      this.consecutiveErrors = 0
      return r
    } catch (e) {
      this.consecutiveErrors++
      const message = describeError(e)
      await this.ctx.event('tick_error', { message, consecutive: this.consecutiveErrors })
      if (this.consecutiveErrors >= MAX_CONSECUTIVE_TICK_ERRORS && this.ctx.state && !this.ctx.state.halted) {
        await this.ctx.halt(`tick failed twice: ${message}`, {
          key: `${this.ctx.policy.epicId}:tick-error:${this.ctx.now()}`,
          subject: `epic-runner halted on ${this.ctx.policy.epicId}`,
          body:
            `Two ticks in a row failed. Last error:\n\n\`\`\`\n${message}\n\`\`\`\n\nFix the cause, then resume.` +
            (e instanceof HerdrServerDownError
              ? `\n\n${actionBlock(`Start the herdr server for ${this.ctx.policy.epicId}`, 'The runner could not start it headless.', [`Run: ${e.command}`])}`
              : ''),
        })
      }
      return { progressed: false, summary: `error: ${message}` }
    }
  }

  private async step(): Promise<TickResult> {
    const ctx = this.ctx
    const loaded = await ctx.store.load()
    if (loaded) ctx.state = loaded
    else {
      ctx.state = await this.initState()
      await ctx.save()
      await ctx.event('epic_initialised', { waves: ctx.state.waves.map((w) => ({ beads: w.beads, onPass: w.onPass })) })
    }
    const st = ctx.state
    if (st.halted) return { progressed: false, summary: `halted: ${st.halted.reason}` }
    if (st.done) return { progressed: false, summary: 'epic done' }
    if (!st.prepared) {
      await this.prepare()
      return { progressed: true, summary: 'prepared' }
    }
    const wi = st.waves.findIndex((w) => w.state.s !== 'merged')
    if (wi === -1) {
      st.done = true
      await ctx.save()
      await ctx.event('epic_done', {})
      await ctx.notify({
        key: `${ctx.policy.epicId}:done`,
        subject: `Epic ${ctx.policy.epicId} done`,
        body: `Every wave of epic \`${ctx.policy.epicId}\` is merged: ${st.waves.map((w) => (w.state.s === 'merged' ? `#${w.state.pr}` : '?')).join(', ')}.`,
      })
      return { progressed: true, summary: 'epic done' }
    }
    const wave = ctx.wave(wi)
    const s = wave.state.s
    const step = await (async () => {
      switch (s) {
        case 'building':
          return this.stepBuilding(wi)
        case 'validating':
          return stepValidating(ctx, wi)
        case 'pr_open':
        case 'gating':
          return st.worker?.job.kind === 'fix' ? this.superviseJob(st.worker) : stepGating(ctx, wi)
        case 'merge_ready':
          return stepMerge(ctx, wi)
        case 'stopped_at_pr':
          return stepStopped(ctx, wi)
        case 'merged':
          return 'idle' as const
      }
    })()
    return { progressed: step === 'progressed', summary: `wave ${wi + 1}: ${ctx.wave(wi).state.s}` }
  }

  async resume(): Promise<string[]> {
    const ctx = this.ctx
    const loaded = await ctx.store.load()
    if (!loaded) return ['no state yet']
    ctx.state = loaded
    const notes: string[] = []
    const run = ctx.state.worker
    for (const [id, bead] of Object.entries(ctx.state.beads)) {
      if (bead.s !== 'parked' && bead.s !== 'failed') continue
      if (run && run.job.kind === 'bead' && run.job.beadId === id) {
        run.protocolNudged = false
        run.stallNudges = 0
        run.lastStallNudgeAt = null
        run.lastPromptAt = ctx.now()
        await ctx.setBead(id, { s: 'working', sessionId: run.sessionId, pane: run.pane, startedAt: run.startedAt, restarts: run.restarts })
        notes.push(`${id}: supervising session ${run.sessionId} again`)
      } else {
        await ctx.setBead(id, { s: 'queued' })
        notes.push(`${id}: queued for a fresh session`)
      }
    }
    if (ctx.state.halted) {
      for (const [wi, w] of ctx.state.waves.entries()) {
        if (w.state.s !== 'validating') continue
        await ctx.setWave(wi, { s: 'validating', nmRun: '' }, { nmStarted: false })
        notes.push(`wave ${wi + 1}: a fresh no-mistakes run on the next tick`)
      }
      notes.push(`cleared halt: ${ctx.state.halted.reason}`)
    }
    ctx.state.halted = null
    await ctx.save()
    await ctx.event('resumed', { notes })
    return notes
  }

  private async initState(): Promise<RunnerState> {
    const p = this.ctx.policy
    let waves = p.waves
    if (waves.length === 0) {
      const out = await mustRun(this.ctx.deps.exec, { cmd: 'br', args: ['ready', '--parent', p.epicId, '--json'], cwd: p.repo, timeoutMs: 60_000 })
      const ids = ReadySchema.parse(JSON.parse(out || '[]')).map((r) => r.id)
      waves = ids.length > 0 ? [{ beads: ids, onPass: p.onPass }] : []
    }
    const beads: Record<string, BeadState> = {}
    for (const w of waves) for (const b of w.beads) beads[b] = { s: 'queued' }
    return {
      version: 1,
      epicId: p.epicId,
      createdAt: this.ctx.now(),
      prepared: false,
      beads,
      waves: waves.map((w) => ({ beads: w.beads, onPass: w.onPass, state: { s: 'building' }, fixRounds: 0, gatingSince: null, nmStarted: false })),
      workspace: null,
      worker: null,
      halted: null,
      done: false,
    }
  }

  private async prepare(): Promise<void> {
    const ctx = this.ctx
    const p = ctx.policy
    const exec = ctx.deps.exec
    if (!(await ctx.fs.exists(p.worktree))) {
      const has = await exec({ cmd: 'git', args: ['rev-parse', '--verify', '--quiet', `refs/heads/${p.branch}`], cwd: p.repo, timeoutMs: 30_000 })
      if (has.code === 0) {
        await mustRun(exec, { cmd: 'git', args: ['worktree', 'add', p.worktree, p.branch], cwd: p.repo, timeoutMs: 300_000 })
        await mustRun(exec, { cmd: 'bun', args: ['install', '--frozen-lockfile'], cwd: p.worktree, timeoutMs: 600_000 })
      } else {
        await mustRun(exec, { cmd: 'git', args: ['fetch', 'origin', p.base], cwd: p.repo, timeoutMs: 300_000 })
        await mustRun(exec, { cmd: 'worktree-add-cow', args: [p.worktree, '-b', p.branch, `origin/${p.base}`], cwd: p.repo, timeoutMs: 600_000 })
      }
      await ctx.event('worktree_created', { worktree: p.worktree, branch: p.branch })
    }
    await writeSettings(ctx)
    const nm = await ensureNoMistakesConfig(ctx.fs, ctx.deps.nmConfigPath)
    await ctx.event('nm_config', { path: ctx.deps.nmConfigPath, result: nm })
    if (nm.k === 'mismatch') {
      await ctx.halt(`no-mistakes config: ${nm.reason}`)
      return
    }
    const remote = await exec({ cmd: 'git', args: ['remote', 'get-url', 'no-mistakes'], cwd: p.worktree, timeoutMs: 30_000 })
    if (remote.code !== 0) {
      await ctx.halt(`no-mistakes is not initialised for ${p.repo}: run \`no-mistakes init\` there first`)
      return
    }
    ctx.state.prepared = true
    await ctx.save()
    await ctx.event('prepared', { worktree: p.worktree })
  }

  private async writeBeadBrief(beadId: string): Promise<void> {
    const ctx = this.ctx
    const p = ctx.policy
    const job: WorkerJob = { kind: 'bead', beadId }
    const show = (id: string) => mustRun(ctx.deps.exec, { cmd: 'br', args: ['show', id], cwd: p.repo, timeoutMs: 60_000 })
    const beadText = await show(beadId)
    const epicText = await show(p.epicId)
    await ctx.fs.writeAtomic(
      ctx.paths.brief(jobKey(job)),
      beadBrief({
        beadId,
        epicId: p.epicId,
        branch: p.branch,
        repoRoot: p.repo,
        worktree: p.worktree,
        statusFile: ctx.paths.status,
        inboxThread: `${p.epicId}/${beadId}`,
        beadText,
        epicText,
      }),
    )
  }

  private async stepBuilding(wi: number): Promise<'progressed' | 'idle'> {
    const ctx = this.ctx
    const worker = ctx.state.worker
    if (worker) return this.superviseJob(worker)
    const wave = ctx.wave(wi)
    const deferred: Array<[string, ParkedBead]> = []
    for (const id of wave.beads) {
      const bead = ctx.state.beads[id] ?? { s: 'queued' as const }
      const relaunch = relaunchFor(bead)
      switch (bead.s) {
        case 'committed':
          continue
        case 'parked':
          if (isDeferred(bead)) {
            deferred.push([id, bead])
            continue
          }
          await ctx.halt(`bead ${id} is ${bead.s}: ${bead.reason}`)
          return 'progressed'
        case 'failed':
          await ctx.halt(`bead ${id} is ${bead.s}: ${bead.reason}`)
          return 'progressed'
        case 'queued': {
          const quota = await ctx.deps.quota()
          if (!quota.ok) {
            await ctx.event('quota_wait', { resetsAt: quota.resetsAt })
            return 'idle'
          }
          await this.writeBeadBrief(id)
          await startWorker(ctx, { kind: 'bead', beadId: id }, { model: ctx.policy.workerModel, launch: { k: 'fresh' }, restarts: 0 })
          return 'progressed'
        }
        case 'working':
        case 'needs_decision':
        case 'rotating': {
          await ctx.event('worker_record_missing', { bead: id, state: bead.s })
          await this.writeBeadBrief(id)
          await startWorker(ctx, { kind: 'bead', beadId: id }, { model: ctx.policy.workerModel, launch: relaunch ?? { k: 'fresh' }, restarts: bead.s === 'working' ? bead.restarts : 0 })
          return 'progressed'
        }
      }
    }
    if (deferred.length > 0) {
      await this.haltForDeferred(deferred)
      return 'progressed'
    }
    await ctx.setWave(wi, { s: 'validating', nmRun: '' }, { nmStarted: false })
    return 'progressed'
  }

  /** Every bead that can run has run. Only deferred beads remain, so the owner must answer. */
  private async haltForDeferred(deferred: Array<[string, ParkedBead]>): Promise<void> {
    const ctx = this.ctx
    const epic = ctx.policy.epicId
    const items = deferred.map(([id, b]) => `Deferred ${id}: ${b.reason.replace(/^deferred:\s*/, '')} (Inbox thread ${b.thread ?? `${epic}/${id}`})`)
    const ids = deferred.map(([id]) => id).join(', ')
    await ctx.halt(`only deferred beads remain: ${ids}`, {
      key: `${epic}:deferred:${ids}:${ctx.now()}`,
      subject: `Epic ${epic} waits on ${deferred.length} deferred question${deferred.length === 1 ? '' : 's'}`,
      body: actionBlock(`Answer the deferred questions in epic ${epic}`, 'Every other bead is finished. These beads wait on an owner answer.', items),
    })
  }

  private async superviseJob(run: WorkerRun): Promise<'progressed' | 'idle'> {
    const result = await superviseWorker(this.ctx, run)
    if ('k' in result) {
      await this.finishJob(run, result)
      return 'progressed'
    }
    return result === run ? 'idle' : 'progressed'
  }

  private async finishJob(run: WorkerRun, end: WorkerEnd): Promise<void> {
    const ctx = this.ctx
    const job = run.job
    switch (end.k) {
      case 'parked':
        return
      case 'done':
        await ctx.setWorker(null)
        await ctx.event('job_done', { job, sha: end.sha, sessionId: run.sessionId, tokens: run.lastTokens, restarts: run.restarts })
        if (job.kind === 'bead') await ctx.setBead(job.beadId, { s: 'committed', sha: end.sha })
        else await ctx.setWave(job.wave, { s: 'validating', nmRun: '' }, { nmStarted: false })
        return
      case 'deferred': {
        await ctx.setWorker(null)
        if (job.kind === 'bead') {
          const prev = ctx.state.beads[job.beadId]
          const thread = prev?.s === 'needs_decision' ? prev.inboxThread : `${ctx.policy.epicId}/${job.beadId}`
          await ctx.setBead(job.beadId, { s: 'parked', reason: `deferred: ${end.what}`, thread })
          await ctx.event('bead_deferred', { bead: job.beadId, what: end.what, thread })
        } else {
          await ctx.halt(`${jobKey(job)} deferred: ${end.what}`)
        }
        return
      }
      case 'failed': {
        await ctx.setWorker(null)
        if (job.kind === 'bead') await ctx.setBead(job.beadId, { s: 'failed', reason: end.reason })
        const label = job.kind === 'bead' ? job.beadId : jobKey(job)
        await ctx.halt(`${label} failed: ${end.reason}`, {
          key: `${ctx.policy.epicId}:failed:${jobKey(job)}:${run.sessionId}`,
          subject: `Parked ${label}: worker reported failure`,
          body: `The worker for **${label}** in epic \`${ctx.policy.epicId}\` wrote \`failed: ${end.reason}\`. Later beads wait. Fix the cause, then resume.`,
        })
        return
      }
    }
  }
}

type ParkedBead = Extract<BeadState, { s: 'parked' }>

function isDeferred(bead: ParkedBead): boolean {
  return bead.reason.startsWith('deferred:')
}

function relaunchFor(bead: BeadState): Launch | null {
  switch (bead.s) {
    case 'working':
    case 'needs_decision':
      return { k: 'resume', sessionId: bead.sessionId }
    case 'rotating':
      return { k: 'baton', baton: bead.baton }
    case 'queued':
    case 'committed':
    case 'parked':
    case 'failed':
      return null
  }
}
