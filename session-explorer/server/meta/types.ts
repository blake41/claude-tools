// ── Meta Layer Types ──────────────────────────────────────────────

export interface SessionEvent {
  type: 'tool_call' | 'error' | 'retry' | 'user_correction' | 'subagent_spawn' | 'skill_invocation';
  tool?: string | null;
  target_file?: string | null;
  success: boolean;
  retry_of?: number; // sequence of previous failed attempt
  token_cost?: number | null;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface SessionScore {
  session_id: string;
  tool_efficiency: number;
  fix_convergence: number;
  context_discipline: number;
  verification_rigor: number;
  architectural_alignment: number;
  composite_score: number;
  raw_event_count: number;
  scored_at: string;
}

export interface SkillAmendment {
  skill_path: string;
  sections_changed: Array<{
    location: string;
    current_text: string;
    proposed_text: string;
    reason: string;
  }>;
  evidence_session_ids: string[];
  confidence: number;
  expected_improvement: string;
}

export type ProposalType =
  | 'skill_amendment'
  | 'new_skill'
  | 'pattern'
  | 'workflow_critique'
  | 'knowledge_gap';

export type ProposalStatus = 'proposed' | 'approved' | 'rejected' | 'deferred';

export interface Proposal {
  id: number;
  type: ProposalType;
  status: ProposalStatus;
  title: string;
  summary: string;
  detail: string; // JSON payload
  evidence_session_ids: string; // JSON array
  confidence: number;
  score_impact: string | null;
  created_at: string;
  reviewed_at: string | null;
  review_note: string | null;
  applied_at: string | null;
  applied_ref: string | null;
}

export interface MetaRun {
  id: number;
  trigger: 'manual' | 'cron' | 'hook';
  started_at: string;
  completed_at: string | null;
  sessions_analyzed: number;
  proposals_created: number;
  error: string | null;
}

export type FailureCategory =
  | 'instruction_gap'
  | 'verification_missing'
  | 'delegation_unclear'
  | 'context_overload'
  | 'pattern_violation'
  | 'tool_misuse'
  | 'scope_creep';

export interface MetaRunResult {
  run_id: number;
  sessions_analyzed: number;
  proposals_created: number;
  errors: string[];
}

export interface MetaSettings {
  trigger_mode: 'manual' | 'cron' | 'hook' | 'cron+hook';
  cron_interval_hours: number;
  hook_enabled: boolean;
  scoring_threshold: number; // below this = underperforming
  min_invocations: number; // min skill uses before amendment
  confidence_threshold: number; // min confidence to surface proposal
}
