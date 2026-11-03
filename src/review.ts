import { z } from 'zod'
import { FindingSchema, SeveritySchema, type Finding, type Severity } from './types.ts'

const FINDINGS_ARRAY_SCHEMA = {
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
}

export const FINDINGS_JSON_SCHEMA = {
  type: 'object',
  properties: { findings: FINDINGS_ARRAY_SCHEMA },
  required: ['findings'],
  additionalProperties: false,
}

export const VERIFY_JSON_SCHEMA = {
  type: 'object',
  properties: {
    prior: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, resolved: { type: 'boolean' }, note: { type: 'string' } },
        required: ['id', 'resolved', 'note'],
        additionalProperties: false,
      },
    },
    findings: FINDINGS_ARRAY_SCHEMA,
  },
  required: ['prior', 'findings'],
  additionalProperties: false,
}

export function buildReviewArgs(opts: { skill: string; model: string; prompt: string; schema?: object }): string[] {
  return ['-p', '--model', opts.model, '--output-format', 'json', '--json-schema', JSON.stringify(opts.schema ?? FINDINGS_JSON_SCHEMA), `/${opts.skill} ${opts.prompt}`]
}

const VerifyOutputSchema = z.object({
  prior: z.array(z.object({ id: z.string(), resolved: z.boolean(), note: z.string() })),
  findings: z.array(FindingSchema),
})

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
  structured_output: z.unknown().optional(),
})

export type ReviewOutput = { findings: Finding[]; tokens: number; costUsd: number | null }

function parseEnvelope<T>(stdout: string, schema: z.ZodType<T>): { output: T; tokens: number; costUsd: number | null } {
  const parsed = ClaudeResultSchema.parse(JSON.parse(stdout))
  if (!parsed.structured_output) throw new Error('review returned no structured_output')
  const u = parsed.usage
  const tokens = u ? u.input_tokens + u.output_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens : 0
  return { output: schema.parse(parsed.structured_output), tokens, costUsd: parsed.total_cost_usd ?? null }
}

export function parseReviewOutput(stdout: string): ReviewOutput {
  const { output, tokens, costUsd } = parseEnvelope(stdout, z.object({ findings: z.array(FindingSchema) }))
  return { findings: output.findings, tokens, costUsd }
}

export type VerifyOutput = { prior: Array<{ id: string; resolved: boolean; note: string }>; findings: Finding[]; tokens: number; costUsd: number | null }

export function parseVerifyOutput(stdout: string): VerifyOutput {
  const { output, tokens, costUsd } = parseEnvelope(stdout, VerifyOutputSchema)
  return { ...output, tokens, costUsd }
}

const RANK: Record<Severity, number> = { nit: 0, minor: 1, major: 2, blocker: 3 }

export function reviewPasses(findings: Finding[], maxSeverity: 'minor' | 'major'): boolean {
  return findings.every((f) => RANK[f.severity] <= RANK[maxSeverity])
}

export type VerifyVerdict = { pass: boolean; findings: Finding[]; resolved: number; unresolved: number; newFindings: number }

/** A prior id missing from the output counts as unresolved; the first entry for an id wins. */
export function judgeVerify(prior: Array<Finding & { id: string }>, out: Pick<VerifyOutput, 'prior' | 'findings'>, maxSeverity: 'minor' | 'major'): VerifyVerdict {
  const resolvedIds = new Set<string>()
  const seen = new Set<string>()
  for (const p of out.prior) {
    if (seen.has(p.id)) continue
    seen.add(p.id)
    if (p.resolved) resolvedIds.add(p.id)
  }
  const unresolved = prior.filter((f) => !resolvedIds.has(f.id))
  const pass = unresolved.every((f) => RANK[f.severity] <= RANK[maxSeverity]) && reviewPasses(out.findings, maxSeverity)
  const strip = ({ id: _id, ...f }: Finding & { id: string }): Finding => f
  return { pass, findings: [...unresolved.map(strip), ...out.findings], resolved: prior.length - unresolved.length, unresolved: unresolved.length, newFindings: out.findings.length }
}
