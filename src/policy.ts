import { EpicPolicySchema, type EpicPolicy } from './types.ts'

export { DEFAULT_DOWNGRADES } from './types.ts'

export function parsePolicyText(text: string, sourceName: string): EpicPolicy {
  const raw: unknown = sourceName.endsWith('.json') ? JSON.parse(text) : Bun.YAML.parse(text)
  const parsed = EpicPolicySchema.safeParse(raw)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
    throw new Error(`invalid policy ${sourceName}: ${issues}`)
  }
  return parsed.data
}

export async function loadPolicy(path: string): Promise<EpicPolicy> {
  return parsePolicyText(await Bun.file(path).text(), path)
}
