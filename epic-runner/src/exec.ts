export type ExecRequest = {
  cmd: string
  args: string[]
  cwd?: string
  timeoutMs?: number
  stdin?: string
  env?: Record<string, string>
}

export type ExecResult = { code: number; stdout: string; stderr: string; timedOut: boolean }

export type Exec = (req: ExecRequest) => Promise<ExecResult>

export const realExec: Exec = async (req) => {
  const proc = Bun.spawn([req.cmd, ...req.args], {
    cwd: req.cwd,
    env: req.env ? { ...process.env, ...req.env } : process.env,
    stdin: req.stdin === undefined ? 'ignore' : new TextEncoder().encode(req.stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  let timedOut = false
  const timer =
    req.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true
          proc.kill('SIGKILL')
        }, req.timeoutMs)
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (timer) clearTimeout(timer)
  return { code, stdout, stderr, timedOut }
}

function quote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`
}

export function formatCommand(req: ExecRequest): string {
  const line = [req.cmd, ...req.args].map(quote).join(' ')
  return req.cwd ? `(cd ${quote(req.cwd)} && ${line})` : line
}

export function dryRunExec(
  print: (line: string) => void,
  canned: (req: ExecRequest) => Partial<ExecResult> | undefined = () => undefined,
): Exec {
  return async (req) => {
    print(`$ ${formatCommand(req)}`)
    return { code: 0, stdout: '', stderr: '', timedOut: false, ...canned(req) }
  }
}

export class ExecError extends Error {
  constructor(
    readonly req: ExecRequest,
    readonly result: ExecResult,
  ) {
    super(
      `${formatCommand(req)} failed (${result.timedOut ? 'timeout' : `exit ${result.code}`}): ${(result.stderr || result.stdout).trim().slice(0, 500)}`,
    )
  }
}

export async function mustRun(exec: Exec, req: ExecRequest): Promise<string> {
  const result = await exec(req)
  if (result.code !== 0 || result.timedOut) throw new ExecError(req, result)
  return result.stdout
}
