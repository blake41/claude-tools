import type { Exec } from './exec.ts'
import type { Fs } from './fs.ts'
import { Gh } from './gh.ts'
import { Git } from './git.ts'
import { Herdr } from './herdr.ts'
import type { Notice, Notifier } from './notifier.ts'
import type { QuotaCheck } from './quota.ts'
import { StateStore } from './store.ts'
import type { BeadState, EpicPolicy, RunnerState, WaveRecord, WaveState, WorkerRun } from './types.ts'
import { workerPaths, type WorkerPaths } from './worker-files.ts'

export type RunnerDeps = {
  exec: Exec
  fs?: Fs
  now: () => number
  sleep: (ms: number) => Promise<void>
  uuid: () => string
  stateRoot: string
  claudeProjectsDir: string
  nmConfigPath: string
  hookPath: string
  resumeCommand: string
  notifier: Notifier
  quota: QuotaCheck
}

export class Ctx {
  readonly store: StateStore
  readonly herdr: Herdr
  readonly git: Git
  readonly gh: Gh
  readonly paths: WorkerPaths
  state!: RunnerState

  constructor(
    readonly policy: EpicPolicy,
    readonly deps: RunnerDeps,
    readonly fs: Fs,
  ) {
    this.store = new StateStore(fs, deps.stateRoot, policy.epicId, deps.now)
    this.herdr = new Herdr(deps.exec, policy.herdrSession, deps.sleep)
    this.git = new Git(deps.exec, policy.worktree)
    this.gh = new Gh(deps.exec, policy.worktree)
    this.paths = workerPaths(policy.worktree)
  }

  now(): number {
    return this.deps.now()
  }

  event(type: string, data: Record<string, unknown> = {}): Promise<void> {
    return this.store.event(type, data)
  }

  save(): Promise<void> {
    return this.store.save(this.state)
  }

  async setBead(id: string, next: BeadState): Promise<void> {
    const prev = this.state.beads[id]
    this.state.beads[id] = next
    await this.save()
    await this.event('bead_transition', { bead: id, from: prev?.s ?? null, to: next.s, state: next })
  }

  wave(index: number): WaveRecord {
    const w = this.state.waves[index]
    if (!w) throw new Error(`no wave ${index}`)
    return w
  }

  async setWave(index: number, next: WaveState, patch: Partial<Omit<WaveRecord, 'state'>> = {}): Promise<void> {
    const w = this.wave(index)
    const from = w.state.s
    Object.assign(w, patch, { state: next })
    await this.save()
    await this.event('wave_transition', { wave: index + 1, from, to: next.s, state: next })
  }

  async setWorker(run: WorkerRun | null): Promise<void> {
    this.state.worker = run
    await this.save()
  }

  async notify(notice: Notice): Promise<void> {
    try {
      await this.deps.notifier.send(notice)
      await this.event('notified', { key: notice.key, subject: notice.subject })
    } catch (e) {
      await this.event('notify_failed', { key: notice.key, error: String(e) })
    }
  }

  async halt(reason: string, notice?: Notice): Promise<void> {
    this.state.halted = { reason, at: this.now() }
    await this.save()
    await this.event('halted', { reason })
    const base = notice ?? {
      key: `${this.policy.epicId}:halt:${this.state.halted.at}`,
      subject: `epic-runner halted on ${this.policy.epicId}`,
      body: reason,
    }
    await this.notify({ ...base, body: `${base.body}\n\n${this.resumeAction(reason)}` })
  }

  private resumeAction(reason: string): string {
    const id = this.policy.epicId
    return [
      ':::action',
      `Resume epic-runner on ${id}`,
      reason,
      '',
      `Run: ${this.deps.resumeCommand}`,
      `Stopped: epic ${id} is halted until it is resumed`,
      ':::',
    ].join('\n')
  }
}
