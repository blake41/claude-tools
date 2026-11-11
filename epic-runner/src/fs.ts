import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export type Fs = {
  readText(path: string): Promise<string | null>
  writeAtomic(path: string, content: string): Promise<void>
  append(path: string, content: string): Promise<void>
  mtimeMs(path: string): Promise<number | null>
  exists(path: string): Promise<boolean>
}

function isMissing(e: unknown): boolean {
  return typeof e === 'object' && e !== null && 'code' in e && e.code === 'ENOENT'
}

export const realFs: Fs = {
  async readText(path) {
    try {
      return await readFile(path, 'utf8')
    } catch (e) {
      if (isMissing(e)) return null
      throw e
    }
  },
  async writeAtomic(path, content) {
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
    await writeFile(tmp, content)
    await rename(tmp, path)
  },
  async append(path, content) {
    await mkdir(dirname(path), { recursive: true })
    await appendFile(path, content)
  },
  async mtimeMs(path) {
    try {
      return (await stat(path)).mtimeMs
    } catch (e) {
      if (isMissing(e)) return null
      throw e
    }
  },
  async exists(path) {
    return (await this.mtimeMs(path)) !== null
  },
}

export function dryRunFs(print: (line: string) => void, base: Fs = realFs): Fs {
  const overlay = new Map<string, { text: string; at: number }>()
  return {
    async readText(p) {
      return overlay.get(p)?.text ?? base.readText(p)
    },
    async mtimeMs(p) {
      return overlay.get(p)?.at ?? base.mtimeMs(p)
    },
    async exists(p) {
      return overlay.has(p) || base.exists(p)
    },
    async writeAtomic(path, content) {
      overlay.set(path, { text: content, at: Date.now() })
      print(`# write ${path} (${content.length} bytes)`)
    },
    async append(path, content) {
      const prev = overlay.get(path)?.text ?? (await base.readText(path)) ?? ''
      overlay.set(path, { text: prev + content, at: Date.now() })
      print(`# append ${path}: ${content.trimEnd()}`)
    },
  }
}
