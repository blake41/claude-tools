import React, { useMemo } from "react";
import { MarkdownBody } from "../sessionFormat";
import { formatClockTime, formatDuration, formatTokens, isLong } from "../traceFormat";
import type { TraceAIChunk, TraceChunk, TraceCompactChunk, TraceSessionDetail, TraceSystemChunk, TraceUserChunk } from "../traceTypes";
import { usePersistedExpand } from "../hooks/usePersistedExpand";
import StepList from "./TraceSteps";

// Chunk-row renderers for the full-fidelity trace view (thinking blocks,
// tool-call icons/durations/tokens, subagent nesting, diffs). Originally the
// standalone `/session/$id/trace` page; that page is gone (the trace and
// message views were merged into a single `/session/$id` page — plan U9/M1)
// but this module's exports (`ChunkRow`, `TraceStatsBar`) are reused as-is
// by `SessionDetail.tsx`, which now virtualizes `trace.chunks` directly
// instead of the old windowed-`messages` turn model. Each chunk row's
// expand/collapse state goes through the shared `usePersistedExpand` store
// (keyed by chunk id) so it survives the row unmounting/remounting as it
// scrolls out of and back into the virtualizer's rendered range — under the
// old standalone page every chunk was mounted at once, so this wasn't a
// concern there.

// ─── Header stats ───────────────────────────────────────────────────────────

function StatTile({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wide text-text-dim">{label}</span>
      <span className="text-[13px] font-mono text-text">{value}</span>
    </div>
  );
}

/** Compact stats row (duration, tokens, cache, messages, subagents, models) —
 *  the merged session page renders its own title/session-id header
 *  (`SessionHeader`), so this intentionally omits the old standalone page's
 *  "Trace" heading. */
export function TraceStatsBar({ trace }: { trace: TraceSessionDetail }) {
  const { metrics } = trace;
  return (
    <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
      <StatTile label="Duration" value={formatDuration(metrics.durationMs) || "—"} />
      <StatTile label="Input tokens" value={formatTokens(metrics.inputTokens)} />
      <StatTile label="Output tokens" value={formatTokens(metrics.outputTokens)} />
      <StatTile label="Cache read" value={formatTokens(metrics.cacheReadTokens)} />
      <StatTile label="Cache write" value={formatTokens(metrics.cacheCreationTokens)} />
      <StatTile label="Messages" value={trace.session.messageCount.toLocaleString()} />
      <StatTile label="Subagents" value={trace.subagentCount} />
      <StatTile label="Model(s)" value={trace.models.length > 0 ? trace.models.join(", ") : "—"} />
    </div>
  );
}

// ─── Chunk rows ─────────────────────────────────────────────────────────────

function ChunkContextBar({ tokens, max }: { tokens: number | undefined; max: number }) {
  if (tokens === undefined || max <= 0) return null;
  const pct = Math.min(100, Math.round((tokens / max) * 100));
  return (
    <div className="flex items-center gap-1.5 shrink-0 w-[92px]" title={`${tokens.toLocaleString()} tokens in context`}>
      <div className="flex-1 h-[4px] rounded-full bg-white/6 overflow-hidden">
        <div className="h-full bg-accent-blue/60 rounded-full" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[9px] font-mono text-text-dim w-[34px] text-right">{formatTokens(tokens)}</span>
    </div>
  );
}

