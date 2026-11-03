import { join } from 'node:path'
import { z } from 'zod'
import type { Fs } from './fs.ts'
import { RunnerStateSchema, type RunnerState } from './types.ts'

const EventRecordSchema = z.looseObject({ ts: z.number(), type: z.string() })
export type EventRecord = z.infer<typeof EventRecordSchema>

export class StateStore {
  readonly dir: string

  constructor(
    private readonly fs: Fs,
    root: string,
    epicId: string,
    private readonly now: () => number,
  ) {
    this.dir = join(root, epicId)
  }

  get statePath(): string {
    return join(this.dir, 'state.json')
  }

  get eventsPath(): string {
    return join(this.dir, 'events.jsonl')
  }

  async load(): Promise<RunnerState | null> {
    const text = await this.fs.readText(this.statePath)
    if (text === null) return null
    const parsed = RunnerStateSchema.safeParse(JSON.parse(text))
    if (!parsed.success) throw new Error(`corrupt state ${this.statePath}: ${parsed.error.message}`)
    return parsed.data
  }

  async save(state: RunnerState): Promise<void> {
    await this.fs.writeAtomic(this.statePath, `${JSON.stringify(state, null, 2)}\n`)
  }

  async event(type: string, data: Record<string, unknown> = {}): Promise<void> {
    const record: EventRecord = { ts: this.now(), type, ...data }
    await this.fs.append(this.eventsPath, `${JSON.stringify(record)}\n`)
  }

  async lastEvents(n: number): Promise<EventRecord[]> {
    const text = (await this.fs.readText(this.eventsPath)) ?? ''
    return text
      .split('\n')
      .filter((l) => l.trim() !== '')
      .slice(-n)
      .map((l) => EventRecordSchema.parse(JSON.parse(l)))
  }
}
