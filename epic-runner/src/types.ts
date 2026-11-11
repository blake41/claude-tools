import { z } from 'zod'

export const SeveritySchema = z.enum(['nit', 'minor', 'major', 'blocker'])
export type Severity = z.infer<typeof SeveritySchema>

export const FindingSchema = z.object({
  severity: SeveritySchema,
  file: z.string(),
  line: z.number().int(),
  summary: z.string(),
})
export type Finding = z.infer<typeof FindingSchema>

const FixLoopSchema = z.object({ model: z.string().min(1), maxRounds: z.number().int().min(0), reReview: z.enum(['verify', 'full']).optional() })

export const GateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ci_green_at_head') }),
  z.object({ kind: z.literal('linear_on_base') }),
  z.object({
    kind: z.literal('review'),
    skill: z.string().min(1),
    model: z.enum(['opus', 'fable', 'sonnet']),
    passWhen: z.object({ maxSeverity: z.enum(['minor', 'major']) }),
    fixLoop: FixLoopSchema.optional(),
  }),
  // Adversarial review always runs on Codex gpt-6-sol (review.ts ADVERSARIAL_MODEL). It has no `skill` or `model`
  // field and the object is strict, so a policy cannot point it at a Claude model.
  z.strictObject({
    kind: z.literal('adversarial_review'),
    passWhen: z.object({ maxSeverity: z.enum(['minor', 'major']) }),
    fixLoop: FixLoopSchema.optional(),
  }),
])
export type Gate = z.infer<typeof GateSchema>
export type ReviewGate = Extract<Gate, { kind: 'review' }>
export type AdversarialGate = Extract<Gate, { kind: 'adversarial_review' }>
/** The gates that review the diff and can start a fix round. */
export type FixableGate = ReviewGate | AdversarialGate
export const isFixableGate = (g: Gate): g is FixableGate => g.kind === 'review' || g.kind === 'adversarial_review'

export const DowngradeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('touches'), globs: z.array(z.string().min(1)).min(1) }),
  z.object({ kind: z.literal('diffLinesOver'), n: z.number().int().positive() }),
  z.object({ kind: z.literal('filesOutsideBeadScope') }),
  z.object({ kind: z.literal('fixRoundsExhausted') }),
])
export type Downgrade = z.infer<typeof DowngradeSchema>

export const OnPassSchema = z.enum(['merge', 'stop_at_pr'])
export type OnPass = z.infer<typeof OnPassSchema>

export const WaveSpecSchema = z.union([
  z.array(z.string().min(1)).min(1),
  z.object({ beads: z.array(z.string().min(1)).min(1), onPass: OnPassSchema.optional() }),
])

const absolutePath = z.string().refine((p) => p.startsWith('/'), 'must be an absolute path')

export const RawPolicySchema = z.object({
  epicId: z.string().min(1),
  repo: absolutePath,
  branch: z.string().min(1),
  base: z.string().min(1).default('master'),
  worktree: absolutePath.optional(),
  prUnit: z.enum(['bead', 'wave', 'epic']).default('wave'),
  waves: z.array(WaveSpecSchema).default([]),
  gates: z.array(GateSchema).default([]),
  // E6: stop_at_pr is the default for every wave. A wave merges only when this field or the wave's own onPass says `merge`.
  onPass: OnPassSchema.default('stop_at_pr'),
  downgradeToStopIf: z.array(DowngradeSchema).optional(),
  beadScopes: z.record(z.string(), z.array(z.string().min(1))).default({}),
  rotateAtTokens: z.number().int().positive().default(300_000),
  workerModel: z.enum(['sonnet', 'opus']).default('sonnet'),
  workerSandbox: z.boolean().default(true),
  herdrSession: z.string().min(1).default('epic'),
  stallMs: z.number().int().positive().default(8 * 60_000),
  idleGraceMs: z.number().int().positive().default(60_000),
  ciWaitMs: z.number().int().positive().default(45 * 60_000),
  tickMs: z.number().int().positive().default(30_000),
  maxRestarts: z.number().int().positive().default(3),
  maxStallNudges: z.number().int().positive().default(3),
  nmWait: z.string().default('8m'),
})

export type WaveSpec = { beads: string[]; onPass: OnPass }

export const DEFAULT_DOWNGRADES: Downgrade[] = [
  {
    kind: 'touches',
    globs: ['prisma/migrations/**', 'render.yaml', '.github/**', 'Dockerfile*', 'scripts/pre-deploy.sh'],
  },
  { kind: 'diffLinesOver', n: 800 },
  { kind: 'filesOutsideBeadScope' },
  { kind: 'fixRoundsExhausted' },
]

