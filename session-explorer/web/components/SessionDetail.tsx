import { useState, useEffect, useRef, useCallback, useMemo, useLayoutEffect } from "react";
import { useParams, useNavigate, useSearch } from "@tanstack/react-router";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import type { SessionDetail as SessionDetailType, Tag, FileReference, Message } from "../types";
import type { TraceChunk, TraceSessionDetail, TraceStep } from "../traceTypes";
import { categorizeFileRefs } from "../fileCategories";
import { INSIGHT_TYPE_COLORS } from "../insight-shared";
import { useExtraction } from "../hooks/useExtraction";
import { ExpandStoreContext } from "../hooks/usePersistedExpand";
import { MarkdownBody } from "../sessionFormat";
import { formatClockTime } from "../traceFormat";
import SessionHeader from "./SessionHeader";
import { sessionRoute } from "../router";
import { ChunkRow, TraceStatsBar, chunkSearchText } from "./TraceView";
import StepList from "./TraceSteps";

// ── Full-fidelity single session page (plan U9/M1) ─────────────────────
// This used to be two pages: a paginated messages-table view (this file)
// and a separate full-fidelity `/session/$id/trace` page (TraceView.tsx —
// thinking blocks, tool-call durations/tokens, subagent nesting, diffs).
// They're merged: this page now fetches the SAME full trace payload
// TraceView used to (`GET /api/sessions/:id/trace`, one request — it's a
// fast precomputed-row read, not a re-parse, so there's no pagination
// concern) and virtualizes `trace.chunks` directly via `ChunkRow` (moved
// into TraceView.tsx as a reusable renderer). The old windowed
// `/api/sessions/:id/messages` fetch loop and its `messages`-table
// rendering (MessageBubble/AssistantTurnBlock/ToolGroupBlock) are gone —
// they rendered from the `messages` table, which deliberately drops
// `thinking` blocks (see server/projection.ts), so they could never show
// full fidelity anyway.

