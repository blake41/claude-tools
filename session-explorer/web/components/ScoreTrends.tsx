import { useState, useEffect, useCallback } from "react";
import { Link } from "@tanstack/react-router";

// ── Types ───────────────────────────────────────────────────────────

interface TrendEntry {
  date: string;
  avg_composite: number;
  avg_tool_efficiency: number;
  avg_fix_convergence: number;
  avg_context_discipline: number;
  avg_verification_rigor: number;
  avg_architectural_alignment: number;
  session_count: number;
}

interface SessionScore {
  session_id: string;
  session_title: string;
  composite: number;
  tool_efficiency: number;
  fix_convergence: number;
  context_discipline: number;
  verification_rigor: number;
  architectural_alignment: number;
  scored_at: string;
}

interface TrendsResponse {
  trends: TrendEntry[];
}

interface ScoresResponse {
  scores: SessionScore[];
  total: number;
}

// ── Helpers ─────────────────────────────────────────────────────────

const AXES = [
  { key: "tool_efficiency" as const, label: "Tool efficiency" },
  { key: "fix_convergence" as const, label: "Fix convergence" },
  { key: "context_discipline" as const, label: "Context discipline" },
  { key: "verification_rigor" as const, label: "Verification rigor" },
  { key: "architectural_alignment" as const, label: "Architectural alignment" },
];

function scoreColor(score: number): string {
  if (score >= 4) return "bg-green-500";
  if (score >= 3) return "bg-yellow-500";
  return "bg-red-500";
}

