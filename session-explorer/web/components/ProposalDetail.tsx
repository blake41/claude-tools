import { useState, useEffect, useCallback } from "react";
import { useParams, Link } from "@tanstack/react-router";

// ── Types ───────────────────────────────────────────────────────────

interface SectionChange {
  location: string;
  current_text: string;
  proposed_text: string;
  reason: string;
}

interface SkillAmendmentDetail {
  skill_path: string;
  sections_changed: SectionChange[];
  expected_improvement: string;
  confidence: number;
}

interface NewSkillDetail {
  skill_name: string;
  description: string;
  triggers: string[];
  draft_instructions: string;
  evidence_summary: string;
  confidence: number;
}

interface PatternDetail {
  title: string;
  description: string;
  affected_domains: string[];
  suggested_action: string;
  confidence: number;
}

interface WorkflowCritiqueDetail {
  title: string;
  description: string;
  rule_violated: string;
  sessions_affected: number;
  confidence: number;
}

interface KnowledgeGapDetail {
  title: string;
  question_pattern: string;
  proposed_memory: {
    name: string;
    description: string;
    type: string;
    content: string;
  };
  times_asked: number;
  confidence: number;
}

type ProposalDetailData =
  | SkillAmendmentDetail
  | NewSkillDetail
  | PatternDetail
  | WorkflowCritiqueDetail
  | KnowledgeGapDetail;

interface Proposal {
  id: number;
  type: string;
  status: string;
  title: string;
  summary: string;
  detail: string;
  evidence_session_ids: string;
  confidence: number;
  score_impact: number;
  created_at: string;
  reviewed_at: string | null;
  review_note: string | null;
  applied_at: string | null;
  applied_ref: string | null;
}

// ── Helpers ─────────────────────────────────────────────────────────

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
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

const TYPE_COLORS: Record<string, string> = {
  skill_amendment: "bg-purple-600/20 text-purple-400 border border-purple-500/30",
  new_skill: "bg-blue-600/20 text-blue-400 border border-blue-500/30",
  pattern: "bg-emerald-600/20 text-emerald-400 border border-emerald-500/30",
  workflow_critique: "bg-amber-600/20 text-amber-400 border border-amber-500/30",
  knowledge_gap: "bg-rose-600/20 text-rose-400 border border-rose-500/30",
};

const STATUS_COLORS: Record<string, string> = {
  proposed: "bg-zinc-600/20 text-zinc-300 border border-zinc-500/30",
  approved: "bg-green-600/20 text-green-400 border border-green-500/30",
  rejected: "bg-red-600/20 text-red-400 border border-red-500/30",
  deferred: "bg-yellow-600/20 text-yellow-400 border border-yellow-500/30",
  applied: "bg-blue-600/20 text-blue-400 border border-blue-500/30",
};