function normaliseWaves(raw: z.infer<typeof RawPolicySchema>): WaveSpec[] {
  const specs: WaveSpec[] = raw.waves.map((w) =>
    Array.isArray(w) ? { beads: w, onPass: raw.onPass } : { beads: w.beads, onPass: w.onPass ?? raw.onPass },
  )
  switch (raw.prUnit) {
    case 'wave':
      return specs
    case 'bead':
      return specs.flatMap((w) => w.beads.map((b) => ({ beads: [b], onPass: w.onPass })))
    case 'epic': {
      if (specs.length === 0) return []
      const onPass: OnPass = specs.every((w) => w.onPass === 'merge') ? 'merge' : 'stop_at_pr'
      return [{ beads: specs.flatMap((w) => w.beads), onPass }]
    }
  }
}

export const EpicPolicySchema = RawPolicySchema.transform((raw) => ({
  ...raw,
  waves: normaliseWaves(raw),
  worktree: raw.worktree ?? `${raw.repo}/.claude/worktrees/epic-${raw.epicId}`,
  downgradeToStopIf: raw.downgradeToStopIf ?? DEFAULT_DOWNGRADES,
}))
export type EpicPolicy = z.infer<typeof EpicPolicySchema>

export const BeadStateSchema = z.discriminatedUnion('s', [
  z.object({ s: z.literal('queued') }),
  z.object({
    s: z.literal('working'),
    sessionId: z.string(),
    pane: z.string(),
    startedAt: z.number(),
    restarts: z.number().int(),
  }),
  z.object({ s: z.literal('needs_decision'), sessionId: z.string(), inboxThread: z.string(), since: z.number() }),
  z.object({ s: z.literal('rotating'), fromSession: z.string(), baton: z.string() }),
  z.object({ s: z.literal('committed'), sha: z.string() }),
  z.object({ s: z.literal('parked'), reason: z.string(), thread: z.string().optional() }),
  z.object({ s: z.literal('failed'), reason: z.string() }),
])
export type BeadState = z.infer<typeof BeadStateSchema>

export const GateVerdictSchema = z.object({
  gate: z.enum(['ci_green_at_head', 'linear_on_base', 'review', 'adversarial_review']),
  head: z.string(),
  pass: z.boolean(),
  findings: z.array(FindingSchema).optional(),
  at: z.number(),
})
export type GateVerdict = z.infer<typeof GateVerdictSchema>

export const WaveStateSchema = z.discriminatedUnion('s', [
  z.object({ s: z.literal('building') }),
  z.object({ s: z.literal('validating'), nmRun: z.string() }),
  z.object({ s: z.literal('pr_open'), pr: z.number().int(), head: z.string() }),
  z.object({ s: z.literal('gating'), pr: z.number().int(), head: z.string(), verdicts: z.array(GateVerdictSchema) }),
  z.object({ s: z.literal('merge_ready'), pr: z.number().int(), head: z.string() }),
  z.object({ s: z.literal('stopped_at_pr'), pr: z.number().int(), why: z.string() }),
  z.object({ s: z.literal('merged'), pr: z.number().int(), sha: z.string() }),
])
export type WaveState = z.infer<typeof WaveStateSchema>

export const WorkerJobSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('bead'), beadId: z.string() }),
  z.object({ kind: z.literal('fix'), wave: z.number().int(), round: z.number().int() }),
])
export type WorkerJob = z.infer<typeof WorkerJobSchema>

export const WorkerRunSchema = z.object({
  job: WorkerJobSchema,
  sessionId: z.string(),
  pane: z.string(),
  model: z.string(),
  startedAt: z.number(),
  restarts: z.number().int(),
  statusCursor: z.number().int(),
  lastPromptAt: z.number(),
  protocolNudged: z.boolean(),
  stallNudges: z.number().int(),
  lastStallNudgeAt: z.number().nullable(),
  rotateRequested: z.boolean(),
  waitingOnOwner: z.boolean(),
  doneRejections: z.number().int(),
  lastTokens: z.number().int(),
})
export type WorkerRun = z.infer<typeof WorkerRunSchema>

export const LastReviewSchema = z.object({
  head: z.string(),
  findings: z.array(FindingSchema.extend({ id: z.string() })),
})
export type LastReview = z.infer<typeof LastReviewSchema>

export const WaveRecordSchema = z.object({
  beads: z.array(z.string()),
  onPass: OnPassSchema,
  state: WaveStateSchema,
  fixRounds: z.number().int(),
  gatingSince: z.number().nullable(),
  nmStarted: z.boolean(),
  nmRecoveries: z.number().int().optional(),
  lastReview: LastReviewSchema.optional(),
  lastAdversarial: LastReviewSchema.optional(),
})
export type WaveRecord = z.infer<typeof WaveRecordSchema>

export const RunnerStateSchema = z.object({
  version: z.literal(1),
  epicId: z.string(),
  createdAt: z.number(),
  prepared: z.boolean(),
  beads: z.record(z.string(), BeadStateSchema),
  waves: z.array(WaveRecordSchema),
  workspace: z.object({ id: z.string(), pane: z.string() }).nullable(),
  worker: WorkerRunSchema.nullable(),
  halted: z.object({ reason: z.string(), at: z.number() }).nullable(),
  done: z.boolean(),
})
export type RunnerState = z.infer<typeof RunnerStateSchema>
