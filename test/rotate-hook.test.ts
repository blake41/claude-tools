import { describe, expect, it } from 'bun:test'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realExec } from '../src/exec.ts'

const hook = join(import.meta.dir, '..', 'hooks', 'rotate.sh')

function transcriptWith(cacheRead: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'er-hook-'))
  const path = join(dir, 'sid.jsonl')
  const lines = [
    { type: 'user', message: { content: 'x' } },
    {
      type: 'assistant',
      isSidechain: false,
      message: { usage: { input_tokens: 2, cache_creation_input_tokens: 1000, cache_read_input_tokens: cacheRead, output_tokens: 5 } },
    },
    {
      type: 'assistant',
      isSidechain: true,
      message: { usage: { input_tokens: 1, cache_creation_input_tokens: 1, cache_read_input_tokens: 999999, output_tokens: 1 } },
    },
  ]
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  return path
}

async function runHook(transcript: string, markerDir: string, threshold: number) {
  return realExec({
    cmd: 'bash',
    args: [hook],
    stdin: JSON.stringify({ session_id: 'sid', transcript_path: transcript, hook_event_name: 'PostToolUse', tool_name: 'Bash' }),
    env: { EPIC_RUNNER_ROTATE_AT: String(threshold), EPIC_RUNNER_MARKER_DIR: markerDir, EPIC_RUNNER_STATUS: '/wt/.epic-runner/status' },
  })
}

describe('hooks/rotate.sh', () => {
  it('stays silent below the threshold', async () => {
    const r = await runHook(transcriptWith(50_000), mkdtempSync(join(tmpdir(), 'er-m-')), 300_000)
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('')
  })

  it('emits additionalContext once past the threshold, counting only the main thread', async () => {
    const marker = mkdtempSync(join(tmpdir(), 'er-m-'))
    const t = transcriptWith(310_000)
    const r = await runHook(t, marker, 300_000)
    expect(r.code).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.hookSpecificOutput.hookEventName).toBe('PostToolUse')
    expect(out.hookSpecificOutput.additionalContext).toContain('311002')
    expect(out.hookSpecificOutput.additionalContext).toContain('/baton drop')
    expect(out.hookSpecificOutput.additionalContext).toContain('rotate baton=<path>')
    expect(out.hookSpecificOutput.additionalContext).toContain('/wt/.epic-runner/status')
    expect(existsSync(join(marker, 'rotate-notified-sid'))).toBe(true)
    const again = await runHook(t, marker, 300_000)
    expect(again.stdout).toBe('')
  })
})
