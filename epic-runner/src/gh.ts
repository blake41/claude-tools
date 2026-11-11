import { z } from 'zod'
import { mustRun, type Exec } from './exec.ts'

const CheckSchema = z.union([
  z.object({ __typename: z.literal('CheckRun'), name: z.string(), status: z.string(), conclusion: z.string().nullable().optional() }),
  z.object({ __typename: z.literal('StatusContext'), context: z.string(), state: z.string() }),
])
export type Check = z.infer<typeof CheckSchema>

const PrViewSchema = z.object({
  number: z.number().int(),
  headRefOid: z.string(),
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  url: z.string().optional(),
  statusCheckRollup: z.array(CheckSchema).optional(),
  additions: z.number().int().optional(),
  deletions: z.number().int().optional(),
})
export type PrView = z.infer<typeof PrViewSchema>

export type CiState = { k: 'pass' } | { k: 'pending'; names: string[] } | { k: 'fail'; names: string[] }

export function ciState(checks: Check[]): CiState {
  const failed: string[] = []
  const pending: string[] = []
  for (const c of checks) {
    if (c.__typename === 'CheckRun') {
      if (c.status !== 'COMPLETED') pending.push(c.name)
      else if (!['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(c.conclusion ?? '')) failed.push(c.name)
    } else if (c.state === 'PENDING' || c.state === 'EXPECTED') pending.push(c.context)
    else if (c.state !== 'SUCCESS') failed.push(c.context)
  }
  if (failed.length > 0) return { k: 'fail', names: failed }
  if (pending.length > 0 || checks.length === 0) return { k: 'pending', names: pending }
  return { k: 'pass' }
}

export class Gh {
  constructor(
    private readonly exec: Exec,
    private readonly cwd: string,
  ) {}

  private out(args: string[]): Promise<string> {
    return mustRun(this.exec, { cmd: 'gh', args, cwd: this.cwd, timeoutMs: 120_000 })
  }

  async view(prOrBranch: string, fields: string[]): Promise<PrView> {
    const json = await this.out(['pr', 'view', prOrBranch, '--json', fields.join(',')])
    return PrViewSchema.parse(JSON.parse(json))
  }

  async prForBranch(branch: string): Promise<PrView | null> {
    const r = await this.exec({ cmd: 'gh', args: ['pr', 'view', branch, '--json', 'number,headRefOid,state,url'], cwd: this.cwd, timeoutMs: 120_000 })
    if (r.code !== 0) return null
    return PrViewSchema.parse(JSON.parse(r.stdout))
  }

  async changedFiles(pr: number): Promise<string[]> {
    return (await this.out(['pr', 'diff', String(pr), '--name-only'])).split('\n').filter((l) => l.trim() !== '')
  }

  diff(pr: number): Promise<string> {
    return this.out(['pr', 'diff', String(pr)])
  }

  async merge(pr: number, head: string): Promise<void> {
    await this.out(['pr', 'merge', String(pr), '--rebase', '--match-head-commit', head])
  }
}
