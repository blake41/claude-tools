import React, { useMemo, useState } from "react";
import { MarkdownBody } from "../sessionFormat";
import { formatClockTime, formatDuration, formatTokens, isLong } from "../traceFormat";
import type { StructuredPatchHunk, TraceStep, TraceSubagent } from "../traceTypes";
import { usePersistedExpand } from "../hooks/usePersistedExpand";
import TraceDiff from "./TraceDiff";

// ─── Row model ──────────────────────────────────────────────────────────────
// Tool calls and their results share the same `id` (SemanticStepExtractor
// mints the tool_call step's id from the tool_use block and the tool_result
// step's id from ToolResult.toolUseId, which is the same value) — pairing on
// that id lets the UI render one "tool" row instead of two disconnected ones.
// `type: 'subagent'` steps are dropped from the step list entirely: they're a
// lightweight marker the vendor pipeline uses for context-token accounting,
// and this view renders the same information (plus a full step outline) via
// the chunk's own `subagents[]` array instead.

type Row =
  | { kind: "step"; key: string; step: TraceStep; result?: TraceStep }
  | { kind: "subagent"; key: string; subagent: TraceSubagent };

function rowStartMs(row: Row): number {
  const iso = row.kind === "step" ? row.step.startTime : row.subagent.startTime;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? 0 : t;
}

function buildRows(steps: TraceStep[], subagents: TraceSubagent[]): Row[] {
  const resultById = new Map<string, TraceStep>();
  for (const s of steps) {
    if (s.type === "tool_result") resultById.set(s.id, s);
  }

  const rows: Row[] = [];
  for (const s of steps) {
    if (s.type === "tool_result" || s.type === "subagent") continue; // paired or rendered via subagents[]
    rows.push({
      kind: "step",
      key: s.id,
      step: s,
      result: s.type === "tool_call" ? resultById.get(s.id) : undefined,
    });
  }
  for (const sub of subagents) {
    rows.push({ kind: "subagent", key: `subagent-${sub.id}`, subagent: sub });
  }

  rows.sort((a, b) => rowStartMs(a) - rowStartMs(b));
  return rows;
}

// ─── Shared bits ────────────────────────────────────────────────────────────

function Badge({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "error" | "accent" }) {
  const cls =
    tone === "error"
      ? "bg-accent-red/12 text-accent-red"
      : tone === "accent"
        ? "bg-accent-purple/12 text-accent-purple"
        : "bg-white/6 text-text-dim";
  return (
    <span className={`inline-flex items-center px-1.5 py-px rounded text-[10px] font-medium font-mono whitespace-nowrap ${cls}`}>
      {children}
    </span>
  );
}

