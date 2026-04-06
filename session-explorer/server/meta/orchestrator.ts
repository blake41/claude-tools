import db from "../db.js";
import { BackgroundJob } from "../background-job.js";
import { config } from "../config.js";
import { extractEventsForSessions } from "./events.js";
import { scoreSession, getUnscoredSessionIds } from "./scoring.js";
import { runSkillAmendmentAnalysis } from "./skill-amendment.js";
import { runSkillDiscovery } from "./discovery.js";
import { runPatternDetection } from "./patterns.js";
import { runWorkflowCritique } from "./workflow.js";
import { runKnowledgeGapDetection } from "./knowledge.js";
import type { MetaRunResult, MetaSettings } from "./types.js";

// ── Prepared Statements ────────────────────────────────────────────

const insertRun = db.prepare(`
  INSERT INTO meta_runs (trigger, started_at) VALUES (?, ?)
`);

const updateRunComplete = db.prepare(`
  UPDATE meta_runs SET completed_at = ?, sessions_analyzed = ?, proposals_created = ?, error = ?
  WHERE id = ?
`);

const getRun = db.prepare(`SELECT * FROM meta_runs WHERE id = ?`);

const listRuns = db.prepare(`
  SELECT * FROM meta_runs ORDER BY started_at DESC LIMIT ? OFFSET ?
`);

const getRecentSessionIds = db.prepare(`
  SELECT id FROM sessions WHERE started_at >= ? AND message_count > 5
`);

const getSetting = db.prepare(`SELECT value FROM settings WHERE key = ?`);
const upsertSetting = db.prepare(`
  INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
`);

const countProposalsSince = db.prepare(`
  SELECT COUNT(*) as count FROM proposals WHERE created_at >= ?
`);

// ── Mutex ───────────────────────────────────────────────────────────

let analysisRunning = false;

// ── Scoring Job ─────────────────────────────────────────────────────

const scoringJob = new BackgroundJob(config.metaConcurrency);

// ── Main Orchestration ──────────────────────────────────────────────

