/**
 * Frontend types for the lean trace payload from `GET /api/sessions/:id/trace`.
 *
 * These mirror `LeanSessionDetail` and friends in `server/trace/index.ts`, but
 * are declared independently here rather than imported — the server module
 * pulls in `bun:sqlite`, `fs`, and the vendored claude-devtools pipeline,
 * none of which belong in a browser bundle. Dates travel over the wire as
 * ISO strings (JSON has no Date type), so every `Date` field on the server
 * side is a `string` here.
 *
 * Pass `?full=1` to the endpoint for the untrimmed model (not typed here —
 * only the trace view's own tooling needs it, and it's several MB larger).
 */

export interface TraceSessionMetrics {
  durationMs: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  messageCount: number;
  costUsd?: number;
}

export interface TraceSession {
  id: string;
  projectId: string;
  projectPath: string;
  createdAt: number;
  updatedAt?: number;
  firstMessage?: string;
  hasSubagents: boolean;
  messageCount: number;
  isOngoing?: boolean;
  gitBranch?: string;
  contextConsumption?: number;
  compactionCount?: number;
}

export type TraceStepType = "thinking" | "tool_call" | "tool_result" | "subagent" | "output" | "interruption";

export interface TraceStep {
  id: string;
  type: TraceStepType;
  startTime: string;
  endTime?: string;
  durationMs: number;
  effectiveEndTime?: string;
  effectiveDurationMs?: number;
  isGapFilled?: boolean;
  context: "main" | "subagent";
  agentId?: string;
  isParallel?: boolean;
  groupId?: string;
  tokens?: { input: number; output: number; cached?: number };
  contextTokens?: number;
  accumulatedContext?: number;

  thinkingText?: string;
  thinkingTruncated?: boolean;
  tokenCount?: number;

  toolName?: string;
  toolInput?: unknown;
  toolInputTruncated?: boolean;
  sourceModel?: string;

  toolResultContent?: string;
  toolResultTruncated?: boolean;
  isError?: boolean;
  toolUseResult?: Record<string, unknown>;
  toolUseResultTruncated?: boolean;

  subagentId?: string;
  subagentDescription?: string;

  outputText?: string;
  outputTruncated?: boolean;
  interruptionText?: string;
}

export interface TraceSubagent {
  id: string;
  description?: string;
  subagentType?: string;
  startTime: string;
  endTime: string;
  durationMs: number;
  isParallel: boolean;
  isOngoing?: boolean;
  metrics: TraceSessionMetrics;
  mainSessionImpact?: {
    callTokens: number;
    resultTokens: number;
    totalTokens: number;
  };
  team?: {
    teamName: string;
    memberName: string;
    memberColor: string;
  };
  steps: TraceStep[];
}

interface TraceChunkBase {
  id: string;
  startTime: string;
  endTime: string;
  durationMs: number;
  metrics: TraceSessionMetrics;
}

export interface TraceUserChunk extends TraceChunkBase {
  chunkType: "user";
  text: string;
  hasImage: boolean;
}

export interface TraceSystemChunk extends TraceChunkBase {
  chunkType: "system";
  text: string;
  commandOutput: string;
  commandOutputTruncated?: boolean;
}

export interface TraceCompactChunk extends TraceChunkBase {
  chunkType: "compact";
  text: string;
}

export interface TraceAIChunk extends TraceChunkBase {
  chunkType: "ai";
  steps: TraceStep[];
  subagents: TraceSubagent[];
  contextTokensEnd?: number;
}

export type TraceChunk = TraceUserChunk | TraceSystemChunk | TraceCompactChunk | TraceAIChunk;

export interface TraceSessionDetail {
  session: TraceSession;
  metrics: TraceSessionMetrics;
  models: string[];
  subagentCount: number;
  chunks: TraceChunk[];
  unattachedSubagents: TraceSubagent[];
  fingerprint?: string;
}

/** A `structuredPatch` hunk, as produced by the `diff` npm package (what Edit/MultiEdit/Write tool results carry in `toolUseResult.structuredPatch`). */
export interface StructuredPatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}
