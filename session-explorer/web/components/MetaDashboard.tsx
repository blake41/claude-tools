import { useState, useEffect } from "react";
import { Link } from "@tanstack/react-router";

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
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

const TYPE_COLORS: Record<string, { bg: string; text: string }> = {
  skill_amendment: { bg: "bg-blue-900/50", text: "text-blue-400" },
  new_skill: { bg: "bg-green-900/50", text: "text-green-400" },
  pattern: { bg: "bg-purple-900/50", text: "text-purple-400" },
  workflow_critique: { bg: "bg-yellow-900/50", text: "text-yellow-400" },
  knowledge_gap: { bg: "bg-orange-900/50", text: "text-orange-400" },
};

const TYPE_LABELS: Record<string, string> = {
  skill_amendment: "Skill Amendments",
  new_skill: "New Skills",
  pattern: "Patterns",
  workflow_critique: "Workflow Critiques",
  knowledge_gap: "Knowledge Gaps",
};

interface ProposalStats {
  counts: Record<string, number>;
}

interface ScoreTrend {
  date: string;
  score: number;
}

interface AnalysisRun {
  id: number;
  trigger: string;
  started_at: string;
  completed_at: string | null;
  error: string | null;
  sessions_analyzed: number;
  proposals_created: number;
}

export default function MetaDashboard() {
  const [stats, setStats] = useState<ProposalStats | null>(null);
  const [trends, setTrends] = useState<ScoreTrend[]>([]);
  const [runs, setRuns] = useState<AnalysisRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);

  useEffect(() => {
    setLoading(true);
    setError(null);

    Promise.all([
      fetch("/api/meta/proposals/stats").then((r) => r.json()),
      fetch("/api/meta/scores/trends?days=30").then((r) => r.json()),
      fetch("/api/meta/runs?limit=5").then((r) => r.json()),
    ])
      .then(([statsData, trendsData, runsData]: [ProposalStats, ScoreTrend[], AnalysisRun[]]) => {
        setStats(statsData);
        setTrends(trendsData);
        setRuns(runsData);
      })
      .catch(() => setError("Failed to load meta dashboard data"))
      .finally(() => setLoading(false));
  }, []);

  const runAnalysis = () => {
    setAnalyzing(true);
    fetch("/api/meta/analyze", { method: "POST" })
      .then((r) => {
        if (!r.ok) throw new Error("Analysis failed");
        return r.json();
      })
      .then(() => {
        // Refresh data after analysis
        return Promise.all([
          fetch("/api/meta/proposals/stats").then((r) => r.json()),
          fetch("/api/meta/scores/trends?days=30").then((r) => r.json()),
          fetch("/api/meta/runs?limit=5").then((r) => r.json()),
        ]);
      })
      .then(([statsData, trendsData, runsData]: [ProposalStats, ScoreTrend[], AnalysisRun[]]) => {
        setStats(statsData);
        setTrends(trendsData);
        setRuns(runsData);
      })
      .catch(() => setError("Analysis failed"))
      .finally(() => setAnalyzing(false));
  };

  if (loading) {
    return (
      <div className="px-10 py-8 max-w-[1200px]">
        <div className="flex items-center justify-center gap-2.5 py-5 text-text-secondary text-[13px]">
          <div className="spinner" />
          <span>Loading...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="px-10 py-8 max-w-[1200px]">
        <div className="bg-red-900/20 border border-red-500/30 text-red-400 px-3.5 py-2.5 rounded-lg text-[13px]">
          {error}
        </div>
      </div>
    );
  }

  const proposalTypes = ["skill_amendment", "new_skill", "pattern", "workflow_critique", "knowledge_gap"];

  return (
    <div className="px-10 py-8 max-w-[1200px]">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-[22px] font-semibold tracking-tight">Meta Layer</h1>
        <button
          className="text-[13px] text-white bg-blue-600 rounded-lg px-3 py-1.5 font-medium transition-all hover:bg-blue-500 disabled:opacity-50"
          onClick={runAnalysis}
          disabled={analyzing}
        >
          {analyzing ? (
            <span className="flex items-center gap-2">
              <div className="spinner" />
              Running...
            </span>
          ) : (
            "Run Analysis"
          )}
        </button>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-5 gap-3 mb-6">
        {proposalTypes.map((type) => {
          const colors = TYPE_COLORS[type];
          const count = stats?.counts[type] ?? 0;
          return (
            <Link
              key={type}
              to="/meta/proposals"
              search={{ type }}
              className="block bg-zinc-800 border border-zinc-700 rounded-lg p-4 transition-all hover:border-zinc-500 no-underline"
            >
              <span
                className={`inline-block px-2 py-0.5 rounded text-[11px] font-semibold ${colors.bg} ${colors.text}`}
              >
                {type.replace(/_/g, " ")}
              </span>
              <div className="text-2xl font-bold text-white mt-2">{count}</div>
              <div className="text-[11px] text-zinc-400 mt-0.5">{TYPE_LABELS[type]}</div>
            </Link>
          );
        })}
      </div>

      <div className="grid grid-cols-2 gap-6 mb-6">
        {/* Score trend */}
        <div className="bg-zinc-800 border border-zinc-700 rounded-lg p-4">
          <h2 className="text-sm font-semibold text-white mb-3">Score Trend (30d)</h2>
          {trends.length === 0 ? (
            <p className="text-[13px] text-zinc-400">No score data yet.</p>
          ) : (
            <div className="space-y-1.5">
              {trends.slice(0, 10).map((t) => (
                <div key={t.date} className="flex items-center justify-between text-[13px]">
                  <span className="text-zinc-400">{t.date}</span>
                  <span className="text-white font-mono">{t.score.toFixed(1)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Recent runs */}
        <div className="bg-zinc-800 border border-zinc-700 rounded-lg p-4">
          <h2 className="text-sm font-semibold text-white mb-3">Recent Runs</h2>
          {runs.length === 0 ? (
            <p className="text-[13px] text-zinc-400">No analysis runs yet.</p>
          ) : (
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-zinc-400 text-left">
                  <th className="pb-2 font-medium">Trigger</th>
                  <th className="pb-2 font-medium">When</th>
                  <th className="pb-2 font-medium text-right">Sessions</th>
                  <th className="pb-2 font-medium text-right">Proposals</th>
                  <th className="pb-2 font-medium text-right">Status</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id} className="border-t border-zinc-700/50">
                    <td className="py-1.5 text-white">{run.trigger}</td>
                    <td className="py-1.5 text-zinc-400">{relativeDate(run.started_at)}</td>
                    <td className="py-1.5 text-white text-right">{run.sessions_analyzed}</td>
                    <td className="py-1.5 text-white text-right">{run.proposals_created}</td>
                    <td className="py-1.5 text-right">
                      {run.error ? (
                        <span className="inline-block px-2 py-0.5 rounded text-[11px] font-semibold bg-red-900/50 text-red-400">
                          error
                        </span>
                      ) : run.completed_at ? (
                        <span className="inline-block px-2 py-0.5 rounded text-[11px] font-semibold bg-green-900/50 text-green-400">
                          completed
                        </span>
                      ) : (
                        <span className="inline-block px-2 py-0.5 rounded text-[11px] font-semibold bg-yellow-900/50 text-yellow-400">
                          running
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Quick links */}
      <div className="flex items-center gap-3">
        <Link
          to="/meta/proposals"
          className="text-[13px] text-blue-400 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 transition-all hover:border-blue-400 no-underline"
        >
          All Proposals
        </Link>
        <Link
          to="/meta/scores"
          className="text-[13px] text-blue-400 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 transition-all hover:border-blue-400 no-underline"
        >
          Scores
        </Link>
        <Link
          to="/meta/settings"
          className="text-[13px] text-blue-400 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 transition-all hover:border-blue-400 no-underline"
        >
          Settings
        </Link>
      </div>
    </div>
  );
}
