import { describe, expect, it } from 'bun:test'
import { dryRunExec, formatCommand, mustRun, realExec } from '../src/exec.ts'

describe('exec seam', () => {
  it('formats a command with shell quoting for dry-run output', () => {
    expect(formatCommand({ cmd: 'herdr', args: ['--session', 'epic', 'agent', 'prompt', 'w1:p1', "it's done"], cwd: '/wt' })).toBe(
      `(cd /wt && herdr --session epic agent prompt w1:p1 'it'\\''s done')`,
    )
  })

  it('dry-run prints instead of executing and returns the canned result', async () => {
    const printed: string[] = []
    const exec = dryRunExec((l) => printed.push(l), (req) => (req.cmd === 'git' ? { stdout: 'abc\n' } : undefined))
    expect((await exec({ cmd: 'git', args: ['rev-parse', 'HEAD'] })).stdout).toBe('abc\n')
    expect((await exec({ cmd: 'rm', args: ['-rf', '/'] })).code).toBe(0)
    expect(printed).toEqual(['$ git rev-parse HEAD', '$ rm -rf /'])
  })

  it('runs a real process with stdin and reports a timeout', async () => {
    const r = await realExec({ cmd: 'cat', args: [], stdin: 'hello' })
    expect(r).toEqual({ code: 0, stdout: 'hello', stderr: '', timedOut: false })
    const slow = await realExec({ cmd: 'sleep', args: ['5'], timeoutMs: 100 })
    expect(slow.timedOut).toBe(true)
  })

  it('mustRun throws with stderr on a non-zero exit', async () => {
    expect(mustRun(realExec, { cmd: 'sh', args: ['-c', 'echo boom >&2; exit 3'] })).rejects.toThrow(/exit 3.*boom/)
  })
})
