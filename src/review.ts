import { z } from 'zod'
import { FindingSchema, SeveritySchema, type Finding, type Severity } from './types.ts'

export const FINDINGS_JSON_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: SeveritySchema.options },
          file: { type: 'string' },
          line: { type: 'integer' },
          summary: { type: 'string' },
        },
        required: ['severity', 'file', 'line', 'summary'],
        additionalProperties: false,
      },
    },
  },
  required: ['findings'],
  additionalProperties: false,
}

export function buildReviewArgs(opts: { skill: string; model: string; prompt: string }): string[] {
  return ['-p', '--model', opts.model, '--output-format', 'json', '--json-schema', JSON.stringify(FINDINGS_JSON_SCHEMA), `/${opts.skill} ${opts.prompt}`]
}

const ClaudeResultSchema = z.object({
  is_error: z.boolean().optional(),
  total_cost_usd: z.number().optional(),
  usage: z
    .object({
      input_tokens: z.number().default(0),
      output_tokens: z.number().default(0),
      cache_read_input_tokens: z.number().default(0),
      cache_creation_input_tokens: z.number().default(0),
    })
    .optional(),
  structured_output: z.object({ findings: z.array(FindingSchema) }).optional(),
})

export type ReviewOutput = { findings: Finding[]; tokens: number; costUsd: number | null }

export function parseReviewOutput(stdout: string): ReviewOutput {
  const parsed = ClaudeResultSchema.parse(JSON.parse(stdout))
  if (!parsed.structured_output) throw new Error('review returned no structured_output')
  const u = parsed.usage
  const tokens = u ? u.input_tokens + u.output_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens : 0
  return { findings: parsed.structured_output.findings, tokens, costUsd: parsed.total_cost_usd ?? null }
}

const RANK: Record<Severity, number> = { nit: 0, minor: 1, major: 2, blocker: 3 }

export function reviewPasses(findings: Finding[], maxSeverity: 'minor' | 'major'): boolean {
  return findings.every((f) => RANK[f.severity] <= RANK[maxSeverity])
}
