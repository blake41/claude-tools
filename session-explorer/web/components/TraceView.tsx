import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { MarkdownBody } from "../sessionFormat";
import { formatClockTime, formatDuration, formatTokens, isLong } from "../traceFormat";
import type { TraceAIChunk, TraceChunk, TraceCompactChunk, TraceSessionDetail, TraceSystemChunk, TraceUserChunk } from "../traceTypes";
import { sessionTraceRoute } from "../router";
import StepList from "./TraceSteps";

// ─── Loading / error states ─────────────────────────────────────────────────

function LoadingState({ messageCount }: { messageCount: number | null }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 p-20 text-text-secondary">
      <div className="spinner" />
      <span>
        {messageCount !== null
          ? `Parsing trace for ~${messageCount.toLocaleString()} messages… this can take a few seconds for large sessions.`
          : "Loading trace…"}
      </span>
    </div>
  );
}

function ErrorState({ message, onBack }: { message: string; onBack: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 p-20 text-text-secondary">
      <p>{message}</p>
      <button className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[13px] text-text-secondary rounded-md transition-all hover:text-text hover:bg-white/6" onClick={onBack}>
        Go back
      </button>
    </div>
  );
}

// ─── Header ─────────────────────────────────────────────────────────────────

function StatTile({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wide text-text-dim">{label}</span>
      <span className="text-[13px] font-mono text-text">{value}</span>
    </div>
  );
}