export async function runMetaAnalysis(opts: {
  trigger: 'manual' | 'cron' | 'hook';
  sessionIds?: string[];
  since?: string;
}): Promise<MetaRunResult> {
  if (analysisRunning) {
    return { run_id: 0, sessions_analyzed: 0, proposals_created: 0, errors: ['Analysis already running'] };
  }

  analysisRunning = true;
  const now = new Date().toISOString();
  const result = insertRun.run(opts.trigger, now);
  const runId = Number(result.lastInsertRowid);

  const errors: string[] = [];
  let sessionsAnalyzed = 0;

  try {
    // Determine target sessions
    let sessionIds = opts.sessionIds;
    if (!sessionIds) {
      const since = opts.since || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      sessionIds = (getRecentSessionIds.all(since) as Array<{ id: string }>).map(s => s.id);
    }

    if (sessionIds.length === 0) {
      updateRunComplete.run(now, 0, 0, null, runId);
      analysisRunning = false;
      return { run_id: runId, sessions_analyzed: 0, proposals_created: 0, errors: [] };
    }

    sessionsAnalyzed = sessionIds.length;

    // Step 1: Extract events (skip already extracted)
    try {
      extractEventsForSessions(sessionIds);
    } catch (err) {
      errors.push(`Event extraction: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Step 2: Score sessions (skip already scored)
    try {
      for (const id of sessionIds) {
        await scoreSession(id);
      }
    } catch (err) {
      errors.push(`Scoring: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Step 3: Run all six analyzers in parallel
    const analyzerResults = await Promise.allSettled([
      runSkillAmendmentAnalysis(sessionIds).catch(err => {
        errors.push(`Skill amendment: ${err instanceof Error ? err.message : String(err)}`);
        return 0;
      }),
      runSkillDiscovery(sessionIds).catch(err => {
        errors.push(`Skill discovery: ${err instanceof Error ? err.message : String(err)}`);
        return 0;
      }),
      runPatternDetection(sessionIds).catch(err => {
        errors.push(`Pattern detection: ${err instanceof Error ? err.message : String(err)}`);
        return 0;
      }),
      runWorkflowCritique(sessionIds).catch(err => {
        errors.push(`Workflow critique: ${err instanceof Error ? err.message : String(err)}`);
        return 0;
      }),
      runKnowledgeGapDetection(sessionIds).catch(err => {
        errors.push(`Knowledge gap: ${err instanceof Error ? err.message : String(err)}`);
        return 0;
      }),
    ]);

    // Count proposals created during this run
    const proposalsCreated = (countProposalsSince.get(now) as { count: number })?.count ?? 0;

    const completedAt = new Date().toISOString();
    updateRunComplete.run(
      completedAt,
      sessionsAnalyzed,
      proposalsCreated,
      errors.length > 0 ? JSON.stringify(errors) : null,
      runId,
    );

    analysisRunning = false;
    return { run_id: runId, sessions_analyzed: sessionsAnalyzed, proposals_created: proposalsCreated, errors };
  } catch (err) {
    const completedAt = new Date().toISOString();
    const errMsg = err instanceof Error ? err.message : String(err);
    errors.push(errMsg);
    updateRunComplete.run(completedAt, sessionsAnalyzed, 0, JSON.stringify(errors), runId);
    analysisRunning = false;
    return { run_id: runId, sessions_analyzed: sessionsAnalyzed, proposals_created: 0, errors };
  }
}

// ── Trigger Management ──────────────────────────────────────────────

let cronInterval: ReturnType<typeof setInterval> | null = null;

export function getMetaSettings(): MetaSettings {
  const get = (key: string, fallback: string) =>
    (getSetting.get(`meta_${key}`) as { value: string } | undefined)?.value ?? fallback;

  return {
    trigger_mode: get('trigger_mode', 'manual') as MetaSettings['trigger_mode'],
    cron_interval_hours: Number(get('cron_interval_hours', '24')),
    hook_enabled: get('hook_enabled', 'false') === 'true',
    scoring_threshold: Number(get('scoring_threshold', String(config.metaDefaultScoringThreshold))),
    min_invocations: Number(get('min_invocations', String(config.metaDefaultMinInvocations))),
    confidence_threshold: Number(get('confidence_threshold', String(config.metaDefaultConfidenceThreshold))),
  };
}

export function updateMetaSettings(updates: Partial<MetaSettings>): MetaSettings {
  if (updates.trigger_mode !== undefined) upsertSetting.run('meta_trigger_mode', updates.trigger_mode);
  if (updates.cron_interval_hours !== undefined) upsertSetting.run('meta_cron_interval_hours', String(updates.cron_interval_hours));
  if (updates.hook_enabled !== undefined) upsertSetting.run('meta_hook_enabled', String(updates.hook_enabled));
  if (updates.scoring_threshold !== undefined) upsertSetting.run('meta_scoring_threshold', String(updates.scoring_threshold));
  if (updates.min_invocations !== undefined) upsertSetting.run('meta_min_invocations', String(updates.min_invocations));
  if (updates.confidence_threshold !== undefined) upsertSetting.run('meta_confidence_threshold', String(updates.confidence_threshold));

  // Restart cron if trigger mode changed
  setupCronTrigger();

  return getMetaSettings();
}

export function setupCronTrigger(): void {
  // Clear existing interval
  if (cronInterval) {
    clearInterval(cronInterval);
    cronInterval = null;
  }

  const settings = getMetaSettings();
  if (settings.trigger_mode === 'cron' || settings.trigger_mode === 'cron+hook') {
    const intervalMs = settings.cron_interval_hours * 60 * 60 * 1000;
    cronInterval = setInterval(() => {
      if (!analysisRunning) {
        runMetaAnalysis({ trigger: 'cron' }).catch(err => {
          console.error('[meta-cron] Error:', err instanceof Error ? err.message : String(err));
        });
      }
    }, intervalMs);
    console.log(`[meta] Cron trigger enabled: every ${settings.cron_interval_hours}h`);
  }
}

export function isAnalysisRunning(): boolean {
  return analysisRunning;
}

// ── Query Helpers ────────────────────────────────────────────────────

export function getMetaRun(id: number) {
  return getRun.get(id);
}

export function listMetaRuns(limit = 20, offset = 0) {
  return listRuns.all(limit, offset);
}

// ── Proposal Management ─────────────────────────────────────────────

const listProposals = db.prepare(`
  SELECT * FROM proposals
  WHERE (? IS NULL OR type = ?) AND (? IS NULL OR status = ?)
  ORDER BY created_at DESC
  LIMIT ? OFFSET ?
`);

const getProposal = db.prepare(`SELECT * FROM proposals WHERE id = ?`);

const updateProposalStatus = db.prepare(`
  UPDATE proposals SET status = ?, reviewed_at = ?, review_note = ? WHERE id = ?
`);

const updateProposalApplied = db.prepare(`
  UPDATE proposals SET applied_at = ?, applied_ref = ? WHERE id = ?
`);

const proposalStats = db.prepare(`
  SELECT
    type,
    status,
    COUNT(*) as count,
    AVG(confidence) as avg_confidence
  FROM proposals
  GROUP BY type, status
`);

export function listProposalsFn(opts: {
  type?: string;
  status?: string;
  limit?: number;
  offset?: number;
}) {
  return listProposals.all(
    opts.type || null, opts.type || null,
    opts.status || null, opts.status || null,
    opts.limit || 50, opts.offset || 0,
  );
}

export function getProposalFn(id: number) {
  return getProposal.get(id);
}

export function reviewProposal(id: number, status: 'approved' | 'rejected' | 'deferred', note?: string) {
  const now = new Date().toISOString();
  updateProposalStatus.run(status, now, note || null, id);
  return getProposal.get(id);
}

export function markProposalApplied(id: number, ref: string) {
  const now = new Date().toISOString();
  updateProposalApplied.run(now, ref, id);
  return getProposal.get(id);
}

export function getProposalStats() {
  return proposalStats.all();
}
