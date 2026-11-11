import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realFs } from '../src/fs.ts'
import { StateStore } from '../src/store.ts'
import type { RunnerState } from '../src/types.ts'

const state: RunnerState = {
  version: 1,
  epicId: 'bd-43aa7',
  createdAt: 1,
  prepared: false,
  beads: { 'bd-43aa7.1': { s: 'committed', sha: 'abc123' } },
  waves: [],
  workspace: null,
  worker: null,
  halted: null,
  done: false,
}

describe('StateStore', () => {
  it('writes state atomically and reads it back through the schema', async () => {
    const root = mkdtempSync(join(tmpdir(), 'er-store-'))
    const store = new StateStore(realFs, root, 'bd-43aa7', () => 1000)
    await store.save(state)
    expect(readdirSync(join(root, 'bd-43aa7')).sort()).toEqual(['state.json'])
    expect(await store.load()).toEqual(state)
  })

  it('rejects a state file that does not match the schema', async () => {
    const root = mkdtempSync(join(tmpdir(), 'er-store-'))
    const store = new StateStore(realFs, root, 'bd-43aa7', () => 1000)
    await realFs.writeAtomic(join(root, 'bd-43aa7', 'state.json'), JSON.stringify({ version: 2 }))
    expect(store.load()).rejects.toThrow(/state/)
  })

  it('appends timestamped events as JSON lines', async () => {
    const root = mkdtempSync(join(tmpdir(), 'er-store-'))
    let t = 5
    const store = new StateStore(realFs, root, 'bd-43aa7', () => t++)
    await store.event('bead_started', { bead: 'bd-43aa7.1' })
    await store.event('tokens', { tokens: 61000 })
    const lines = readFileSync(join(root, 'bd-43aa7', 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(lines).toEqual([
      { ts: 5, type: 'bead_started', bead: 'bd-43aa7.1' },
      { ts: 6, type: 'tokens', tokens: 61000 },
    ])
    expect(await store.lastEvents(1)).toEqual([{ ts: 6, type: 'tokens', tokens: 61000 }])
  })
})