function FilesPanel({ sessionId }: { sessionId: string }) {
  const [files, setFiles] = useState<FileReference[]>([]);
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!open || loaded) return;
    fetch(`/api/sessions/${sessionId}/files`)
      .then((r) => r.json())
      .then((data) => setFiles(data.files || []))
      .catch(() => setFiles([]))
      .finally(() => setLoaded(true));
  }, [sessionId, open, loaded]);

  const cats = categorizeFileRefs(files);
  const totalCount = loaded ? files.length : null;

  function FileEntry({ file }: { file: FileReference }) {
    return (
      <div className="flex items-center gap-1.5 py-0.5 group">
        <span className={`operation-badge operation-${file.operation} inline-block px-1.5 py-px rounded text-[9px] font-semibold uppercase tracking-wide shrink-0`}>
          {file.operation === "write" ? "new" : file.operation}
        </span>
        <a
          className="font-mono text-xs text-text-secondary overflow-hidden text-ellipsis whitespace-nowrap flex-1 no-underline hover:text-accent-blue hover:underline"
          href={`vscode://file${file.file_path}`}
          title={`Open in VS Code: ${file.file_path}`}
        >
          {file.file_path}
        </a>
        <button
          className="shrink-0 p-0.5 rounded text-text-dim opacity-0 transition-all group-hover:opacity-100 hover:text-text hover:bg-white/8"
          title="Copy path"
          onClick={() => navigator.clipboard.writeText(file.file_path)}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <rect x="5" y="5" width="9" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
            <path d="M3 11V3.5A1.5 1.5 0 014.5 2H10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    );
  }

  const sections: Array<{ key: string; label: string; cls: string; files: FileReference[] }> = [];
  if (cats.docs.length > 0) sections.push({ key: "docs", label: "Docs", cls: "file-cat-docs", files: cats.docs });
  if (cats.viz.length > 0) sections.push({ key: "viz", label: "Viz", cls: "file-cat-viz", files: cats.viz });
  if (cats.code.length > 0) sections.push({ key: "code", label: "Code", cls: "file-cat-code", files: cats.code });

  return (
    <div className="mb-5 border border-border rounded-lg bg-bg-card overflow-hidden">
      <button className="flex items-center gap-2 w-full px-3.5 py-2.5 text-[13px] font-medium text-text-secondary transition-[background] duration-100 hover:bg-white/3" onClick={() => setOpen(!open)}>
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.15s" }}
        >
          <path d="M4 2L8 6L4 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span>Files touched</span>
        {totalCount !== null && (
          <div className="flex items-center gap-1.5 ml-1">
            {sections.map(({ key, label, cls, files: catFiles }) => (
              <span key={key} className={`${cls} inline-flex items-center gap-0.5 px-1.5 py-px rounded text-[10px] font-semibold uppercase tracking-wide`}>
                {catFiles.length} {label}
              </span>
            ))}
          </div>
        )}
      </button>
      {open && loaded && files.length === 0 && (
        <div className="px-3.5 py-3 text-xs text-text-dim border-t border-border">No file operations recorded for this session.</div>
      )}
      {open && loaded && files.length > 0 && (
        <div className="border-t border-border px-3.5 pt-2 pb-3">
          {sections.map(({ key, label, cls, files: catFiles }) => (
            <div key={key} className="mb-3 last:mb-0">
              <div className="flex items-center gap-2 mb-1.5">
                <span className={`${cls} inline-block px-2 py-px rounded text-[10px] font-semibold uppercase tracking-wide`}>{label}</span>
                <span className="text-[11px] text-text-dim">{catFiles.length} files</span>
              </div>
              {catFiles.map((f, i) => <FileEntry key={`${key}-${i}`} file={f} />)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function InsightsPanel({ sessionId }: { sessionId: string }) {
  const navigate = useNavigate();
  const [insights, setInsights] = useState<Array<{
    id: number;
    type: string;
    content: string;
    observation_count: number;
    score: number;
    files: string[];
    source: string;
    last_observed_at: string;
  }>>([]);
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const { extracting, startExtraction: handleExtractSession } = useExtraction(() => {
    setLoaded(false); // force reload on next open
  });

  useEffect(() => {
    if (!open || loaded) return;
    fetch(`/api/sessions/${sessionId}/insights`)
      .then((r) => r.json())
      .then((data) => setInsights(data.insights || []))
      .catch(() => setInsights([]))
      .finally(() => setLoaded(true));
  }, [sessionId, open, loaded]);

  return (
    <div className="mb-5 border border-border rounded-lg bg-bg-card overflow-hidden">
      <button
        className="flex items-center gap-2 w-full px-3.5 py-2.5 text-[13px] font-medium text-text-secondary transition-[background] duration-100 hover:bg-white/3"
        onClick={() => setOpen(!open)}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.15s" }}
        >
          <path d="M4 2L8 6L4 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span>Insights</span>
        {loaded && insights.length > 0 && (
          <span className="inline-flex items-center gap-0.5 px-1.5 py-px rounded text-[10px] font-semibold text-accent-purple bg-accent-purple/12">
            {insights.length}
          </span>
        )}
      </button>
      {open && !loaded && !extracting && (
        <div className="px-3.5 py-3 text-xs text-text-dim border-t border-border flex items-center gap-2">
          <div className="spinner w-3 h-3" />
          Loading...
        </div>
      )}
      {open && loaded && insights.length === 0 && (
        <div className="px-3.5 py-3 text-xs text-text-dim border-t border-border flex items-center gap-2">
          <span>No insights extracted for this session.</span>
          <button
            className="text-accent-purple hover:text-accent-purple/80 transition-colors disabled:opacity-40"
            onClick={handleExtractSession}
            disabled={extracting}
          >
            {extracting ? "Extracting..." : "Extract now"}
          </button>
        </div>
      )}
      {open && loaded && insights.length > 0 && (
        <div className="border-t border-border px-3.5 pt-2 pb-3 flex flex-col gap-2">
          {insights.map((insight) => (
            <div key={insight.id} className="flex items-start gap-2">
              <span
                className="shrink-0 mt-0.5 inline-block px-1.5 py-px rounded-full text-[9px] font-semibold uppercase tracking-wide"
                style={{
                  background: `${INSIGHT_TYPE_COLORS[insight.type] || "#888"}18`,
                  color: INSIGHT_TYPE_COLORS[insight.type] || "#888",
                }}
              >
                {insight.type}
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-[12px] text-text leading-relaxed">{insight.content}</p>
                {insight.files && insight.files.length > 0 && (
                  <div className="flex items-center gap-1 mt-1 flex-wrap">
                    {insight.files.slice(0, 3).map((f) => (
                      <button
                        key={f}
                        className="inline-flex items-center px-1 py-px rounded text-[10px] font-mono text-accent-blue bg-accent-blue/8 hover:bg-accent-blue/15 max-w-[180px] truncate"
                        onClick={() => navigate({ to: "/file", search: { path: f } })}
                        title={f}
                      >
                        {f.split("/").pop()}
                      </button>
                    ))}
                  </div>
                )}
                {insight.observation_count > 1 && (
                  <span className="text-[10px] text-text-dim mt-0.5 inline-block">&times; {insight.observation_count} sessions</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Tools-used summary (now over the full trace, not a windowed page) ─────
// The old version only counted tool_use rows in whatever `messages` window
// had loaded so far — an accepted-but-incomplete gap on long sessions
// (windowed fetch hadn't reached the end yet). Since the merged page loads
// the whole trace in one shot, this is now always complete.

function collectToolCounts(chunks: TraceChunk[]): Array<[string, number]> {
  const map = new Map<string, number>();
  const count = (steps: TraceStep[]) => {
    for (const s of steps) {
      if (s.type === "tool_call" && s.toolName) {
        map.set(s.toolName, (map.get(s.toolName) || 0) + 1);
      }
    }
  };
  for (const c of chunks) {
    if (c.chunkType !== "ai") continue;
    count(c.steps);
    for (const sub of c.subagents) count(sub.steps);
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

function ToolsUsedChips({ chunks }: { chunks: TraceChunk[] }) {
  const counts = useMemo(() => collectToolCounts(chunks), [chunks]);
  if (counts.length === 0) return null;

  return (
    <div className="mb-5 flex items-center gap-1.5 flex-wrap">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-text-dim mr-1">
        Tools used
      </span>
      {counts.map(([name, count]) => (
        <span
          key={name}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-[#d29922]/10 text-[#d29922]/90 border border-[#d29922]/20"
        >
          {name}
          <span className="font-mono text-[10px] text-[#d29922]/70">{count}</span>
        </span>
      ))}
    </div>
  );
}

/** Find a chunk's index by id — the trace-model replacement for the old
 *  `findTurnIndexForSequence` (deep links / search / prev-next nav all funnel
 *  through this instead of a numeric message `sequence`). */
function findChunkIndex(chunks: TraceChunk[], chunkId: string): number {
  return chunks.findIndex((c) => c.id === chunkId);
}

export default function SessionDetail() {
  const { id } = useParams({ from: sessionRoute.id });
  const navigate = useNavigate();
  const { msg: highlightId, ts: highlightTs } = useSearch({ from: sessionRoute.id });
  const [session, setSession] = useState<SessionDetailType | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // -- Trace fetch (plan U9/M1) — one request, no pagination. The endpoint
  // is a fast precomputed-row read (tens of ms even at 7500+ messages), not
  // a re-parse, so there's no size-aware "this can take a few seconds"
  // messaging needed the way the old standalone trace page had it. --
  const [trace, setTrace] = useState<TraceSessionDetail | null>(null);
  const [traceLoading, setTraceLoading] = useState(true);
  const [traceError, setTraceError] = useState<string | null>(null);
  // Permanent absence of trace data (742-session audit: `trace_meta IS NULL`
  // even after a full force-reingest — no source JSONL, no gzip archive, so
  // no amount of re-ingesting will ever produce it) is a distinct case from
  // a transient fetch failure: it degrades to the legacy `/messages` rows
  // instead of showing an error (see the fallback-fetch effect below).
  const [traceNoData, setTraceNoData] = useState(false);
  const [fallbackMessages, setFallbackMessages] = useState<Message[] | null>(null);
  const [fallbackLoading, setFallbackLoading] = useState(false);

  // -- User-only filter mode --
  const [userOnly, setUserOnly] = useState(false);

  // Per-chunk expand/collapse toggles, keyed by chunk id (see ChunkRow in
  // TraceView.tsx / usePersistedExpand). Survives a row's virtualizer-driven
  // unmount/remount; cleared below on session change.
  const expandStoreRef = useRef<Map<string, boolean>>(new Map());

  useEffect(() => {
    setLoading(true);
    setError(null);
    setSession(null);
    setTraceLoading(true);
    setTraceError(null);
    setTraceNoData(false);
    setFallbackMessages(null);
    setTrace(null);
    expandStoreRef.current.clear();

    fetch(`/api/sessions/${id}`)
      .then((r) => {
        if (!r.ok) throw new Error("Session not found");
        return r.json();
      })
      .then((data) => {
        // API returns flat fields; normalize to match SessionDetail type
        if (data.workspace_name && !data.workspace) {
          data.workspace = {
            display_name: data.workspace_name,
            path: data.workspace_path,
          };
        }
        setSession(data);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));

    fetch(`/api/sessions/${id}/trace`)
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.json().catch(() => null);
          const err = new Error(body?.error || "Failed to load session trace.") as Error & { reason?: string };
          err.reason = body?.reason;
          throw err;
        }
        return r.json();
      })
      .then((data: TraceSessionDetail) => {
        setTrace(data);
      })
      .catch((e: unknown) => {
        const reason = e instanceof Error ? (e as Error & { reason?: string }).reason : undefined;
        if (reason === "no_trace") {
          // Permanent, not transient (see traceNoData's doc comment) — fall
          // back to the legacy `/messages` rows instead of an error string.
          setTraceNoData(true);
        } else {
          setTraceError(e instanceof Error ? e.message : "Failed to load session trace.");
        }
      })
      .finally(() => setTraceLoading(false));
  }, [id]);

  // Fallback fetch for sessions with no recoverable trace source (Fix 3):
  // paginate through the legacy `/messages` endpoint (the same rows the
  // pre-merge main view rendered) since that's genuinely the fidelity
  // ceiling for these sessions — no thinking blocks, no tool-call detail,
  // but real, readable transcript instead of a blank/broken page. Capped at
  // 20 pages (10,000 messages) as a sanity bound; the real corpus's worst
  // case among trace_meta-IS-NULL sessions is ~2,100 messages (5 pages).
  useEffect(() => {
    if (!traceNoData) return;
    let cancelled = false;
    setFallbackLoading(true);
    (async () => {
      const collected: Message[] = [];
      const limit = 500;
      let offset = 0;
      for (let page = 0; page < 20; page++) {
        const r = await fetch(`/api/sessions/${id}/messages?limit=${limit}&offset=${offset}`);
        if (!r.ok) break;
        const data: { messages: Message[]; total: number } = await r.json();
        collected.push(...data.messages);
        offset += limit;
        if (data.messages.length === 0 || offset >= data.total) break;
      }
      if (!cancelled) setFallbackMessages(collected);
    })()
      .catch(() => {
        if (!cancelled) setFallbackMessages([]);
      })
      .finally(() => {
        if (!cancelled) setFallbackLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [traceNoData, id]);

  const chunks = trace?.chunks ?? [];

  // Lowercased once per trace load, not per keystroke — chunkSearchText()
  // walks tool inputs/subagent steps and can be large (esp. pre-cap outlier
  // sessions), so redoing that on every debounced search tick was real jank.
  const searchIndex = useMemo(
    () => chunks.map((c) => ({ id: c.id, text: chunkSearchText(c).toLowerCase() })),
    [chunks],
  );

  // Global search deep-links (Fix 2): a search match carries the source
  // message's `timestamp`, not a trace chunk id — resolve it to whichever
  // chunk's [startTime, endTime] window contains it (exact for the
  // point-in-time user/system/compact chunk types; the containing AI-turn
  // chunk for an assistant/tool match, since consecutive assistant/tool
  // messages get merged into one chunk and the trimmed trace payload
  // doesn't retain a per-message id to be more precise than that), falling
  // back to the chronologically nearest chunk if none contains it exactly.
  // `msg` (an explicit chunk id, from in-page nav/prev-next) always wins
  // over `ts` when both are present.
  const resolvedTsChunkId = useMemo(() => {
    if (!highlightTs || chunks.length === 0) return null;
    const targetMs = new Date(highlightTs).getTime();
    if (Number.isNaN(targetMs)) return null;
    let nearestId: string | null = null;
    let nearestDist = Infinity;
    for (const c of chunks) {
      const startMs = new Date(c.startTime).getTime();
      const endMs = new Date(c.endTime).getTime();
      if (Number.isNaN(startMs) || Number.isNaN(endMs)) continue;
      if (targetMs >= startMs && targetMs <= endMs) return c.id;
      const dist = Math.min(Math.abs(targetMs - startMs), Math.abs(targetMs - endMs));
      if (dist < nearestDist) {
        nearestDist = dist;
        nearestId = c.id;
      }
    }
    return nearestId;
  }, [chunks, highlightTs]);

  const effectiveHighlightId = highlightId ?? resolvedTsChunkId ?? undefined;

  // -- In-page search state (over the full trace, chunk-granularity) --
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [matchIds, setMatchIds] = useState<string[]>([]);
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // -- Prev/Next user message navigation — over user chunks --
  const userChunkIds = useMemo(
    () => chunks.filter((c) => c.chunkType === "user").map((c) => c.id),
    [chunks],
  );

  const currentUserIdx = useMemo(() => {
    if (!highlightId) return -1;
    return userChunkIds.indexOf(highlightId);
  }, [highlightId, userChunkIds]);

  const jumpToUserMessage = useCallback(
    (direction: -1 | 1) => {
      if (userChunkIds.length === 0) return;
      let targetIdx: number;
      if (currentUserIdx === -1) {
        targetIdx = direction === 1 ? 0 : userChunkIds.length - 1;
      } else {
        targetIdx = currentUserIdx + direction;
      }
      if (targetIdx < 0 || targetIdx >= userChunkIds.length) return;
      navigate({
        to: "/session/$id",
        params: { id },
        search: { msg: userChunkIds[targetIdx] },
        replace: true,
      });
    },
    [userChunkIds, currentUserIdx, navigate, id],
  );

  const performSearch = useCallback(
    (query: string) => {
      if (!query) {
        setMatchIds([]);
        setCurrentMatchIndex(0);
        return;
      }
      const lowerQuery = query.toLowerCase();
      const found = searchIndex
        .filter((e) => e.text.includes(lowerQuery))
        .map((e) => e.id);
      setMatchIds(found);
      setCurrentMatchIndex(0);
    },
    [searchIndex],
  );

  const navigateMatch = useCallback(
    (direction: 1 | -1) => {
      if (matchIds.length === 0) return;
      setCurrentMatchIndex((idx) => (idx + direction + matchIds.length) % matchIds.length);
    },
    [matchIds],
  );

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery("");
    setMatchIds([]);
    setCurrentMatchIndex(0);
  }, []);

  // Debounced search effect
  useEffect(() => {
    if (!searchOpen) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      performSearch(searchQuery);
    }, 150);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [searchQuery, searchOpen, performSearch]);

  // Focus input when search opens
  useEffect(() => {
    if (searchOpen) {
      setTimeout(() => searchInputRef.current?.focus(), 50);
    }
  }, [searchOpen]);

  // Keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      const isInput = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;

      // Cmd+F to open search
      if ((e.metaKey || e.ctrlKey) && e.key === "f") {
        e.preventDefault();
        if (!searchOpen) {
          setSearchOpen(true);
        } else {
          searchInputRef.current?.select();
        }
        return;
      }

      // Escape to close search
      if (e.key === "Escape" && searchOpen) {
        closeSearch();
        return;
      }

      // Enter / Shift+Enter in search input to navigate matches
      if (searchOpen && isInput && target === searchInputRef.current) {
        if (e.key === "Enter") {
          e.preventDefault();
          navigateMatch(e.shiftKey ? -1 : 1);
          return;
        }
      }

      // U to toggle user-only filter
      if (!isInput && !searchOpen && e.key === "u") {
        e.preventDefault();
        setUserOnly((prev) => !prev);
        return;
      }

      // [ and ] for prev/next user message (only when not in an input)
      if (!isInput && !searchOpen) {
        if (e.key === "[") {
          e.preventDefault();
          jumpToUserMessage(-1);
          return;
        }
        if (e.key === "]") {
          e.preventDefault();
          jumpToUserMessage(1);
          return;
        }
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [searchOpen, closeSearch, navigateMatch, jumpToUserMessage]);

  function handleTagsChange(newTags: Tag[]) {
    if (!session) return;
    setSession({ ...session, tags: newTags });
  }

  const visibleChunks = useMemo(
    () => (userOnly ? chunks.filter((c) => c.chunkType === "user") : chunks),
    [chunks, userOnly],
  );
  const visibleChunksRef = useRef<TraceChunk[]>([]);
  visibleChunksRef.current = visibleChunks;

  // Precompute which "user" rows need the separating divider drawn INSIDE
  // their own virtual row — every user chunk except the first. Dividers are
  // never shown in userOnly mode (matches prior behavior), so this is only
  // consulted when `visibleChunks === chunks`.
  const dividerBeforeIndex = useMemo(() => {
    const set = new Set<number>();
    let seenFirstUser = false;
    chunks.forEach((c, i) => {
      if (c.chunkType === "user") {
        if (seenFirstUser) set.add(i);
        seenFirstUser = true;
      }
    });
    return set;
  }, [chunks]);

  const searchHighlightId = searchOpen && matchIds.length > 0 ? matchIds[currentMatchIndex] : null;
  const highlightChunkId = searchHighlightId ?? effectiveHighlightId ?? null;

  const maxContextTokens = useMemo(() => {
    let max = 0;
    for (const c of chunks) {
      if (c.chunkType === "ai" && c.contextTokensEnd !== undefined) max = Math.max(max, c.contextTokensEnd);
    }
    return max;
  }, [chunks]);

  // -- Virtualization (D11/U9): window-scoped since the page itself scrolls
  // (sticky header, no fixed-height inner container). `scrollMargin` is the
  // list's offset from the top of the document — re-measured whenever
  // anything above it (header/search bar/panels) changes size, including
  // when the trace finishes loading and the list first mounts (the
  // ResizeObserver below watches `document.body`, so that mount itself
  // triggers a re-measure). --
  const listContainerRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);

  useLayoutEffect(() => {
    function measure() {
      const el = listContainerRef.current;
      if (!el) return;
      setScrollMargin(el.getBoundingClientRect().top + window.scrollY);
    }
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(document.body);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [session?.id]);

  const rowVirtualizer = useWindowVirtualizer({
    count: visibleChunks.length,
    estimateSize: () => 140,
    overscan: 10,
    gap: 10,
    scrollMargin,
  });

  // Deep-link scroll (?msg=, ?ts= resolved via resolvedTsChunkId, prev/next
  // nav, and the userOnly-bubble-click re-navigation below all funnel
  // through this): find the target chunk id's row and scroll to it.
  // Everything is already loaded (single trace fetch), so — unlike the old
  // windowed version — there's no "load more pages until found" loop here;
  // it's either present or it isn't.
  useEffect(() => {
    if (loading || traceLoading || !effectiveHighlightId) return;
    const idx = findChunkIndex(visibleChunksRef.current, effectiveHighlightId);
    if (idx === -1) return;
    rowVirtualizer.scrollToIndex(idx, { align: "center", behavior: "smooth" });
    // Re-invoke once more after a frame: react-virtual measures rows as they
    // mount, and the first call can land on estimateSize (140px) positions
    // before that settles.
    requestAnimationFrame(() => {
      rowVirtualizer.scrollToIndex(idx, { align: "center", behavior: "smooth" });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, traceLoading, effectiveHighlightId, visibleChunks]);

  // Jump-to-bottom / Jump-to-top: everything is already loaded, so this is
  // just a scroll — no page-loading loop needed (U9 simplification over the
  // old windowed-fetch version).
  const jumpToBottom = useCallback(() => {
    const lastIndex = visibleChunksRef.current.length - 1;
    if (lastIndex < 0) return;
    rowVirtualizer.scrollToIndex(lastIndex, { align: "end" });
    requestAnimationFrame(() => {
      rowVirtualizer.scrollToIndex(lastIndex, { align: "end" });
    });
  }, [rowVirtualizer]);

  // Scroll to the current search match whenever it changes.
  useEffect(() => {
    if (!searchOpen || matchIds.length === 0) return;
    const chunkId = matchIds[currentMatchIndex];
    const idx = findChunkIndex(visibleChunks, chunkId);
    if (idx !== -1) rowVirtualizer.scrollToIndex(idx, { align: "center", behavior: "smooth" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchOpen, matchIds, currentMatchIndex, visibleChunks]);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 p-15 text-text-secondary">
        <div className="spinner" />
        <span>Loading session...</span>
      </div>
    );
  }

  if (error || !session) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 p-15 text-text-secondary">
        <p>{error || "Session not found"}</p>
        <button className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[13px] text-text-secondary rounded-md transition-all hover:text-text hover:bg-white/6" onClick={() => window.history.back()}>Go back</button>
      </div>
    );
  }

  const canGoPrev = userChunkIds.length > 0 && (currentUserIdx === -1 || currentUserIdx > 0);
  const canGoNext = userChunkIds.length > 0 && (currentUserIdx === -1 || currentUserIdx < userChunkIds.length - 1);

  return (
    <ExpandStoreContext.Provider value={expandStoreRef.current}>
    <div className="max-w-[1400px] mx-auto px-10 pt-0 pb-20">
      <div className="sticky top-0 z-10 bg-bg pt-6 pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1">
            <button className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[13px] text-text-secondary rounded-md transition-all hover:text-text hover:bg-white/6" onClick={() => navigate({ to: "/workspace/$id", params: { id: String(session.workspace_id) } })}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M10 12L6 8L10 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Back to sessions
            </button>

            {/* Prev/Next user message buttons */}
            <div className="flex items-center gap-0.5 ml-2">
              <button
                className="inline-flex items-center gap-1 px-2 py-1 text-[11px] text-text-dim rounded transition-all hover:text-text hover:bg-white/6 disabled:opacity-30 disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-text-dim"
                onClick={() => jumpToUserMessage(-1)}
                disabled={!canGoPrev}
                title="Previous user message  ["
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                  <path d="M10 12L6 8L10 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Prev
              </button>
              <button
                className="inline-flex items-center gap-1 px-2 py-1 text-[11px] text-text-dim rounded transition-all hover:text-text hover:bg-white/6 disabled:opacity-30 disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-text-dim"
                onClick={() => jumpToUserMessage(1)}
                disabled={!canGoNext}
                title="Next user message  ]"
              >
                Next
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                  <path d="M6 4L10 8L6 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
          </div>

          <div className="flex items-center gap-1">
            {/* User-only filter toggle */}
            <button
              className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[13px] rounded-md transition-all hover:text-text hover:bg-white/6 ${userOnly ? "text-accent-blue bg-accent-blue/10" : "text-text-secondary"}`}
              onClick={() => setUserOnly(!userOnly)}
              title="Show only your messages  U"
            >
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                <path d="M8 8a3 3 0 100-6 3 3 0 000 6zM2 14c0-2.21 2.69-4 6-4s6 1.79 6 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {userOnly && <span className="text-[11px]">Mine</span>}
            </button>
            {/* Search toggle button */}
            <button
              className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[13px] rounded-md transition-all hover:text-text hover:bg-white/6 ${searchOpen ? "text-accent-blue" : "text-text-secondary"}`}
              onClick={() => searchOpen ? closeSearch() : setSearchOpen(true)}
              title="Search in page  Cmd+F"
            >
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
                <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
            <button
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[13px] text-text-secondary rounded-md transition-all hover:text-text hover:bg-white/6"
              // Instant, not smooth: a smooth scrollTo across the full
              // height of a long virtualized trace stalls — each newly
              // mounted row's measureElement call nudges scrollMargin/total
              // size, and that fights the in-flight browser scroll
              // animation. Bottom (rowVirtualizer.scrollToIndex, no
              // `behavior` option) already jumps instantly and reliably;
              // match that here instead of the smooth variant.
              onClick={() => window.scrollTo({ top: 0, behavior: "auto" })}
              title="Scroll to top"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M8 12V4M4 8L8 4L12 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Top
            </button>
            <button
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[13px] text-text-secondary rounded-md transition-all hover:text-text hover:bg-white/6 disabled:opacity-50"
              onClick={() => jumpToBottom()}
              disabled={traceLoading || visibleChunks.length === 0}
              title="Scroll to bottom"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M8 4V12M4 8L8 12L12 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Bottom
            </button>
          </div>
        </div>

        {/* Search bar (second row) */}
        {searchOpen && (
          <div className="flex items-center gap-2 mt-2 px-1">
            <div className="flex items-center flex-1 gap-2 bg-white/6 border border-border rounded-lg px-3 py-1.5">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="shrink-0 text-text-dim">
                <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
                <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              <input
                ref={searchInputRef}
                type="text"
                className="flex-1 bg-transparent text-[13px] text-text outline-none placeholder:text-text-dim"
                placeholder="Search in conversation..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              {searchQuery && (
                <span className="text-[11px] text-text-dim font-mono whitespace-nowrap">
                  {matchIds.length > 0 ? `${currentMatchIndex + 1} of ${matchIds.length}` : "0 of 0"}
                </span>
              )}
            </div>
            <button
              className="p-1.5 text-text-dim rounded transition-all hover:text-text hover:bg-white/6 disabled:opacity-30"
              onClick={() => navigateMatch(-1)}
              disabled={matchIds.length === 0}
              title="Previous match  Shift+Enter"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path d="M12 10L8 6L4 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <button
              className="p-1.5 text-text-dim rounded transition-all hover:text-text hover:bg-white/6 disabled:opacity-30"
              onClick={() => navigateMatch(1)}
              disabled={matchIds.length === 0}
              title="Next match  Enter"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path d="M4 6L8 10L12 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <button
              className="p-1.5 text-text-dim rounded transition-all hover:text-text hover:bg-white/6"
              onClick={closeSearch}
              title="Close search  Esc"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path d="M4 4L12 12M12 4L4 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        )}
      </div>
      <div className="border-b border-border pb-5 mb-6">
        <div className="mt-1">
          <SessionHeader
            session={session}
            onTagsChange={handleTagsChange}
            showTitle
          />
          <div className="flex items-center gap-2 mt-1 text-xs text-text-dim">
            <span>{session.message_count} messages</span>
            <span className="text-border">/</span>
            <span>{session.user_message_count} from you</span>
            <span className="text-border">/</span>
            <span>{session.workspace.display_name}</span>
          </div>
          {trace && (
            <div className="mt-3">
              <TraceStatsBar trace={trace} />
            </div>
          )}
        </div>
      </div>

      <FilesPanel sessionId={session.id} />

      {/* Reflects the full trace, not a windowed page — always complete. */}
      <ToolsUsedChips chunks={chunks} />

      <InsightsPanel sessionId={session.id} />

      {traceLoading && (
        <div className="flex flex-col items-center justify-center gap-3 p-15 text-text-secondary">
          <div className="spinner" />
          <span>Loading messages…</span>
        </div>
      )}

      {!traceLoading && traceError && (
        <div className="flex flex-col items-center justify-center gap-3 p-15 text-text-secondary">
          <p>{traceError}</p>
        </div>
      )}

      {/* Degraded fallback (Fix 3) — this session's source JSONL and gzip
          archive are both permanently gone (see traceNoData's doc comment),
          so full-fidelity trace rendering is off the table for good. The
          legacy `messages` table rows are still intact, so render those
          instead of a blank/broken page — no thinking blocks or per-tool-call
          duration/token detail (that data only ever lived in the trace
          pipeline), but a real, readable transcript. */}
      {!traceLoading && traceNoData && (
        <div className="mt-2">
          <div className="mb-4 px-3.5 py-2.5 rounded-lg border border-accent-orange/25 bg-accent-orange/8 text-[13px] text-accent-orange">
            Full detail unavailable — original transcript no longer exists. Showing the legacy message log instead (no thinking blocks, no tool-call detail).
          </div>
          {fallbackLoading && (
            <div className="flex items-center justify-center gap-2 p-6 text-text-secondary">
              <div className="spinner small" />
              <span>Loading messages…</span>
            </div>
          )}
          {!fallbackLoading && fallbackMessages && fallbackMessages.length === 0 && (
            <div className="p-6 text-[13px] text-text-secondary">No messages recoverable for this session.</div>
          )}
          {!fallbackLoading && fallbackMessages && fallbackMessages.length > 0 && (
            <div className="flex flex-col gap-2">
              {fallbackMessages.map((m) => {
                const isTool = m.message_type === "tool_use" || m.message_type === "tool_result";
                return (
                  <div
                    key={m.sequence}
                    className={`rounded-lg border px-3.5 py-2.5 ${m.role === "user" ? "border-accent-blue/25 bg-accent-blue/6" : "border-border bg-bg-card"}`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`text-[10px] font-semibold uppercase tracking-wider ${m.role === "user" ? "text-accent-blue" : "text-accent-purple"}`}>
                        {m.role === "user" ? "You" : "Claude"}
                      </span>
                      {isTool && (
                        <span className="inline-flex items-center px-1.5 py-px rounded text-[10px] font-medium font-mono whitespace-nowrap bg-white/6 text-text-dim">
                          {m.message_type === "tool_use" ? (m.tool_name || "tool call") : "tool result"}
                        </span>
                      )}
                      <span className="ml-auto text-[10px] font-mono text-text-dim/60">{formatClockTime(m.timestamp ?? undefined)}</span>
                    </div>
                    {isTool ? (
                      <pre className="tool-mini-code rounded px-2 py-1.5 text-[11px] whitespace-pre-wrap">{m.content}</pre>
                    ) : (
                      <div className="text-[13px] text-text leading-relaxed whitespace-pre-wrap">
                        <MarkdownBody text={m.content} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {!traceLoading && !traceError && !traceNoData && trace && (
        <div ref={listContainerRef} className="snippet-bubbles-virtual" style={{ position: "relative", marginTop: 8 }}>
          <div style={{ position: "relative", width: "100%", height: rowVirtualizer.getTotalSize() }}>
            {rowVirtualizer.getVirtualItems().map((virtualItem) => {
              const chunk = visibleChunks[virtualItem.index];
              if (!chunk) return null;
              const showDivider = !userOnly && dividerBeforeIndex.has(virtualItem.index);
              const isHighlighted = chunk.id === highlightChunkId;

              const chunkRow = <ChunkRow chunk={chunk} maxContextTokens={maxContextTokens} highlight={isHighlighted} />;

              const rowContent =
                userOnly && chunk.chunkType === "user" ? (
                  <div
                    className="cursor-pointer transition-all hover:brightness-125"
                    onClick={() => {
                      // Return to the full (non-filtered) view AND deep-link
                      // to this chunk so the existing highlightId scroll
                      // effect (above) carries it into view.
                      setUserOnly(false);
                      navigate({
                        to: "/session/$id",
                        params: { id },
                        search: { msg: chunk.id },
                        replace: true,
                      });
                    }}
                  >
                    {chunkRow}
                  </div>
                ) : (
                  <>
                    {showDivider && (
                      <div className="w-full my-4 flex items-center">
                        <div className="flex-1 h-px bg-border/40" />
                      </div>
                    )}
                    {chunkRow}
                  </>
                );

              return (
                <div
                  key={virtualItem.key}
                  data-index={virtualItem.index}
                  ref={rowVirtualizer.measureElement}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${virtualItem.start - scrollMargin}px)`,
                  }}
                >
                  {rowContent}
                </div>
              );
            })}
          </div>

          {trace.unattachedSubagents.length > 0 && (
            <div className="mt-6 pt-4 border-t border-border">
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-text-dim mb-2">
                Unlinked subagents ({trace.unattachedSubagents.length} not linked to a specific turn)
              </h3>
              <StepList steps={[]} subagents={trace.unattachedSubagents} />
            </div>
          )}
        </div>
      )}
    </div>
    </ExpandStoreContext.Provider>
  );
}