function Badge({ label, colorClass }: { label: string; colorClass: string }) {
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${colorClass}`}>
      {label.replace(/_/g, " ")}
    </span>
  );
}

// ── Detail Renderers ────────────────────────────────────────────────

function SkillAmendmentView({ detail }: { detail: SkillAmendmentDetail }) {
  return (
    <div className="space-y-4">
      <div className="text-sm text-zinc-400">
        <span className="font-medium text-zinc-300">Skill path:</span>{" "}
        <code className="text-blue-400">{detail.skill_path}</code>
      </div>
      <div className="text-sm text-zinc-400">
        <span className="font-medium text-zinc-300">Expected improvement:</span>{" "}
        {detail.expected_improvement}
      </div>
      {detail.sections_changed.map((section, i) => (
        <div key={i} className="border border-zinc-700 rounded-lg overflow-hidden">
          <div className="bg-zinc-800 px-4 py-2 text-sm font-medium text-zinc-300 border-b border-zinc-700">
            {section.location}
          </div>
          <div className="grid grid-cols-2 gap-0">
            <div className="bg-red-900/20 p-4 border-r border-zinc-700">
              <div className="text-xs font-medium text-red-400 mb-2 uppercase tracking-wide">Current</div>
              <pre className="text-sm text-zinc-300 whitespace-pre-wrap font-mono leading-relaxed">
                {section.current_text}
              </pre>
            </div>
            <div className="bg-green-900/20 p-4">
              <div className="text-xs font-medium text-green-400 mb-2 uppercase tracking-wide">Proposed</div>
              <pre className="text-sm text-zinc-300 whitespace-pre-wrap font-mono leading-relaxed">
                {section.proposed_text}
              </pre>
            </div>
          </div>
          <div className="bg-zinc-800/50 px-4 py-2 text-sm text-zinc-400 border-t border-zinc-700">
            <span className="font-medium text-zinc-300">Reason:</span> {section.reason}
          </div>
        </div>
      ))}
    </div>
  );
}

function NewSkillView({ detail }: { detail: NewSkillDetail }) {
  return (
    <div className="space-y-4">
      <div className="text-sm text-zinc-400">
        <span className="font-medium text-zinc-300">Skill name:</span>{" "}
        <code className="text-blue-400">{detail.skill_name}</code>
      </div>
      <div className="text-sm text-zinc-400">
        <span className="font-medium text-zinc-300">Description:</span> {detail.description}
      </div>
      <div className="text-sm text-zinc-400">
        <span className="font-medium text-zinc-300">Triggers:</span>{" "}
        {detail.triggers.map((t, i) => (
          <code key={i} className="inline-block bg-zinc-700 px-1.5 py-0.5 rounded text-xs text-zinc-300 mr-1 mb-1">
            {t}
          </code>
        ))}
      </div>
      <div className="text-sm text-zinc-400">
        <span className="font-medium text-zinc-300">Evidence summary:</span> {detail.evidence_summary}
      </div>
      <div>
        <div className="text-xs font-medium text-zinc-400 uppercase tracking-wide mb-2">Draft SKILL.md</div>
        <pre className="bg-zinc-950 border border-zinc-700 rounded-lg p-4 text-sm text-zinc-300 font-mono whitespace-pre-wrap overflow-x-auto leading-relaxed">
          {detail.draft_instructions}
        </pre>
      </div>
    </div>
  );
}

function PatternView({ detail }: { detail: PatternDetail }) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-zinc-300 leading-relaxed">{detail.description}</p>
      {detail.affected_domains.length > 0 && (
        <div className="text-sm text-zinc-400">
          <span className="font-medium text-zinc-300">Affected domains:</span>{" "}
          {detail.affected_domains.map((d, i) => (
            <code key={i} className="inline-block bg-zinc-700 px-1.5 py-0.5 rounded text-xs text-zinc-300 mr-1 mb-1">
              {d}
            </code>
          ))}
        </div>
      )}
      <div className="bg-blue-900/20 border border-blue-500/30 rounded-lg p-4">
        <div className="text-xs font-medium text-blue-400 uppercase tracking-wide mb-2">Suggested action</div>
        <p className="text-sm text-zinc-300 leading-relaxed">{detail.suggested_action}</p>
      </div>
    </div>
  );
}

function WorkflowCritiqueView({ detail }: { detail: WorkflowCritiqueDetail }) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-zinc-300 leading-relaxed">{detail.description}</p>
      <div className="bg-amber-900/20 border border-amber-500/30 rounded-lg p-4">
        <div className="text-xs font-medium text-amber-400 uppercase tracking-wide mb-2">Rule violated</div>
        <p className="text-sm text-zinc-300 font-mono leading-relaxed">{detail.rule_violated}</p>
      </div>
      <div className="text-sm text-zinc-400">
        <span className="font-medium text-zinc-300">Sessions affected:</span> {detail.sessions_affected}
      </div>
    </div>
  );
}

function KnowledgeGapView({ detail }: { detail: KnowledgeGapDetail }) {
  const memoryPreview = `---
name: ${detail.proposed_memory.name}
description: ${detail.proposed_memory.description}
type: ${detail.proposed_memory.type}
---

${detail.proposed_memory.content}`;

  return (
    <div className="space-y-4">
      <div className="text-sm text-zinc-400">
        <span className="font-medium text-zinc-300">Question pattern:</span> {detail.question_pattern}
      </div>
      <div className="text-sm text-zinc-400">
        <span className="font-medium text-zinc-300">Times asked:</span> {detail.times_asked}
      </div>
      <div>
        <div className="text-xs font-medium text-zinc-400 uppercase tracking-wide mb-2">Proposed memory entry</div>
        <pre className="bg-zinc-950 border border-zinc-700 rounded-lg p-4 text-sm text-zinc-300 font-mono whitespace-pre-wrap overflow-x-auto leading-relaxed">
          {memoryPreview}
        </pre>
      </div>
    </div>
  );
}

function DetailRenderer({ type, detail }: { type: string; detail: string }) {
  let parsed: ProposalDetailData;
  try {
    parsed = JSON.parse(detail) as ProposalDetailData;
  } catch {
    return <pre className="text-sm text-zinc-400 whitespace-pre-wrap">{detail}</pre>;
  }

  switch (type) {
    case "skill_amendment":
      return <SkillAmendmentView detail={parsed as SkillAmendmentDetail} />;
    case "new_skill":
      return <NewSkillView detail={parsed as NewSkillDetail} />;
    case "pattern":
      return <PatternView detail={parsed as PatternDetail} />;
    case "workflow_critique":
      return <WorkflowCritiqueView detail={parsed as WorkflowCritiqueDetail} />;
    case "knowledge_gap":
      return <KnowledgeGapView detail={parsed as KnowledgeGapDetail} />;
    default:
      return <pre className="text-sm text-zinc-400 whitespace-pre-wrap">{detail}</pre>;
  }
}

// ── Main Component ──────────────────────────────────────────────────

export default function ProposalDetail() {
  const { proposalId } = useParams({ strict: false }) as { proposalId: string };
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [showRejectNote, setShowRejectNote] = useState(false);
  const [rejectNote, setRejectNote] = useState("");

  const fetchProposal = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch(`/api/meta/proposals/${proposalId}`)
      .then((r) => {
        if (!r.ok) throw new Error(`Failed to fetch proposal (${r.status})`);
        return r.json();
      })
      .then((data: Proposal) => {
        setProposal(data);
        setLoading(false);
      })
      .catch((err: Error) => {
        setError(err.message);
        setLoading(false);
      });
  }, [proposalId]);

  useEffect(() => {
    fetchProposal();
  }, [fetchProposal]);

  const handleAction = useCallback(
    (status: string, note?: string) => {
      setActionLoading(true);
      fetch(`/api/meta/proposals/${proposalId}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, note }),
      })
        .then((r) => {
          if (!r.ok) throw new Error(`Review action failed (${r.status})`);
          setShowRejectNote(false);
          setRejectNote("");
          setActionLoading(false);
          fetchProposal();
        })
        .catch((err: Error) => {
          setError(err.message);
          setActionLoading(false);
        });
    },
    [proposalId, fetchProposal],
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-zinc-400 text-sm">Loading proposal...</div>
      </div>
    );
  }

  if (error || !proposal) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3">
        <div className="text-red-400 text-sm">{error || "Proposal not found"}</div>
        <Link to="/meta/proposals" className="text-blue-400 hover:text-blue-300 text-sm">
          Back to proposals
        </Link>
      </div>
    );
  }

  let sessionIds: string[] = [];
  try {
    sessionIds = JSON.parse(proposal.evidence_session_ids) as string[];
  } catch {
    // ignore parse errors
  }

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      {/* Back link */}
      <Link
        to="/meta/proposals"
        className="text-blue-400 hover:text-blue-300 text-sm inline-flex items-center gap-1"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path d="M7.78 12.53a.75.75 0 01-1.06 0L2.47 8.28a.75.75 0 010-1.06l4.25-4.25a.749.749 0 111.06 1.06L4.81 7h7.44a.75.75 0 010 1.5H4.81l2.97 2.97a.749.749 0 01-1.06 1.06z" />
        </svg>
        Back to proposals
      </Link>

      {/* Header */}
      <div className="space-y-3">
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-xl font-semibold text-white">{proposal.title}</h1>
          <Badge label={proposal.type} colorClass={TYPE_COLORS[proposal.type] || "bg-zinc-700 text-zinc-300"} />
          <Badge label={proposal.status} colorClass={STATUS_COLORS[proposal.status] || "bg-zinc-700 text-zinc-300"} />
        </div>
        <p className="text-sm text-zinc-300 leading-relaxed">{proposal.summary}</p>
      </div>

      {/* Confidence + dates */}
      <div className="bg-zinc-800 border border-zinc-700 rounded-lg p-4 space-y-3">
        <div className="flex items-center gap-4">
          <span className="text-sm text-zinc-400">Confidence</span>
          <div className="flex items-center gap-3 flex-1">
            <div className="flex-1 h-2 bg-zinc-700 rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-500 rounded-full transition-all"
                style={{ width: `${(proposal.confidence * 100).toFixed(0)}%` }}
              />
            </div>
            <span className="text-sm font-medium text-white w-12 text-right">
              {(proposal.confidence * 100).toFixed(0)}%
            </span>
          </div>
        </div>
        {proposal.score_impact !== 0 && (
          <div className="text-sm text-zinc-400">
            <span className="font-medium text-zinc-300">Score impact:</span>{" "}
            <span className={proposal.score_impact > 0 ? "text-green-400" : "text-red-400"}>
              {proposal.score_impact > 0 ? "+" : ""}
              {proposal.score_impact.toFixed(2)}
            </span>
          </div>
        )}
        <div className="flex gap-6 text-sm text-zinc-400">
          <span>Created {relativeDate(proposal.created_at)}</span>
          {proposal.reviewed_at && <span>Reviewed {relativeDate(proposal.reviewed_at)}</span>}
        </div>
        {proposal.review_note && (
          <div className="text-sm text-zinc-400 border-t border-zinc-700 pt-2 mt-2">
            <span className="font-medium text-zinc-300">Review note:</span> {proposal.review_note}
          </div>
        )}
        {proposal.status === "approved" && proposal.applied_ref && (
          <div className="text-sm text-zinc-400 border-t border-zinc-700 pt-2 mt-2">
            <span className="font-medium text-zinc-300">Applied:</span>{" "}
            <code className="text-green-400">{proposal.applied_ref}</code>
          </div>
        )}
      </div>

      {/* Detail section */}
      <div className="bg-zinc-800 border border-zinc-700 rounded-lg p-4">
        <h2 className="text-sm font-medium text-zinc-300 uppercase tracking-wide mb-4">Detail</h2>
        <DetailRenderer type={proposal.type} detail={proposal.detail} />
      </div>

      {/* Evidence sessions */}
      {sessionIds.length > 0 && (
        <div className="bg-zinc-800 border border-zinc-700 rounded-lg p-4">
          <h2 className="text-sm font-medium text-zinc-300 uppercase tracking-wide mb-3">Evidence sessions</h2>
          <div className="flex flex-col gap-1">
            {sessionIds.map((sid) => (
              <Link
                key={sid}
                to="/session/$id"
                params={{ id: sid }}
                className="text-blue-400 hover:text-blue-300 text-sm font-mono truncate"
              >
                {sid}
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Action buttons */}
      {proposal.status === "proposed" && (
        <div className="bg-zinc-800 border border-zinc-700 rounded-lg p-4 space-y-3">
          <h2 className="text-sm font-medium text-zinc-300 uppercase tracking-wide mb-3">Actions</h2>
          <div className="flex gap-3">
            <button
              onClick={() => handleAction("approved")}
              disabled={actionLoading}
              className="px-4 py-2 bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
            >
              Approve
            </button>
            <button
              onClick={() => setShowRejectNote(true)}
              disabled={actionLoading}
              className="px-4 py-2 bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
            >
              Reject
            </button>
            <button
              onClick={() => handleAction("deferred")}
              disabled={actionLoading}
              className="px-4 py-2 bg-yellow-600 hover:bg-yellow-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
            >
              Defer
            </button>
          </div>
          {showRejectNote && (
            <div className="space-y-2">
              <textarea
                value={rejectNote}
                onChange={(e) => setRejectNote(e.target.value)}
                placeholder="Rejection reason..."
                className="w-full h-24 bg-zinc-900 border border-zinc-600 rounded-lg p-3 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-blue-500 resize-none"
              />
              <div className="flex gap-2">
                <button
                  onClick={() => handleAction("rejected", rejectNote)}
                  disabled={actionLoading || !rejectNote.trim()}
                  className="px-3 py-1.5 bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white text-xs font-medium rounded-lg transition-colors"
                >
                  Confirm reject
                </button>
                <button
                  onClick={() => {
                    setShowRejectNote(false);
                    setRejectNote("");
                  }}
                  className="px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-white text-xs font-medium rounded-lg transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
