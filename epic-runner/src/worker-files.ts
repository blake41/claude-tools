import { join } from 'node:path'

export type WorkerPaths = {
  dir: string
  status: string
  settings: string
  gitignore: string
  brief: (jobKey: string) => string
}

export function workerPaths(worktree: string): WorkerPaths {
  const dir = join(worktree, '.epic-runner')
  return {
    dir,
    status: join(dir, 'status'),
    settings: join(dir, 'settings.json'),
    gitignore: join(dir, '.gitignore'),
    brief: (jobKey) => join(dir, `brief-${jobKey.replace(/[^\w.-]/g, '_')}.md`),
  }
}

function shq(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`
}

export function workerSettings(opts: { hookPath: string; rotateAt: number; paths: WorkerPaths; sandbox: boolean }): string {
  const command = [
    `EPIC_RUNNER_ROTATE_AT=${opts.rotateAt}`,
    `EPIC_RUNNER_MARKER_DIR=${shq(opts.paths.dir)}`,
    `EPIC_RUNNER_STATUS=${shq(opts.paths.status)}`,
    'bash',
    shq(opts.hookPath),
  ].join(' ')
  const settings = {
    hooks: { PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command }] }] },
    ...(opts.sandbox ? { sandbox: { enabled: true } } : {}),
  }
  return `${JSON.stringify(settings, null, 2)}\n`
}