function UserChunkRow({ chunk, highlight }: { chunk: TraceUserChunk; highlight: boolean }) {
  const [storedExpanded, setExpanded] = usePersistedExpand(`chunk-${chunk.id}`);
  const expanded = storedExpanded || highlight;
  const long = isLong(chunk.text);
  const preview = long && !expanded ? chunk.text.slice(0, 280) + "…" : chunk.text;
  return (
    <div className={`rounded-lg border border-accent-blue/25 bg-accent-blue/6 px-3.5 py-2.5 ${highlight ? "message-highlight" : ""}`}>
      <div className="flex items-center gap-2 mb-1">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-accent-blue">You</span>
        {chunk.hasImage && <span className="text-[10px] text-text-dim">(includes image)</span>}
        <span className="ml-auto text-[10px] font-mono text-text-dim/60">{formatClockTime(chunk.startTime)}</span>
      </div>
      <div className="text-[13px] text-text leading-relaxed whitespace-pre-wrap">
        <MarkdownBody text={expanded && chunk.textTruncated ? preview + "\n… (truncated)" : preview} />
      </div>
      {long && (
        <button className="text-[11px] text-accent-blue mt-1 opacity-80 hover:opacity-100" onClick={() => setExpanded((e) => !e)}>
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

function SystemChunkRow({ chunk, highlight }: { chunk: TraceSystemChunk; highlight: boolean }) {
  const [storedExpanded, setExpanded] = usePersistedExpand(`chunk-${chunk.id}`);
  const expanded = storedExpanded || highlight;
  return (
    <div className={`rounded-lg border border-border bg-bg-card/60 px-3.5 py-2 ${highlight ? "message-highlight" : ""}`}>
      <button className="flex items-center gap-2 w-full text-left" onClick={() => setExpanded((e) => !e)}>
        <span className="text-[10px] font-semibold uppercase tracking-wider text-text-dim">System</span>
        <span className="text-[12px] text-text-secondary truncate flex-1 min-w-0">{chunk.text || "(command output)"}</span>
        <span className="text-[10px] font-mono text-text-dim/60 shrink-0">{formatClockTime(chunk.startTime)}</span>
      </button>
      {expanded && chunk.commandOutput && (
        <pre className="tool-mini-code mt-2 rounded px-2 py-1.5 text-[11px]">
          {chunk.commandOutput}
          {chunk.commandOutputTruncated ? "\n… (truncated)" : ""}
        </pre>
      )}
    </div>
  );
}

function CompactChunkRow({ chunk, highlight }: { chunk: TraceCompactChunk; highlight: boolean }) {
  const [storedExpanded, setExpanded] = usePersistedExpand(`chunk-${chunk.id}`);
  const expanded = storedExpanded || highlight;
  return (
    <div className={`my-2 ${highlight ? "message-highlight" : ""}`}>
      <button className="flex items-center gap-3 w-full group" onClick={() => setExpanded((e) => !e)}>
        <div className="flex-1 h-px bg-accent-orange/30" />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-accent-orange whitespace-nowrap px-2 py-0.5 rounded-full bg-accent-orange/10 border border-accent-orange/25">
          Context compacted here
        </span>
        <div className="flex-1 h-px bg-accent-orange/30" />
      </button>
      {expanded && chunk.text && (
        <div className="mt-2 text-[12px] text-text-secondary bg-bg-card/60 border border-border rounded-lg px-3 py-2">
          <MarkdownBody text={chunk.textTruncated ? chunk.text + "\n… (truncated)" : chunk.text} />
        </div>
      )}
    </div>
  );
}

function summarizeSteps(chunk: TraceAIChunk): { thinking: number; tools: number; output: number; interruptions: number } {
  let thinking = 0, tools = 0, output = 0, interruptions = 0;
  for (const s of chunk.steps) {
    if (s.type === "thinking") thinking++;
    else if (s.type === "tool_call") tools++;
    else if (s.type === "output") output++;
    else if (s.type === "interruption") interruptions++;
  }
  return { thinking, tools, output, interruptions };
}

function AIChunkRow({ chunk, maxContextTokens, highlight }: { chunk: TraceAIChunk; maxContextTokens: number; highlight: boolean }) {
  const [storedExpanded, setExpanded] = usePersistedExpand(`chunk-${chunk.id}`);
  const expanded = storedExpanded || highlight;
  const counts = useMemo(() => summarizeSteps(chunk), [chunk]);
  const summaryParts: string[] = [];
  if (counts.thinking > 0) summaryParts.push(`${counts.thinking} thinking`);
  if (counts.tools > 0) summaryParts.push(`${counts.tools} tool call${counts.tools !== 1 ? "s" : ""}`);
  if (chunk.subagents.length > 0) summaryParts.push(`${chunk.subagents.length} subagent${chunk.subagents.length !== 1 ? "s" : ""}`);
  if (counts.interruptions > 0) summaryParts.push(`${counts.interruptions} interruption${counts.interruptions !== 1 ? "s" : ""}`);

  return (
    <div className={`rounded-lg border border-border bg-bg-card px-3.5 py-2.5 ${highlight ? "message-highlight" : ""}`}>
      <button className="flex items-center gap-2.5 w-full text-left" onClick={() => setExpanded((e) => !e)}>
        <span className="text-[10px] font-semibold uppercase tracking-wider text-accent-purple shrink-0">Claude</span>
        <span className="text-[12px] text-text-secondary truncate flex-1 min-w-0">{summaryParts.join(" · ") || "(no steps)"}</span>
        <ChunkContextBar tokens={chunk.contextTokensEnd} max={maxContextTokens} />
        <span className="text-[10px] font-mono text-text-dim shrink-0">{formatDuration(chunk.durationMs)}</span>
        <svg width="10" height="10" viewBox="0 0 12 12" fill="none" className="shrink-0 text-text-dim" style={{ transform: expanded ? "rotate(90deg)" : "none", transition: "transform 0.12s" }}>
          <path d="M4 2L8 6L4 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {expanded && (
        <div className="mt-2.5 pt-2.5 border-t border-border/40">
          <StepList steps={chunk.steps} subagents={chunk.subagents} />
        </div>
      )}
    </div>
  );
}

function ChunkRowImpl({ chunk, maxContextTokens, highlight }: { chunk: TraceChunk; maxContextTokens: number; highlight: boolean }) {
  switch (chunk.chunkType) {
    case "user":
      return <UserChunkRow chunk={chunk} highlight={highlight} />;
    case "system":
      return <SystemChunkRow chunk={chunk} highlight={highlight} />;
    case "compact":
      return <CompactChunkRow chunk={chunk} highlight={highlight} />;
    case "ai":
      return <AIChunkRow chunk={chunk} maxContextTokens={maxContextTokens} highlight={highlight} />;
    default:
      return null;
  }
}

/** One row in the merged session page's virtualized trace list. Memoized —
 *  `SessionDetail` re-renders on every keystroke of in-page search, and most
 *  rows' props (`chunk`, `maxContextTokens`) never change between renders. */
export const ChunkRow = React.memo(ChunkRowImpl);

/** Best-effort searchable text for a chunk — used by the merged page's
 *  in-page search (Cmd+F) to match against everything a chunk can show when
 *  expanded, not just its collapsed-row summary. */
export function chunkSearchText(chunk: TraceChunk): string {
  switch (chunk.chunkType) {
    case "user":
      return chunk.text;
    case "system":
      return `${chunk.text}\n${chunk.commandOutput}`;
    case "compact":
      return chunk.text;
    case "ai": {
      const parts: string[] = [];
      const walkSteps = (steps: TraceAIChunk["steps"]) => {
        for (const s of steps) {
          if (s.thinkingText) parts.push(s.thinkingText);
          if (s.toolName) parts.push(s.toolName);
          if (s.toolInput !== undefined) {
            try { parts.push(JSON.stringify(s.toolInput)); } catch { /* ignore */ }
          }
          if (s.toolResultContent) parts.push(s.toolResultContent);
          if (s.outputText) parts.push(s.outputText);
          if (s.interruptionText) parts.push(s.interruptionText);
        }
      };
      walkSteps(chunk.steps);
      for (const sub of chunk.subagents) {
        if (sub.description) parts.push(sub.description);
        walkSteps(sub.steps);
      }
      return parts.join("\n");
    }
    default:
      return "";
  }
}
