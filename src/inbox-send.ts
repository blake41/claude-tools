import { z } from 'zod'

const PayloadSchema = z.object({
  project_path: z.string(),
  thread: z.string(),
  subject: z.string(),
  body: z.string(),
  idempotency_key: z.string(),
  agent_name: z.string().optional(),
})

const ResponseSchema = z.object({
  id: z.number().optional(),
  result: z.object({ isError: z.boolean().optional(), content: z.array(z.unknown()).optional() }).loose().optional(),
  error: z.object({ message: z.string() }).loose().optional(),
})

const bin = process.env.PLANNOTATOR_BIN ?? '/Users/blake/.local/bin/plannotator'
const payload = PayloadSchema.parse(JSON.parse(await Bun.stdin.text()))

const { CLAUDE_CODE_SESSION_ID: _session, CLAUDECODE: _claude, ...env } = process.env
const proc = Bun.spawn([bin, 'inbox', 'mcp'], { cwd: payload.project_path, env, stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' })
const send = (msg: unknown) => {
  proc.stdin.write(`${JSON.stringify(msg)}\n`)
  proc.stdin.flush()
}

send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'epic-runner', version: '0.1.0' } } })

const timer = setTimeout(() => {
  console.error('inbox-send: timed out waiting for the MCP server')
  proc.kill()
  process.exit(2)
}, 45_000)

let buffer = ''
const decoder = new TextDecoder()
for await (const chunk of proc.stdout) {
  buffer += decoder.decode(chunk)
  let nl: number
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl)
    buffer = buffer.slice(nl + 1)
    if (line.trim() === '') continue
    const msg = ResponseSchema.safeParse(JSON.parse(line))
    if (!msg.success) continue
    if (msg.data.id === 1) {
      send({ jsonrpc: '2.0', method: 'notifications/initialized' })
      const { project_path, ...rest } = payload
      send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'send_message', arguments: { project_path, ...rest } } })
    } else if (msg.data.id === 2) {
      clearTimeout(timer)
      console.log(line)
      proc.kill()
      process.exit(msg.data.error || msg.data.result?.isError ? 1 : 0)
    }
  }
}
clearTimeout(timer)
console.error('inbox-send: MCP server closed before answering')
process.exit(1)
