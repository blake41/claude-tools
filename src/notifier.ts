import { mustRun, type Exec } from './exec.ts'

export type Notice = { key: string; subject: string; body: string }

export type Notifier = { send(notice: Notice): Promise<void> }

export function inboxNotifier(exec: Exec, opts: { wrapperPath: string; projectPath: string; thread: string }): Notifier {
  return {
    async send(n) {
      const payload = {
        project_path: opts.projectPath,
        thread: opts.thread,
        subject: n.subject,
        body: n.body,
        idempotency_key: n.key,
        agent_name: 'epic-runner',
      }
      await mustRun(exec, { cmd: 'bun', args: [opts.wrapperPath], stdin: JSON.stringify(payload), timeoutMs: 60_000 })
    },
  }
}
