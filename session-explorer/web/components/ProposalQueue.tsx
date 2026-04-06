import { useState, useEffect } from "react";
import { Link, useSearch } from "@tanstack/react-router";

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

interface Proposal {
  id: number;
  type: string;
  title: string;
  summary: string;
  confidence: number;
  status: string;
  evidence_session_ids: string;
  created_at: string;
}

interface ProposalsResponse {
  proposals: Proposal[];
  total: number;
}

type SortOption = "confidence_desc" | "date_desc";

export default function ProposalQueue() {
  const search = useSearch({ strict: false }) as Record<string, string | undefined>;
  const initialType = search.type ?? "all";

  const [typeFilter, setTypeFilter] = useState(initialType);
  const [statusFilter, setStatusFilter] = useState("all");
  const [sort, setSort] = useState<SortOption>("confidence_desc");
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [bulkAction, setBulkAction] = useState<string | null>(null);

  const limit = 20;

  const fetchProposals = (newOffset: number) => {
    setLoading(true);
    setError(null);

    const params = new URLSearchParams();
    if (typeFilter !== "all") params.set("type", typeFilter);
    if (statusFilter !== "all") params.set("status", statusFilter);
    params.set("sort", sort);
    params.set("limit", String(limit));
    params.set("offset", String(newOffset));

    fetch(`/api/meta/proposals?${params.toString()}`)
      .then((r) => {
        if (!r.ok) throw new Error("Failed to fetch proposals");
        return r.json();
      })
      .then((data: ProposalsResponse) => {
        setProposals(data.proposals);
        setTotal(data.total);
        setOffset(newOffset);
      })
      .catch(() => setError("Failed to load proposals"))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchProposals(0);
  }, [typeFilter, statusFilter, sort]);

  const parseEvidenceCount = (json: string): number => {
    try {
      const arr: unknown[] = JSON.parse(json);
      return arr.length;
    } catch {
      return 0;
    }
  };

  const confidenceColor = (c: number): string => {
    if (c > 0.8) return "bg-green-500";
    if (c > 0.5) return "bg-yellow-500";
    return "bg-red-500";
  };

  const runBulkAction = async (action: "approve_high" | "defer_low") => {
    setBulkAction(action);
    const targets = proposals.filter((p) => {
      if (p.status !== "proposed") return false;
      if (action === "approve_high") return p.confidence >= 0.8;
      return p.confidence < 0.5;
    });

    try {
      for (const p of targets) {
        const newStatus = action === "approve_high" ? "approved" : "deferred";
        await fetch(`/api/meta/proposals/${p.id}/review`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: newStatus }),
        });
      }
      fetchProposals(offset);
    } catch {
      setError("Bulk action failed");
    } finally {
      setBulkAction(null);
    }
  };

  const runAnalysis = () => {
    setLoading(true);
    fetch("/api/meta/analyze", { method: "POST" })
      .then((r) => {
        if (!r.ok) throw new Error("Analysis failed");
        return r.json();
      })
      .then(() => fetchProposals(0))
      .catch(() => setError("Analysis failed"))
      .finally(() => setLoading(false));
  };

  const totalPages = Math.ceil(total / limit);
  const currentPage = Math.floor(offset / limit) + 1;

  const proposalTypes = ["all", "skill_amendment", "new_skill", "pattern", "workflow_critique", "knowledge_gap"];
  const statuses = ["all", "proposed", "approved", "rejected", "deferred"];

  return (
    <div className="px-10 py-8 max-w-[1200px]">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">Proposals</h1>
          <p className="text-[13px] text-zinc-400 mt-0.5">{total} total</p>
        </div>
        <Link
          to="/meta"
          className="text-[13px] text-blue-400 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 transition-all hover:border-blue-400 no-underline"
        >
          Back to Dashboard
        </Link>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="text-[13px] bg-zinc-800 border border-zinc-700 text-white rounded-lg px-3 py-1.5"
        >
          {proposalTypes.map((t) => (
            <option key={t} value={t}>
              {t === "all" ? "All types" : t.replace(/_/g, " ")}
            </option>
          ))}
        </select>

        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="text-[13px] bg-zinc-800 border border-zinc-700 text-white rounded-lg px-3 py-1.5"
        >
          {statuses.map((s) => (
            <option key={s} value={s}>
              {s === "all" ? "All statuses" : s}
            </option>
          ))}
        </select>

        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as SortOption)}
          className="text-[13px] bg-zinc-800 border border-zinc-700 text-white rounded-lg px-3 py-1.5"
        >
          <option value="confidence_desc">Confidence (high first)</option>
          <option value="date_desc">Date (newest first)</option>
        </select>

        <span className="w-px h-4 bg-zinc-700 mx-1" />

        <button
          className="text-[13px] text-green-400 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 font-medium transition-all hover:border-green-400 disabled:opacity-50"
          onClick={() => runBulkAction("approve_high")}
          disabled={bulkAction !== null}
        >
          {bulkAction === "approve_high" ? "Approving..." : "Approve All High-Confidence"}
        </button>

        <button
          className="text-[13px] text-yellow-400 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 font-medium transition-all hover:border-yellow-400 disabled:opacity-50"
          onClick={() => runBulkAction("defer_low")}
          disabled={bulkAction !== null}
        >
          {bulkAction === "defer_low" ? "Deferring..." : "Defer All Low-Confidence"}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-900/20 border border-red-500/30 text-red-400 px-3.5 py-2.5 rounded-lg text-[13px] mb-4">
          {error}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center gap-2.5 py-5 text-zinc-400 text-[13px]">
          <div className="spinner" />
          <span>Loading...</span>
        </div>
      )}

      {/* Empty state */}
      {!loading && proposals.length === 0 && !error && (
        <div className="flex flex-col items-center justify-center py-16 text-zinc-400">
          <p className="text-sm mb-4">No proposals yet. Run analysis to generate suggestions.</p>
          <button
            className="text-[13px] text-white bg-blue-600 rounded-lg px-3 py-1.5 font-medium transition-all hover:bg-blue-500"
            onClick={runAnalysis}
          >
            Run Analysis
          </button>
        </div>
      )}

      {/* Proposal list */}
      {!loading && proposals.length > 0 && (
        <div className="space-y-3">
          {proposals.map((p) => {
            const colors = TYPE_COLORS[p.type] ?? { bg: "bg-zinc-700", text: "text-zinc-300" };
            const evidenceCount = parseEvidenceCount(p.evidence_session_ids);

            return (
              <Link
                key={p.id}
                to="/meta/proposals/$id"
                params={{ id: String(p.id) }}
                className="block bg-zinc-800 border border-zinc-700 rounded-lg p-4 transition-all hover:border-zinc-500 no-underline"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1.5">
                      <span
                        className={`inline-block px-2 py-0.5 rounded text-[11px] font-semibold ${colors.bg} ${colors.text}`}
                      >
                        {p.type.replace(/_/g, " ")}
                      </span>
                      <span className="text-[11px] text-zinc-400">{relativeDate(p.created_at)}</span>
                      {evidenceCount > 0 && (
                        <span className="text-[11px] text-zinc-500">
                          {evidenceCount} session{evidenceCount !== 1 ? "s" : ""}
                        </span>
                      )}
                    </div>
                    <h3 className="text-sm font-semibold text-white truncate">{p.title}</h3>
                    <p className="text-[13px] text-zinc-400 mt-1 line-clamp-2">{p.summary}</p>
                  </div>
                  <div className="shrink-0 text-right">
                    <span className="text-[11px] text-zinc-400 block mb-1">
                      {(p.confidence * 100).toFixed(0)}%
                    </span>
                    <div className="w-24 h-1.5 bg-zinc-700 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${confidenceColor(p.confidence)}`}
                        style={{ width: `${p.confidence * 100}%` }}
                      />
                    </div>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      )}

      {/* Pagination */}
      {!loading && totalPages > 1 && (
        <div className="flex items-center justify-between mt-6">
          <button
            className="text-[13px] text-blue-400 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 transition-all hover:border-blue-400 disabled:opacity-30 disabled:cursor-not-allowed"
            onClick={() => fetchProposals(offset - limit)}
            disabled={offset === 0}
          >
            Previous
          </button>
          <span className="text-[13px] text-zinc-400">
            Page {currentPage} of {totalPages}
          </span>
          <button
            className="text-[13px] text-blue-400 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 transition-all hover:border-blue-400 disabled:opacity-30 disabled:cursor-not-allowed"
            onClick={() => fetchProposals(offset + limit)}
            disabled={offset + limit >= total}
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