function scoreTextColor(score: number): string {
  if (score >= 4) return "text-green-400";
  if (score >= 3) return "text-yellow-400";
  return "text-red-400";
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

// ── Main Component ──────────────────────────────────────────────────

export default function ScoreTrends() {
  const [trends, setTrends] = useState<TrendEntry[]>([]);
  const [scores, setScores] = useState<SessionScore[]>([]);
  const [totalScores, setTotalScores] = useState(0);
  const [days, setDays] = useState(30);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const LIMIT = 20;

  const fetchTrends = useCallback(() => {
    fetch(`/api/meta/scores/trends?days=${days}`)
      .then((r) => {
        if (!r.ok) throw new Error(`Failed to fetch trends (${r.status})`);
        return r.json();
      })
      .then((data: TrendsResponse) => setTrends(data.trends || []))
      .catch((err: Error) => setError(err.message));
  }, [days]);

  const fetchScores = useCallback(() => {
    const offset = page * LIMIT;
    fetch(`/api/meta/scores?limit=${LIMIT}&offset=${offset}`)
      .then((r) => {
        if (!r.ok) throw new Error(`Failed to fetch scores (${r.status})`);
        return r.json();
      })
      .then((data: ScoresResponse) => {
        setScores(data.scores || []);
        setTotalScores(data.total || 0);
      })
      .catch((err: Error) => setError(err.message));
  }, [page]);

  useEffect(() => {
    setLoading(true);
    setError(null);
    Promise.all([fetchTrends(), fetchScores()]).finally(() => setLoading(false));
  }, [fetchTrends, fetchScores]);

  if (loading && trends.length === 0 && scores.length === 0) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-zinc-400 text-sm">Loading score data...</div>
      </div>
    );
  }

  if (error && trends.length === 0 && scores.length === 0) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-red-400 text-sm">{error}</div>
      </div>
    );
  }

  const latestTrend = trends.length > 0 ? trends[trends.length - 1] : null;
  const totalPages = Math.ceil(totalScores / LIMIT);

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-8">
      <h1 className="text-xl font-semibold text-white">Score Trends</h1>

      {/* Days filter */}
      <div className="flex gap-2">
        {[7, 30, 90].map((d) => (
          <button
            key={d}
            onClick={() => setDays(d)}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
              days === d
                ? "bg-blue-600 text-white"
                : "bg-zinc-800 text-zinc-400 hover:text-zinc-200 border border-zinc-700"
            }`}
          >
            {d}d
          </button>
        ))}
      </div>

      {/* Trend chart */}
      <div className="bg-zinc-800 border border-zinc-700 rounded-lg p-4">
        <h2 className="text-sm font-medium text-zinc-300 uppercase tracking-wide mb-4">
          Composite score trend ({days} days)
        </h2>
        {trends.length === 0 ? (
          <div className="text-zinc-500 text-sm py-8 text-center">No trend data yet</div>
        ) : (
          <div className="space-y-1.5">
            {trends.map((entry) => {
              const pct = (entry.avg_composite / 5) * 100;
              return (
                <div key={entry.date} className="flex items-center gap-3">
                  <span className="text-xs text-zinc-500 font-mono w-16 shrink-0 text-right">
                    {formatDate(entry.date)}
                  </span>
                  <div className="flex-1 h-5 bg-zinc-700/50 rounded overflow-hidden">
                    <div
                      className={`h-full rounded transition-all ${scoreColor(entry.avg_composite)}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className={`text-xs font-medium w-8 text-right ${scoreTextColor(entry.avg_composite)}`}>
                    {entry.avg_composite.toFixed(1)}
                  </span>
                  <span className="text-xs text-zinc-600 w-6 text-right">{entry.session_count}s</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Per-axis breakdown */}
      {latestTrend && (
        <div className="bg-zinc-800 border border-zinc-700 rounded-lg p-4">
          <h2 className="text-sm font-medium text-zinc-300 uppercase tracking-wide mb-4">
            Latest breakdown ({formatDate(latestTrend.date)})
          </h2>
          <div className="space-y-2">
            {AXES.map(({ key, label }) => {
              const avgKey = `avg_${key}` as keyof TrendEntry;
              const val = latestTrend[avgKey] as number;
              const pct = (val / 5) * 100;
              return (
                <div key={key} className="flex items-center gap-3">
                  <span className="text-xs text-zinc-400 w-44 shrink-0">{label}</span>
                  <div className="flex-1 h-4 bg-zinc-700/50 rounded overflow-hidden">
                    <div
                      className={`h-full rounded transition-all ${scoreColor(val)}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className={`text-xs font-medium w-8 text-right ${scoreTextColor(val)}`}>
                    {val.toFixed(1)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Session scores table */}
      <div className="bg-zinc-800 border border-zinc-700 rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-zinc-700">
          <h2 className="text-sm font-medium text-zinc-300 uppercase tracking-wide">Session scores</h2>
        </div>
        {scores.length === 0 ? (
          <div className="text-zinc-500 text-sm py-8 text-center">No scored sessions yet</div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-zinc-700 text-zinc-500 text-xs uppercase tracking-wide">
                    <th className="text-left px-4 py-2 font-medium">Session</th>
                    <th className="text-right px-3 py-2 font-medium">Composite</th>
                    {AXES.map(({ key, label }) => (
                      <th key={key} className="text-right px-3 py-2 font-medium whitespace-nowrap">
                        {label.split(" ")[0]}
                      </th>
                    ))}
                    <th className="text-right px-4 py-2 font-medium">Scored</th>
                  </tr>
                </thead>
                <tbody>
                  {scores.map((s) => (
                    <tr key={s.session_id} className="border-b border-zinc-700/50 hover:bg-zinc-700/30">
                      <td className="px-4 py-2">
                        <Link
                          to="/session/$id"
                          params={{ id: s.session_id }}
                          className="text-blue-400 hover:text-blue-300 truncate block max-w-[200px]"
                        >
                          {s.session_title || s.session_id.slice(0, 12)}
                        </Link>
                      </td>
                      <td className={`text-right px-3 py-2 font-medium ${scoreTextColor(s.composite)}`}>
                        {s.composite.toFixed(1)}
                      </td>
                      {AXES.map(({ key }) => (
                        <td key={key} className={`text-right px-3 py-2 ${scoreTextColor(s[key])}`}>
                          {s[key].toFixed(1)}
                        </td>
                      ))}
                      <td className="text-right px-4 py-2 text-zinc-500 text-xs">
                        {formatDate(s.scored_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between px-4 py-3 border-t border-zinc-700">
                <span className="text-xs text-zinc-500">
                  Page {page + 1} of {totalPages} ({totalScores} total)
                </span>
                <div className="flex gap-2">
                  <button
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                    disabled={page === 0}
                    className="px-3 py-1 text-xs bg-zinc-700 hover:bg-zinc-600 disabled:opacity-40 text-zinc-300 rounded transition-colors"
                  >
                    Prev
                  </button>
                  <button
                    onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                    disabled={page >= totalPages - 1}
                    className="px-3 py-1 text-xs bg-zinc-700 hover:bg-zinc-600 disabled:opacity-40 text-zinc-300 rounded transition-colors"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
