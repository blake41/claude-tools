import { mustRun, type Exec } from './exec.ts'

const IGNORED_PREFIXES = ['.epic-runner/', '.baton/']

export type DoneCheck = { ok: true } | { ok: false; reason: string }

export class Git {
  constructor(
    private readonly exec: Exec,
    private readonly cwd: string,
  ) {}

  private run(args: string[], timeoutMs = 120_000) {
    return this.exec({ cmd: 'git', args, cwd: this.cwd, timeoutMs })
  }

  async ok(args: string[]): Promise<boolean> {
    return (await this.run(args)).code === 0
  }

  async out(args: string[]): Promise<string> {
    return (await mustRun(this.exec, { cmd: 'git', args, cwd: this.cwd, timeoutMs: 300_000 })).trim()
  }

  async dirtyPaths(): Promise<string[]> {
    const text = await mustRun(this.exec, { cmd: 'git', args: ['status', '--porcelain', '--untracked-files=all'], cwd: this.cwd, timeoutMs: 120_000 })
    return text
      .split('\n')
      .filter((l) => l.length > 3)
      .map((l) => l.slice(3))
      .filter((p) => !IGNORED_PREFIXES.some((prefix) => p.startsWith(prefix)))
  }

  async verifyDone(sha: string, branch: string): Promise<DoneCheck> {
    if (!(await this.ok(['cat-file', '-e', `${sha}^{commit}`]))) return { ok: false, reason: `commit ${sha} does not exist` }
    if (!(await this.ok(['merge-base', '--is-ancestor', sha, `refs/heads/${branch}`]))) {
      return { ok: false, reason: `commit ${sha} is not on ${branch}` }
    }
    const dirty = await this.dirtyPaths()
    if (dirty.length > 0) return { ok: false, reason: `working tree is not clean: ${dirty.slice(0, 5).join(', ')}` }
    return { ok: true }
  }

  async mergesBetween(base: string, head: string): Promise<string[]> {
    const text = await this.out(['log', '--merges', '--format=%H', `${base}..${head}`])
    return text.split('\n').filter((l) => l !== '')
  }
}
