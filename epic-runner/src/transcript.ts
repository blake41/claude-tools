import { join } from 'node:path'
import { z } from 'zod'

export function projectSlug(absPath: string): string {
  return absPath.replace(/[/.]/g, '-')
}

export function transcriptPath(projectsDir: string, worktree: string, sessionId: string): string {
  return join(projectsDir, projectSlug(worktree), `${sessionId}.jsonl`)
}

const AssistantLineSchema = z.object({
  type: z.literal('assistant'),
  isSidechain: z.boolean().optional(),
  message: z.object({
    usage: z.object({
      input_tokens: z.number(),
      cache_read_input_tokens: z.number().default(0),
      cache_creation_input_tokens: z.number().default(0),
    }),
  }),
})

export function contextTokens(transcript: string): number | null {
  const lines = transcript.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i]
    if (!raw || !raw.includes('"assistant"')) continue
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch {
      continue
    }
    const parsed = AssistantLineSchema.safeParse(json)
    if (!parsed.success || parsed.data.isSidechain) continue
    const u = parsed.data.message.usage
    return u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
  }
  return null
}