function TraceHeader({ trace }: { trace: TraceSessionDetail }) {
  const { metrics } = trace;
  return (
    <div className="border-b border-border pb-5 mb-6">
      <div className="flex items-center gap-2 mb-1">
        <h1 className="text-xl font-semibold tracking-tight">Trace</h1>
        <span className="font-mono text-[11px] text-text-dim">{trace.session.id.slice(0, 8)}</span>
      </div>
      <div className="flex flex-wrap items-center gap-x-8 gap-y-3 mt-3">
        <StatTile label="Duration" value={formatDuration(metrics.durationMs) || "—"} />
        <StatTile label="Input tokens" value={formatTokens(metrics.inputTokens)} />
        <StatTile label="Output tokens" value={formatTokens(metrics.outputTokens)} />
        <StatTile label="Cache read" value={formatTokens(metrics.cacheReadTokens)} />
        <StatTile label="Cache write" value={formatTokens(metrics.cacheCreationTokens)} />
        <StatTile label="Messages" value={trace.session.messageCount.toLocaleString()} />
        <StatTile label="Subagents" value={trace.subagentCount} />
        <StatTile label="Model(s)" value={trace.models.length > 0 ? trace.models.join(", ") : "—"} />
      </div>
      {trace.unattachedSubagents.length > 0 && (
        <p className="mt-2 text-[11px] text-text-dim">
          {trace.unattachedSubagents.length} subagent{trace.unattachedSubagents.length !== 1 ? "s" : ""} not linked to a specific turn — shown at the end of the timeline.
        </p>
      )}
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

function UserChunkRow({ chunk }: { chunk: TraceUserChunk }) {
  const [expanded, setExpanded] = useState(false);
  const long = isLong(chunk.text);
  const preview = long && !expanded ? chunk.text.slice(0, 280) + "…" : chunk.text;
  return (
    <div className="rounded-lg border border-accent-blue/25 bg-accent-blue/6 px-3.5 py-2.5">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-accent-blue">You</span>
        {chunk.hasImage && <span className="text-[10px] text-text-dim">(includes image)</span>}
        <span className="ml-auto text-[10px] font-mono text-text-dim/60">{formatClockTime(chunk.startTime)}</span>
      </div>
      <div className="text-[13px] text-text leading-relaxed whitespace-pre-wrap">
        <MarkdownBody text={preview} />
      </div>
      {long && (
        <button className="text-[11px] text-accent-blue mt-1 opacity-80 hover:opacity-100" onClick={() => setExpanded((e) => !e)}>
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

function SystemChunkRow({ chunk }: { chunk: TraceSystemChunk }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="rounded-lg border border-border bg-bg-card/60 px-3.5 py-2">
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

function CompactChunkRow({ chunk }: { chunk: TraceCompactChunk }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="my-2">
      <button className="flex items-center gap-3 w-full group" onClick={() => setExpanded((e) => !e)}>
        <div className="flex-1 h-px bg-accent-orange/30" />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-accent-orange whitespace-nowrap px-2 py-0.5 rounded-full bg-accent-orange/10 border border-accent-orange/25">
          Context compacted here
        </span>
        <div className="flex-1 h-px bg-accent-orange/30" />
      </button>
      {expanded && chunk.text && (
        <div className="mt-2 text-[12px] text-text-secondary bg-bg-card/60 border border-border rounded-lg px-3 py-2">
          <MarkdownBody text={chunk.text} />
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

function AIChunkRow({ chunk, maxContextTokens }: { chunk: TraceAIChunk; maxContextTokens: number }) {
  const [expanded, setExpanded] = useState(false);
  const counts = useMemo(() => summarizeSteps(chunk), [chunk]);
  const summaryParts: string[] = [];
  if (counts.thinking > 0) summaryParts.push(`${counts.thinking} thinking`);
  if (counts.tools > 0) summaryParts.push(`${counts.tools} tool call${counts.tools !== 1 ? "s" : ""}`);
  if (chunk.subagents.length > 0) summaryParts.push(`${chunk.subagents.length} subagent${chunk.subagents.length !== 1 ? "s" : ""}`);
  if (counts.interruptions > 0) summaryParts.push(`${counts.interruptions} interruption${counts.interruptions !== 1 ? "s" : ""}`);

  return (
    <div className="rounded-lg border border-border bg-bg-card px-3.5 py-2.5">
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

function ChunkRowImpl({ chunk, maxContextTokens }: { chunk: TraceChunk; maxContextTokens: number }) {
  switch (chunk.chunkType) {
    case "user":
      return <UserChunkRow chunk={chunk} />;
    case "system":
      return <SystemChunkRow chunk={chunk} />;
    case "compact":
      return <CompactChunkRow chunk={chunk} />;
    case "ai":
      return <AIChunkRow chunk={chunk} maxContextTokens={maxContextTokens} />;
    default:
      return null;
  }
}

const ChunkRow = React.memo(ChunkRowImpl);

// ─── Page ───────────────────────────────────────────────────────────────────

export default function TraceView() {
  const { id } = useParams({ from: sessionTraceRoute.id });
  const navigate = useNavigate();
  const [trace, setTrace] = useState<TraceSessionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hintMessageCount, setHintMessageCount] = useState<number | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    setTrace(null);

    // Cheap DB-backed lookup purely for a size-aware loading message — the
    // heavy trace parse below doesn't depend on this and isn't gated by it.
    fetch(`/api/sessions/${id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data && typeof data.message_count === "number") setHintMessageCount(data.message_count);
      })
      .catch(() => {});

    fetch(`/api/sessions/${id}/trace`)
      .then(async (r) => {
        if (r.status === 404) {
          throw new Error("Raw transcript no longer on disk and not archived.");
        }
        if (!r.ok) {
          const body = await r.json().catch(() => null);
          throw new Error(body?.error || "Failed to build session trace.");
        }
        return r.json();
      })
      .then((data: TraceSessionDetail) => setTrace(data))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [id]);

  const maxContextTokens = useMemo(() => {
    if (!trace) return 0;
    let max = 0;
    for (const c of trace.chunks) {
      if (c.chunkType === "ai" && c.contextTokensEnd !== undefined) max = Math.max(max, c.contextTokensEnd);
    }
    return max;
  }, [trace]);

  if (loading) return <LoadingState messageCount={hintMessageCount} />;
  if (error || !trace) return <ErrorState message={error || "Trace not found."} onBack={() => navigate({ to: "/session/$id", params: { id } })} />;

  return (
    <div className="max-w-[1100px] mx-auto px-10 pt-6 pb-20">
      <div className="flex items-center gap-1 mb-4">
        <button
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[13px] text-text-secondary rounded-md transition-all hover:text-text hover:bg-white/6"
          onClick={() => navigate({ to: "/session/$id", params: { id } })}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M10 12L6 8L10 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Back to session
        </button>
      </div>

      <TraceHeader trace={trace} />

      <div className="flex flex-col gap-2.5">
        {trace.chunks.map((chunk) => (
          <ChunkRow key={chunk.id} chunk={chunk} maxContextTokens={maxContextTokens} />
        ))}
      </div>

      {trace.unattachedSubagents.length > 0 && (
        <div className="mt-6 pt-4 border-t border-border">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-text-dim mb-2">Unlinked subagents</h3>
          <StepList steps={[]} subagents={trace.unattachedSubagents} />
        </div>
      )}
    </div>
  );
}
