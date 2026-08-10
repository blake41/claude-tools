/**
 * Formatting helpers shared by the trace view components (TraceView, TraceSteps).
 * Pure string formatting only — no DOM/layout reads, so nothing here needs the
 * scrollHeight-on-content-string discipline that CollapsibleContent uses.
 */

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || Number.isNaN(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  const remS = Math.round(s % 60);
  return remS > 0 ? `${m}m ${remS}s` : `${m}m`;
}

export function formatTokens(n: number | undefined): string {
  if (!n) return "0";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function formatClockTime(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
}

/** String-length heuristic for "is this worth collapsing" — deliberately not a
 *  scrollHeight/DOM read (see CollapsibleContent's own comment on why that's a
 *  perf trap when keyed on anything but a stable content string). */
export function isLong(text: string | undefined, threshold = 320): boolean {
  return !!text && text.length > threshold;
}
