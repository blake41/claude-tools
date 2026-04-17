import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import type { Workspace, SessionSummary } from "../types";
import SessionCard from "./SessionCard";
import { categorizeFiles } from "../fileCategories";

type FileFilter = "code" | "docs" | "viz";

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

type SortMode = "start" | "activity";

function groupByDate(sessions: SessionSummary[], sortMode: SortMode = "start"): Map<string, SessionSummary[]> {
  const groups = new Map<string, SessionSummary[]>();
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const weekAgo = new Date(today.getTime() - 7 * 86400000);

  for (const session of sessions) {
    const dateStr = sortMode === "activity"
      ? (session.ended_at || session.started_at)
      : session.started_at;
    const d = new Date(dateStr);
    const sessionDate = new Date(d.getFullYear(), d.getMonth(), d.getDate());

    let label: string;
    if (sessionDate.getTime() === today.getTime()) {
      label = "Today";
    } else if (sessionDate.getTime() === yesterday.getTime()) {
      label = "Yesterday";
    } else if (sessionDate >= weekAgo) {
      label = "This Week";
    } else {
      label = formatDate(dateStr);
    }

    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(session);
  }
  return groups;
}

interface SessionListProps {
  workspace: Workspace;
}

export default function SessionList({ workspace }: SessionListProps) {
  const cacheKey = `session-list-${workspace.id}`;
  const scrollKey = `session-list-scroll-${workspace.id}`;

  const cached = (() => {
    try {
      const raw = sessionStorage.getItem(cacheKey);
      if (raw) return JSON.parse(raw) as { sessions: SessionSummary[]; offset: number; hasMore: boolean };
    } catch {}
    return null;
  })();

  const [sessions, setSessions] = useState<SessionSummary[]>(cached?.sessions || []);
  const [loading, setLoading] = useState(!cached);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(cached?.offset || 0);
  const [hasMore, setHasMore] = useState(cached?.hasMore ?? true);
  const [summarizing, setSummarizing] = useState(false);
  const [progress, setProgress] = useState<{ total: number; completed: number; failed: number } | null>(null);
  const [summarizeDone, setSummarizeDone] = useState<{ completed: number; failed: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [sortMode, setSortMode] = useState<SortMode>("start");
  const limit = 200;

  // Cache sessions state on change
  useEffect(() => {
    if (sessions.length > 0) {
      try {
        sessionStorage.setItem(cacheKey, JSON.stringify({ sessions, offset, hasMore }));
      } catch {}
    }
  }, [sessions, offset, hasMore, cacheKey]);

  // Save scroll position before navigating away
  useEffect(() => {
    const main = containerRef.current?.closest("main");
    if (!main) return;
    const saveScroll = () => sessionStorage.setItem(scrollKey, String(main.scrollTop));
    main.addEventListener("scroll", saveScroll, { passive: true });
    return () => main.removeEventListener("scroll", saveScroll);
  }, [scrollKey]);

  // Restore scroll position after render
  useEffect(() => {
    if (!loading && sessions.length > 0) {
      const saved = sessionStorage.getItem(scrollKey);
      if (saved) {
        const main = containerRef.current?.closest("main");
        if (main) requestAnimationFrame(() => { main.scrollTop = Number(saved); });
      }
    }
  }, [loading, scrollKey, sessions.length > 0]);

  const fetchSessions = useCallback(
    (reset: boolean) => {
      const newOffset = reset ? 0 : offset;
      setLoading(true);
      const page = Math.floor(newOffset / limit) + 1;
      const sortParam = sortMode === "activity" ? "&sort=activity" : "";
      fetch(`/api/sessions?workspace=${workspace.id}&limit=${limit}&page=${page}${sortParam}`)
        .then((r) => r.json())
        .then((data: { sessions: SessionSummary[]; pagination: { total: number } }) => {
          if (reset) {
            setSessions(data.sessions);
          } else {
            setSessions((prev) => [...prev, ...data.sessions]);
          }
          setHasMore(data.sessions.length === limit);
          setOffset(newOffset + data.sessions.length);
        })
        .catch(() => setError("Failed to load sessions"))
        .finally(() => setLoading(false));
    },
    [workspace.id, offset, sortMode]
  );

  useEffect(() => {
    if (!cached || sortMode !== "start") {
      setLoading(true);
    }
    setError(null);
    const pages = (cached && sortMode === "start") ? Math.ceil(cached.offset / limit) || 1 : 1;
    const fetchLimit = pages * limit;
    const sortParam = sortMode === "activity" ? "&sort=activity" : "";
    fetch(`/api/sessions?workspace=${workspace.id}&limit=${fetchLimit}&page=1${sortParam}`)
      .then((r) => r.json())
      .then((data: { sessions: SessionSummary[]; pagination: { total: number } }) => {
        setSessions(data.sessions);
        setHasMore(data.sessions.length === fetchLimit);
        setOffset(data.sessions.length);
      })
      .catch(() => setError("Failed to load sessions"))
      .finally(() => setLoading(false));
  }, [workspace.id, sortMode]);

  // Poll summarization status
  useEffect(() => {
    if (!summarizing) return;
    const interval = setInterval(() => {
      fetch(`/api/workspaces/${workspace.id}/summarize/status`)
        .then((r) => r.json())
        .then((data) => {
          if (!data.running) {
            setSummarizing(false);
            setProgress(null);
            setSummarizeDone({ completed: data.completed ?? 0, failed: data.failed ?? 0 });
            setTimeout(() => setSummarizeDone(null), 5000);
            const sortParam = sortMode === "activity" ? "&sort=activity" : "";
            fetch(`/api/sessions?workspace=${workspace.id}&limit=${limit}&page=1${sortParam}`)
              .then((r) => r.json())
              .then((d: { sessions: SessionSummary[]; pagination: { total: number } }) => {
                setSessions(d.sessions);
                setHasMore(d.sessions.length === limit);
                setOffset(d.sessions.length);
              });
          } else {
            setProgress({ total: data.total, completed: data.completed, failed: data.failed });
          }
        });
    }, 2000);
    return () => clearInterval(interval);
  }, [summarizing, workspace.id]);

  const startSummarize = () => {
    fetch(`/api/workspaces/${workspace.id}/summarize`, { method: "POST" })
      .then((r) => {
        if (r.status === 202) {
          return r.json().then((data: { total: number }) => {
            setSummarizing(true);
            setProgress({ total: data.total, completed: 0, failed: 0 });
            setSummarizeDone(null);
          });
        } else if (r.status === 200) {
          setSummarizeDone({ completed: 0, failed: 0 });
          setTimeout(() => setSummarizeDone(null), 5000);
        }
      });
  };

  const cancelSummarize = () => {
    fetch(`/api/workspaces/${workspace.id}/summarize`, { method: "DELETE" });
    setSummarizing(false);
    setProgress(null);
  };

  const handleTagsChange = (sessionId: string, newTags: typeof sessions[0]["tags"]) => {
    setSessions(prev => prev.map(s =>
      s.id === sessionId ? { ...s, tags: newTags } : s
    ));
  };

  const [activeFilters, setActiveFilters] = useState<Set<FileFilter>>(new Set());
  const [branchFilter, setBranchFilter] = useState("all");
  const [tagFilter, setTagFilter] = useState("all");
  const [hasSummary, setHasSummary] = useState(false);
  type DateRange = "all" | "today" | "yesterday" | "3d" | "2w" | "30d";
  const [dateFilter, setDateFilter] = useState<DateRange>("all");

  const toggleFilter = (f: FileFilter) => {
    setActiveFilters(prev => {
      const next = new Set(prev);
      if (next.has(f)) next.delete(f); else next.add(f);
      return next;
    });
  };

  const branches = useMemo(() =>
    [...new Set(sessions.map(s => s.git_branch).filter(Boolean) as string[])].sort(),
    [sessions]
  );

  const allTags = useMemo(() => {
    const tagMap = new Map<number, { id: number; name: string; color: string }>();
    for (const s of sessions) {
      for (const t of s.tags || []) {
        if (!tagMap.has(t.id)) tagMap.set(t.id, t);
      }
    }
    return [...tagMap.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [sessions]);

  const dateThreshold = useMemo(() => {
    if (dateFilter === "all") return null;
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    switch (dateFilter) {
      case "today":
        return { min: today.getTime(), max: null as number | null };
      case "yesterday": {
        const y = today.getTime() - 86400000;
        return { min: y, max: today.getTime() };
      }
      case "3d":
        return { min: today.getTime() - 3 * 86400000, max: null };
      case "2w":
        return { min: today.getTime() - 14 * 86400000, max: null };
      case "30d":
        return { min: today.getTime() - 30 * 86400000, max: null };
    }
  }, [dateFilter]);

  const filteredSessions = useMemo(() => {
    return sessions.filter(s => {
      // File type filter
      if (activeFilters.size > 0) {
        const files = s.files_changed || [];
        if (files.length === 0) return false;
        const cats = categorizeFiles(files);
        let hasMatch = false;
        for (const f of activeFilters) {
          if (cats[f].length > 0) { hasMatch = true; break; }
        }
        if (!hasMatch) return false;
      }
      // Branch filter
      if (branchFilter !== "all" && (s.git_branch || "") !== branchFilter) return false;
      // Tag filter
      if (tagFilter !== "all" && !(s.tags || []).some(t => t.name === tagFilter)) return false;
      // Has summary filter
      if (hasSummary && !s.summary) return false;
      // Date filter (client-side; compare on sort mode's anchor timestamp)
      if (dateThreshold) {
        const anchor = sortMode === "activity"
          ? new Date(s.ended_at || s.started_at).getTime()
          : new Date(s.started_at).getTime();
        if (anchor < dateThreshold.min) return false;
        if (dateThreshold.max !== null && anchor >= dateThreshold.max) return false;
      }
      return true;
    });
  }, [sessions, activeFilters, branchFilter, tagFilter, hasSummary, dateThreshold, sortMode]);

  const anyFilterActive = activeFilters.size > 0 || branchFilter !== "all" || tagFilter !== "all" || hasSummary || dateFilter !== "all";

  const grouped = groupByDate(filteredSessions, sortMode);

  return (
    <div ref={containerRef} className="px-10 py-8 max-w-[1200px]">
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight">{workspace.display_name}</h1>
        <p className="font-mono text-xs text-text-dim mt-1">{workspace.path}</p>
        <p className="text-[13px] text-text-secondary mt-0.5 mb-3">{workspace.session_count} sessions</p>
        <div className="mb-6">
          {!summarizing && !summarizeDone && (
            <button
              className="text-[13px] text-accent-blue bg-bg-card border border-border rounded-lg px-3 py-1.5 transition-all hover:bg-accent-blue/8 hover:border-accent-blue"
              onClick={startSummarize}
            >
              Summarize all
            </button>
          )}
          {summarizing && progress && (
            <div className="flex items-center gap-3">
              <span className="text-[13px] text-text-secondary">
                {progress.completed} of {progress.total} summarized
              </span>
              <button
                className="text-[13px] text-accent-red bg-bg-card border border-border rounded-lg px-3 py-1.5 transition-all hover:bg-accent-red/8 hover:border-accent-red"
                onClick={cancelSummarize}
              >
                Cancel
              </button>
            </div>
          )}
          {summarizeDone && (
            <span className="text-[13px] text-accent-green">
              Done! {summarizeDone.completed} summarized{summarizeDone.failed > 0 ? `, ${summarizeDone.failed} failed` : ""}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 flex-wrap mb-2">
          {([
            { key: "all", label: "All" },
            { key: "today", label: "Today" },
            { key: "yesterday", label: "Yest" },
            { key: "3d", label: "3d" },
            { key: "2w", label: "2w" },
            { key: "30d", label: "30d" },
          ] as const).map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setDateFilter(key)}
              className={`text-[11px] px-2.5 py-1 rounded-md border transition-all ${
                dateFilter === key
                  ? "border-accent-blue/40 text-accent-blue bg-accent-blue/10"
                  : "border-border/60 text-text-dim hover:text-text-secondary hover:border-border"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="view-toggle">
            <button
              className={sortMode === "start" ? "active" : ""}
              onClick={() => setSortMode("start")}
            >
              Start time
            </button>
            <button
              className={sortMode === "activity" ? "active" : ""}
              onClick={() => setSortMode("activity")}
            >
              Last activity
            </button>
          </div>
          <span className="w-px h-4 bg-border mx-1" />
          {(["code", "docs", "viz"] as const).map(f => (
            <button
              key={f}
              onClick={() => toggleFilter(f)}
              className={`text-[11px] font-semibold uppercase tracking-wider px-2.5 py-1 rounded-md border transition-all ${
                activeFilters.has(f)
                  ? f === "code" ? "border-[#3fb950]/40 text-[#3fb950] bg-[#3fb950]/12"
                  : f === "docs" ? "border-[#56d4dd]/40 text-[#56d4dd] bg-[#56d4dd]/12"
                  : "border-[#d29922]/40 text-[#d29922] bg-[#d29922]/12"
                  : f === "code" ? "border-[#3fb950]/15 text-[#3fb950]/50 bg-[#3fb950]/5 hover:text-[#3fb950]/80 hover:bg-[#3fb950]/10"
                  : f === "docs" ? "border-[#56d4dd]/15 text-[#56d4dd]/50 bg-[#56d4dd]/5 hover:text-[#56d4dd]/80 hover:bg-[#56d4dd]/10"
                  : "border-[#d29922]/15 text-[#d29922]/50 bg-[#d29922]/5 hover:text-[#d29922]/80 hover:bg-[#d29922]/10"
              }`}
            >
              {f}
            </button>
          ))}
          <span className="w-px h-4 bg-border mx-1" />
          <button
            className={`filter-chip ${hasSummary ? "active" : ""}`}
            onClick={() => setHasSummary(!hasSummary)}
          >
            Has summary
          </button>
          {branches.length > 1 && (
            <select
              value={branchFilter}
              onChange={(e) => setBranchFilter(e.target.value)}
              className="filter-chip"
              style={{ color: branchFilter !== "all" ? "var(--accent-blue)" : undefined }}
            >
              <option value="all">All branches</option>
              {branches.map(b => <option key={b} value={b}>{b}</option>)}
            </select>
          )}
          {allTags.length > 0 && (
            <select
              value={tagFilter}
              onChange={(e) => setTagFilter(e.target.value)}
              className="filter-chip"
              style={{ color: tagFilter !== "all" ? "var(--accent-blue)" : undefined }}
            >
              <option value="all">All tags</option>
              {allTags.map(t => <option key={t.id} value={t.name}>{t.name}</option>)}
            </select>
          )}
          {anyFilterActive && (
            <span className="text-[11px] text-text-dim ml-1">
              {filteredSessions.length} of {sessions.length}
            </span>
          )}
        </div>
      </div>

      {error && <div className="bg-accent-red/10 border border-accent-red/30 text-accent-red px-3.5 py-2.5 rounded-lg text-[13px] mb-4">{error}</div>}

      <div>
        {Array.from(grouped.entries()).map(([label, items]) => (
          <div key={label} className="mb-6">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-text-dim pb-2 border-b border-border mb-2">{label}</h3>
            <div className="session-rows">
              {items.map((session) => (
                <SessionCard
                  key={session.id}
                  session={session}
                  onTagsChange={handleTagsChange}
                  showLastMessage={sortMode === "activity"}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      {loading && (
        <div className="flex items-center justify-center gap-2.5 py-5 text-text-secondary text-[13px]">
          <div className="spinner" />
          <span>Loading sessions...</span>
        </div>
      )}

      {!loading && hasMore && sessions.length > 0 && (
        <button className="block w-full p-3 text-center text-[13px] text-accent-blue bg-bg-card border border-border rounded-lg transition-all hover:bg-accent-blue/8 hover:border-accent-blue" onClick={() => fetchSessions(false)}>
          Load more sessions
        </button>
      )}

      {!loading && sessions.length === 0 && !error && (
        <div className="flex items-center justify-center px-5 py-15 text-text-secondary text-sm">No sessions found for this workspace.</div>
      )}
    </div>
  );
}
