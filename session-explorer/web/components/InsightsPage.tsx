import { useState, useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { Insight, InsightStats, InsightDetail } from "../types";
import { INSIGHT_TYPE_COLORS } from "../insight-shared";
import { useExtraction } from "../hooks/useExtraction";

const INSIGHT_TYPES = ["all", "correction", "decision", "pattern", "discovery", "gotcha", "preference"] as const;
type InsightType = (typeof INSIGHT_TYPES)[number];

const SORT_OPTIONS = [
  { value: "score", label: "Score" },
  { value: "observation_count", label: "Observations" },
  { value: "last_observed_at", label: "Recent" },
  { value: "extracted_at", label: "Oldest" },
] as const;
type SortValue = (typeof SORT_OPTIONS)[number]["value"];

function relativeDate(dateStr: string): string {
  const d = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default function InsightsPage() {
  const navigate = useNavigate();
  const [insights, setInsights] = useState<Insight[]>([]);
  const [stats, setStats] = useState<InsightStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [typeFilter, setTypeFilter] = useState<InsightType>("all");
  const [sort, setSort] = useState<SortValue>("score");
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [extractionInterval, setExtractionInterval] = useState(3);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [expandedDetail, setExpandedDetail] = useState<InsightDetail | null>(null);
  const [votes, setVotes] = useState<Record<number, { upvotes: number; downvotes: number }>>({});

  const LIMIT = 50;

  const { extracting, startExtraction: handleExtract } = useExtraction(() => {
    fetch("/api/insights/stats")
      .then((r) => r.json())
      .then((data) => setStats(data))
      .catch(() => {});
    setRefreshKey((k) => k + 1);
  });

  // Fetch stats
  useEffect(() => {
    fetch("/api/insights/stats")
      .then((r) => r.json())
      .then((data) => setStats(data))
      .catch(() => {});
  }, []);

  // Fetch extraction settings
  useEffect(() => {
    fetch("/api/settings/extraction")
      .then((r) => r.json())
      .then((data) => {
        if (data.interval_days) setExtractionInterval(data.interval_days);
      })
      .catch(() => {});
  }, []);

  // Fetch insights on filter/sort change
  useEffect(() => {
    const params = new URLSearchParams();
    if (typeFilter !== "all") params.set("type", typeFilter);
    params.set("sort", sort);
    params.set("limit", String(LIMIT));
    params.set("offset", "0");

    setLoading(true);
    fetch(`/api/insights?${params}`)
      .then((r) => r.json())
      .then((data) => {
        const items: Insight[] = data.insights || data || [];
        setInsights(items);
        setOffset(items.length);
        setHasMore(items.length === LIMIT);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [typeFilter, sort, refreshKey]);

  function handleIntervalChange(days: number) {
    setExtractionInterval(days);
    fetch("/api/settings/extraction", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ interval_days: days }),
    }).catch(() => {});
  }

  function handleExpand(id: number) {
    if (expandedId === id) {
      setExpandedId(null);
      setExpandedDetail(null);
      return;
    }
    setExpandedId(id);
    setExpandedDetail(null);
    fetch(`/api/insights/${id}`)
      .then((r) => r.json())
      .then((data) => setExpandedDetail(data))
      .catch(() => {});
  }

  function handleVote(id: number, direction: "upvote" | "downvote") {
    // Optimistic update
    setVotes((prev) => {
      const current = prev[id] || {
        upvotes: insights.find((i) => i.id === id)?.upvotes || 0,
        downvotes: insights.find((i) => i.id === id)?.downvotes || 0,
      };
      return {
        ...prev,
        [id]: {
          upvotes: current.upvotes + (direction === "upvote" ? 1 : 0),
          downvotes: current.downvotes + (direction === "downvote" ? 1 : 0),
        },
      };
    });
    fetch(`/api/insights/${id}/${direction}`, { method: "POST" }).catch(() => {});
  }

  function handleDismiss(id: number) {
    setInsights((prev) => prev.filter((i) => i.id !== id));
    fetch(`/api/insights/${id}`, { method: "DELETE" }).catch(() => {});
  }

  function loadMore() {
    const params = new URLSearchParams();
    if (typeFilter !== "all") params.set("type", typeFilter);
    params.set("sort", sort);
    params.set("limit", String(LIMIT));
    params.set("offset", String(offset));

    setLoading(true);
    fetch(`/api/insights?${params}`)
      .then((r) => r.json())
      .then((data) => {
        const items: Insight[] = data.insights || data || [];
        setInsights((prev) => [...prev, ...items]);
        setOffset(offset + items.length);
        setHasMore(items.length === LIMIT);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }

  function getTypeCount(type: string): number {
    if (!stats) return 0;
    const entry = stats.type_distribution.find((t) => t.type === type);
    return entry?.count || 0;
  }

  const coverage = stats?.extraction_coverage;
  const isEmpty = stats && stats.total === 0 && coverage && coverage.extracted_sessions === 0;

  return (
    <div className="px-10 py-8 max-w-[960px]">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-[22px] font-semibold tracking-tight text-text">Insights</h1>
        <div className="flex items-center gap-3">
          <select
            className="bg-white/6 border border-border rounded-md px-2.5 py-1.5 text-[11px] text-text-secondary outline-none cursor-pointer hover:border-border/80"
            value={extractionInterval}
            onChange={(e) => handleIntervalChange(Number(e.target.value))}
          >
            <option value={1}>Every 1 day</option>
            <option value={3}>Every 3 days</option>
            <option value={7}>Every 7 days</option>
          </select>
          <button
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium text-text bg-accent-purple/15 border border-accent-purple/30 rounded-lg transition-all hover:bg-accent-purple/25 disabled:opacity-40"
            onClick={handleExtract}
            disabled={extracting}
          >
            {extracting ? (
              <>
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" className="animate-spin">
                  <path d="M13.65 2.35A8 8 0 103.34 13.66M13.65 2.35V6.5M13.65 2.35H9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Extracting...
              </>
            ) : (
              "Run Now"
            )}
          </button>
        </div>
      </div>

      {/* Stats row */}
      {stats && (
        <div className="flex items-center gap-6 mb-5 text-[12px] text-text-secondary">
          <span>
            <span className="text-text font-semibold">{stats.total}</span> insights
          </span>
          {coverage && (
            <span className="flex items-center gap-2">
              <span>
                {coverage.extracted_sessions}/{coverage.total_sessions} sessions extracted
              </span>
              <div className="w-24 h-1.5 bg-white/8 rounded-full overflow-hidden">
                <div
                  className="h-full bg-accent-purple/60 rounded-full transition-all"
                  style={{
                    width: `${coverage.total_sessions > 0 ? (coverage.extracted_sessions / coverage.total_sessions) * 100 : 0}%`,
                  }}
                />
              </div>
            </span>
          )}
        </div>
      )}

      {/* Empty state */}
      {isEmpty && (
        <div className="flex flex-col items-center justify-center gap-4 py-20 text-center">
          <svg width="40" height="40" viewBox="0 0 16 16" fill="none" className="text-text-dim">
            <path d="M8 1a5 5 0 00-1.5 9.77V12.5a1.5 1.5 0 003 0v-1.73A5 5 0 008 1zm0 2a3 3 0 011.5 5.6V12.5a1.5 1.5 0 01-3 0V8.6A3 3 0 018 3z" fill="currentColor" />
            <path d="M6.5 14.5h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
          <p className="text-[13px] text-text-secondary">No insights extracted yet. Click "Run Now" to analyze your sessions.</p>
          <button
            className="inline-flex items-center gap-1.5 px-4 py-2 text-[13px] font-medium text-text bg-accent-purple/15 border border-accent-purple/30 rounded-lg transition-all hover:bg-accent-purple/25"
            onClick={handleExtract}
            disabled={extracting}
          >
            Extract Insights
          </button>
        </div>
      )}

      {/* Filter + Sort bar */}
      {!isEmpty && (
        <>
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-1.5 flex-wrap">
              {INSIGHT_TYPES.map((type) => {
                const isActive = typeFilter === type;
                const count = type === "all" ? stats?.total || 0 : getTypeCount(type);
                return (
                  <button
                    key={type}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium transition-all ${
                      isActive
                        ? "bg-accent-purple/15 text-accent-purple border border-accent-purple/30"
                        : "text-text-secondary border border-transparent hover:bg-white/6 hover:text-text"
                    }`}
                    onClick={() => setTypeFilter(type)}
                  >
                    {type === "all" ? (
                      "All"
                    ) : (
                      <>
                        <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: INSIGHT_TYPE_COLORS[type] }} />
                        {type}
                      </>
                    )}
                    <span className="text-[10px] opacity-60">{count}</span>
                  </button>
                );
              })}
            </div>
            <select
              className="bg-white/6 border border-border rounded-md px-2.5 py-1.5 text-[11px] text-text-secondary outline-none cursor-pointer hover:border-border/80"
              value={sort}
              onChange={(e) => setSort(e.target.value as SortValue)}
            >
              {SORT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          {/* Insight cards */}
          <div className="flex flex-col gap-2">
            {insights.map((insight) => {
              const v = votes[insight.id];
              const upvotes = v ? v.upvotes : insight.upvotes;
              const downvotes = v ? v.downvotes : insight.downvotes;
              const isExpanded = expandedId === insight.id;

              return (
                <div key={insight.id} className="bg-bg-card border border-border rounded-lg px-4 py-3.5">
                  {/* Top row: type badge + source + date */}
                  <div className="flex items-center gap-2 mb-1.5">
                    <span
                      className="inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide"
                      style={{
                        background: `${INSIGHT_TYPE_COLORS[insight.type]}18`,
                        color: INSIGHT_TYPE_COLORS[insight.type],
                      }}
                    >
                      {insight.type}
                    </span>
                    {insight.source === "subagent" && (
                      <span className="inline-block px-1.5 py-0.5 rounded text-[10px] text-text-dim bg-white/6">subagent</span>
                    )}
                    {insight.observation_count > 1 && (
                      <span className="text-[10px] text-text-dim">&times; {insight.observation_count} sessions</span>
                    )}
                    <span className="ml-auto text-[10px] text-text-dim">{relativeDate(insight.last_observed_at)}</span>
                  </div>

                  {/* Content */}
                  <p className="text-[13px] text-text leading-relaxed mb-2">{insight.content}</p>

                  {/* Files */}
                  {insight.files && insight.files.length > 0 && (
                    <div className="flex items-center gap-1.5 flex-wrap mb-2">
                      {insight.files.slice(0, 3).map((f) => (
                        <button
                          key={f}
                          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono text-accent-blue bg-accent-blue/8 transition-all hover:bg-accent-blue/15 max-w-[200px] truncate"
                          onClick={() => navigate({ to: "/file", search: { path: f } })}
                          title={f}
                        >
                          {f.split("/").pop()}
                        </button>
                      ))}
                      {insight.files.length > 3 && (
                        <span className="text-[10px] text-text-dim">+{insight.files.length - 3} more</span>
                      )}
                    </div>
                  )}

                  {/* Bottom row: votes + expand */}
                  <div className="flex items-center gap-3">
                    <button
                      className="inline-flex items-center gap-1 text-[11px] text-text-secondary transition-all hover:text-text hover:bg-white/6 rounded px-1.5 py-0.5"
                      onClick={() => handleVote(insight.id, "upvote")}
                    >
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                        <path d="M8 3v10M8 3l-4 4M8 3l4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      {upvotes > 0 && upvotes}
                    </button>
                    <button
                      className="inline-flex items-center gap-1 text-[11px] text-text-secondary transition-all hover:text-text hover:bg-white/6 rounded px-1.5 py-0.5"
                      onClick={() => handleVote(insight.id, "downvote")}
                    >
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                        <path d="M8 13V3M8 13l-4-4M8 13l4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      {downvotes > 0 && downvotes}
                    </button>
                    <button
                      className="text-[11px] text-text-dim transition-all hover:text-red-400 rounded px-1.5 py-0.5"
                      onClick={() => handleDismiss(insight.id)}
                      title="Dismiss this insight"
                    >
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                        <path d="M4 4L12 12M12 4L4 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                      </svg>
                    </button>
                    <button
                      className="ml-auto text-[11px] text-text-dim transition-all hover:text-text-secondary"
                      onClick={() => handleExpand(insight.id)}
                    >
                      {isExpanded ? "Collapse" : "Sessions"}
                    </button>
                  </div>

                  {/* Expanded: linked sessions */}
                  {isExpanded && (
                    <div className="mt-3 pt-3 border-t border-border/50">
                      {!expandedDetail ? (
                        <div className="flex items-center gap-2 text-[11px] text-text-dim">
                          <div className="spinner w-3 h-3" />
                          Loading...
                        </div>
                      ) : (
                        <div className="flex flex-col gap-1.5">
                          {expandedDetail.sessions.map((s) => (
                            <button
                              key={s.session_id}
                              className="flex items-center gap-3 text-left px-2.5 py-1.5 rounded-md transition-all hover:bg-white/5"
                              onClick={() => navigate({ to: "/session/$id", params: { id: s.session_id } })}
                            >
                              <span className="text-[12px] text-text truncate flex-1">{s.title || "Untitled session"}</span>
                              <span className="text-[10px] text-text-dim shrink-0">{relativeDate(s.started_at)}</span>
                            </button>
                          ))}
                          {expandedDetail.sessions.length === 0 && (
                            <span className="text-[11px] text-text-dim">No linked sessions</span>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Loading state */}
          {loading && insights.length === 0 && (
            <div className="flex flex-col items-center justify-center gap-3 py-15 text-text-secondary">
              <div className="spinner" />
              <span className="text-[13px]">Loading insights...</span>
            </div>
          )}

          {/* Load more */}
          {hasMore && !loading && (
            <div className="flex justify-center mt-4">
              <button
                className="inline-flex items-center gap-1.5 px-4 py-2 text-[12px] text-text-secondary border border-border rounded-lg transition-all hover:bg-white/6 hover:text-text"
                onClick={loadMore}
              >
                Load more
              </button>
            </div>
          )}

          {/* No results for filter */}
          {!loading && insights.length === 0 && !isEmpty && (
            <div className="text-center py-10 text-[13px] text-text-dim">No insights match this filter.</div>
          )}
        </>
      )}
    </div>
  );
}