function StepRow({ icon, label, badges, time, children, defaultOpen }: {
  icon: React.ReactNode;
  label: React.ReactNode;
  badges?: React.ReactNode;
  time?: string;
  children?: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  const hasBody = children !== undefined && children !== null;
  return (
    <div className="border border-border/60 rounded-md bg-bg-card/60 overflow-hidden">
      <button
        className="flex items-center gap-2 w-full px-2.5 py-1.5 text-left transition-colors hover:bg-white/4"
        onClick={() => hasBody && setOpen((o) => !o)}
        disabled={!hasBody}
      >
        <span className="shrink-0 text-text-dim">{icon}</span>
        <span className="text-[12px] text-text-secondary truncate flex-1 min-w-0">{label}</span>
        <div className="flex items-center gap-1 shrink-0">{badges}</div>
        {time && <span className="text-[10px] font-mono text-text-dim/60 shrink-0">{time}</span>}
        {hasBody && (
          <svg width="10" height="10" viewBox="0 0 12 12" fill="none" className="shrink-0 text-text-dim" style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform 0.12s" }}>
            <path d="M4 2L8 6L4 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </button>
      {open && hasBody && <div className="px-2.5 pb-2.5 pt-1 border-t border-border/40">{children}</div>}
    </div>
  );
}

const THINKING_ICON = (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M8 1a5 5 0 00-3 9v1.5h6V10a5 5 0 00-3-9z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /><path d="M6 14h4M6.5 12.5h3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
);
const TOOL_ICON = (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M0 2.75C0 1.784.784 1 1.75 1h12.5c.966 0 1.75.784 1.75 1.75v10.5A1.75 1.75 0 0114.25 15H1.75A1.75 1.75 0 010 13.25zm1.75-.25a.25.25 0 00-.25.25v10.5c0 .138.112.25.25.25h12.5a.25.25 0 00.25-.25V2.75a.25.25 0 00-.25-.25zM7.25 8a.749.749 0 01-.22.53l-2.25 2.25a.749.749 0 11-1.06-1.06L5.44 8 3.72 6.28a.749.749 0 111.06-1.06l2.25 2.25c.141.14.22.331.22.53zm1.5 1.5h3a.75.75 0 010 1.5h-3a.75.75 0 010-1.5z" /></svg>
);
const OUTPUT_ICON = (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M2 3.5A1.5 1.5 0 013.5 2h9A1.5 1.5 0 0114 3.5v9a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 12.5v-9z" stroke="currentColor" strokeWidth="1.3" /><path d="M4.5 5.5h7M4.5 8h7M4.5 10.5h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
);
const SUBAGENT_ICON = (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="4.5" r="2" stroke="currentColor" strokeWidth="1.3" /><path d="M4 13c0-1.8 1.8-3.2 4-3.2s4 1.4 4 3.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /><circle cx="3" cy="12.5" r="1.3" stroke="currentColor" strokeWidth="1.1" /><circle cx="13" cy="12.5" r="1.3" stroke="currentColor" strokeWidth="1.1" /></svg>
);
const INTERRUPT_ICON = (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M8 1v8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /><circle cx="8" cy="12.5" r="1" fill="currentColor" /></svg>
);

// ─── Per-type rows ──────────────────────────────────────────────────────────

function ThinkingStepRow({ step }: { step: TraceStep }) {
  const text = step.thinkingText ?? "";
  return (
    <StepRow
      icon={THINKING_ICON}
      label="Thinking"
      time={formatClockTime(step.startTime)}
      badges={<>
        {step.tokenCount !== undefined && <Badge>{formatTokens(step.tokenCount)} tok</Badge>}
        {step.thinkingTruncated && <Badge tone="error">truncated</Badge>}
      </>}
    >
      {text && <MarkdownBody text={text} />}
    </StepRow>
  );
}

// The assistant's actual response text — unlike thinking/tool-call steps,
// this is the payload the user came here to read, so it renders fully
// visible by default (same full-text/"Show more" pattern as TraceView's
// UserChunkRow) instead of behind the click-to-reveal StepRow accordion.
// Keyed by the step's own id (unique per step, see the Row model doc at the
// top of this file) rather than a chunk id, so expand state persists across
// virtualization remounts without colliding with the parent chunk's own
// persisted-expand entry.
function OutputStepRow({ step }: { step: TraceStep }) {
  const text = step.outputText ?? "";
  const [expanded, setExpanded] = usePersistedExpand(`step-${step.id}`);
  const long = isLong(text);
  const preview = long && !expanded ? text.slice(0, 280) + "…" : text;
  return (
    <div className="border border-border/60 rounded-md bg-bg-card/60 px-2.5 py-2">
      <div className="flex items-center gap-2 mb-1">
        <span className="shrink-0 text-text-dim">{OUTPUT_ICON}</span>
        <span className="text-[10px] font-semibold uppercase tracking-wide text-text-dim flex-1 min-w-0">Response</span>
        {step.tokenCount !== undefined && <Badge>{formatTokens(step.tokenCount)} tok</Badge>}
        {step.outputTruncated && <Badge tone="error">truncated</Badge>}
        <span className="text-[10px] font-mono text-text-dim/60 shrink-0">{formatClockTime(step.startTime)}</span>
      </div>
      <div className="text-[13px] text-text leading-relaxed whitespace-pre-wrap">
        {text ? <MarkdownBody text={preview} /> : <span className="text-text-dim italic">(empty)</span>}
      </div>
      {long && (
        <button className="text-[11px] text-accent-blue mt-1 opacity-80 hover:opacity-100" onClick={() => setExpanded((e) => !e)}>
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

function InterruptionStepRow({ step }: { step: TraceStep }) {
  return (
    <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-accent-orange/8 border border-accent-orange/20 text-[11px] text-accent-orange">
      <span className="shrink-0">{INTERRUPT_ICON}</span>
      {step.interruptionText || "Request interrupted by user"}
    </div>
  );
}

/** JSON.stringify with a fallback for values that can't be serialized cleanly. */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function ToolStepRow({ step, result }: { step: TraceStep; result?: TraceStep }) {
  const inputJson = useMemo(() => safeJson(step.toolInput ?? {}), [step.toolInput]);
  const patch = result?.toolUseResult?.structuredPatch as StructuredPatchHunk[] | undefined;
  const isError = !!result?.isError;
  const duration = step.effectiveDurationMs ?? step.durationMs;

  return (
    <StepRow
      icon={TOOL_ICON}
      label={step.toolName ?? "Tool"}
      time={formatClockTime(step.startTime)}
      badges={<>
        {duration > 0 && <Badge>{formatDuration(duration)}</Badge>}
        {isError && <Badge tone="error">error</Badge>}
        {!result && <Badge>pending</Badge>}
      </>}
      defaultOpen={false}
    >
      <div className="flex flex-col gap-2">
        {inputJson !== "{}" && (
          <div>
            <div className="text-[10px] uppercase tracking-wide text-text-dim mb-1">Input{step.toolInputTruncated ? " (truncated)" : ""}</div>
            <pre className="tool-mini-code rounded px-2 py-1.5 text-[11px]">{inputJson}</pre>
          </div>
        )}
        {Array.isArray(patch) && patch.length > 0 && (
          <div>
            <div className="text-[10px] uppercase tracking-wide text-text-dim mb-1">Diff</div>
            <TraceDiff hunks={patch} />
          </div>
        )}
        {result && !patch && result.toolResultContent && (
          <div>
            <div className={`text-[10px] uppercase tracking-wide mb-1 ${isError ? "text-accent-red" : "text-text-dim"}`}>
              Result{result.toolResultTruncated ? " (truncated)" : ""}
            </div>
            <pre className={`tool-mini-code rounded px-2 py-1.5 text-[11px] ${isError ? "text-accent-red" : ""}`}>{result.toolResultContent}</pre>
          </div>
        )}
      </div>
    </StepRow>
  );
}

function SubagentPanel({ subagent }: { subagent: TraceSubagent }) {
  const rows = useMemo(() => buildRows(subagent.steps, []), [subagent.steps]);
  return (
    <StepRow
      icon={SUBAGENT_ICON}
      label={subagent.description || subagent.subagentType || subagent.id}
      time={formatClockTime(subagent.startTime)}
      badges={<>
        {subagent.subagentType && <Badge tone="accent">{subagent.subagentType}</Badge>}
        <Badge>{formatDuration(subagent.durationMs)}</Badge>
        <Badge>{formatTokens(subagent.metrics.totalTokens)} tok</Badge>
      </>}
    >
      <div className="flex flex-col gap-1.5">
        {rows.length === 0 && <div className="text-[11px] text-text-dim py-1">No steps recorded for this subagent.</div>}
        {rows.map((row) => <RowRenderer key={row.key} row={row} />)}
      </div>
    </StepRow>
  );
}

function RowRenderer({ row }: { row: Row }) {
  if (row.kind === "subagent") return <SubagentPanel subagent={row.subagent} />;
  const { step, result } = row;
  switch (step.type) {
    case "thinking":
      return <ThinkingStepRow step={step} />;
    case "tool_call":
      return <ToolStepRow step={step} result={result} />;
    case "output":
      return <OutputStepRow step={step} />;
    case "interruption":
      return <InterruptionStepRow step={step} />;
    default:
      return null;
  }
}

const MemoRowRenderer = React.memo(RowRenderer);

/** Renders a chunk's (or subagent's) steps + nested subagent panels, interleaved chronologically. Collapsed by default at every level — see the module doc on Row above for why tool_call/tool_result pair up and `subagent` steps are dropped in favor of the subagents[] panels. */
export default function StepList({ steps, subagents }: { steps: TraceStep[]; subagents: TraceSubagent[] }) {
  const rows = useMemo(() => buildRows(steps, subagents), [steps, subagents]);
  if (rows.length === 0) {
    return <div className="text-[11px] text-text-dim py-1">No steps in this turn.</div>;
  }
  return (
    <div className="flex flex-col gap-1.5">
      {rows.map((row) => <MemoRowRenderer key={row.key} row={row} />)}
    </div>
  );
}
