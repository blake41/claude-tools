import Anthropic from "@anthropic-ai/sdk";
import db from "../db.js";
import { config } from "../config.js";
import { WORKFLOW_CRITIQUE_PROMPT } from "./prompts.js";

const anthropic = new Anthropic();

// ── Prepared Statements ────────────────────────────────────────────

const getEditsWithoutVerification = db.prepare(`
  SELECT DISTINCT se.session_id FROM session_events se
  WHERE se.type = 'tool_call' AND se.tool IN ('Edit', 'Write')
  AND se.session_id NOT IN (
    SELECT DISTINCT session_id FROM session_events
    WHERE type = 'tool_call' AND tool = 'Bash'
    AND (metadata LIKE '%tsc%' OR metadata LIKE '%test%' OR metadata LIKE '%lint%')
  )
  AND se.session_id IN (
    SELECT id FROM sessions WHERE started_at >= datetime('now', ?)
  )
`);

const getEditsWithoutVerificationScoped = db.prepare(`
  SELECT DISTINCT se.session_id FROM session_events se
  WHERE se.type = 'tool_call' AND se.tool IN ('Edit', 'Write')
  AND se.session_id NOT IN (
    SELECT DISTINCT session_id FROM session_events
    WHERE type = 'tool_call' AND tool = 'Bash'
    AND (metadata LIKE '%tsc%' OR metadata LIKE '%test%' OR metadata LIKE '%lint%')
  )
  AND se.session_id IN (SELECT value FROM json_each(?))
`);

const getBashMisuse = db.prepare(`
  SELECT session_id, COUNT(*) as bash_misuse_count FROM session_events
  WHERE type = 'tool_call' AND tool = 'Bash'
  AND (metadata LIKE '%grep %' OR metadata LIKE '%cat %' OR metadata LIKE '%find %'
    OR metadata LIKE '%head %' OR metadata LIKE '%tail %')
  AND session_id IN (
    SELECT id FROM sessions WHERE started_at >= datetime('now', ?)
  )
  GROUP BY session_id HAVING bash_misuse_count >= 2
`);

const getBashMisuseScoped = db.prepare(`
  SELECT session_id, COUNT(*) as bash_misuse_count FROM session_events
  WHERE type = 'tool_call' AND tool = 'Bash'
  AND (metadata LIKE '%grep %' OR metadata LIKE '%cat %' OR metadata LIKE '%find %'
    OR metadata LIKE '%head %' OR metadata LIKE '%tail %')
  AND session_id IN (SELECT value FROM json_each(?))
  GROUP BY session_id HAVING bash_misuse_count >= 2
`);

const getMissingDelegation = db.prepare(`
  SELECT se.session_id, COUNT(*) as consecutive_tools
  FROM session_events se
  WHERE se.type = 'tool_call'
  AND se.session_id NOT IN (
    SELECT DISTINCT session_id FROM session_events WHERE type = 'subagent_spawn'
  )
  AND se.session_id IN (
    SELECT id FROM sessions WHERE started_at >= datetime('now', ?)
  )
  GROUP BY se.session_id
  HAVING consecutive_tools > 10
`);

const getMissingDelegationScoped = db.prepare(`
  SELECT se.session_id, COUNT(*) as consecutive_tools
  FROM session_events se
  WHERE se.type = 'tool_call'
  AND se.session_id NOT IN (
    SELECT DISTINCT session_id FROM session_events WHERE type = 'subagent_spawn'
  )
  AND se.session_id IN (SELECT value FROM json_each(?))
  GROUP BY se.session_id
  HAVING consecutive_tools > 10
`);

const getLowScoreSessions = db.prepare(`
  SELECT sc.session_id, sc.composite_score
  FROM session_scores sc
  JOIN sessions s ON sc.session_id = s.id
  WHERE sc.composite_score < 3.0
  AND s.started_at >= datetime('now', ?)
`);

const getLowScoreSessionsScoped = db.prepare(`
  SELECT sc.session_id, sc.composite_score
  FROM session_scores sc
  WHERE sc.composite_score < 3.0
  AND sc.session_id IN (SELECT value FROM json_each(?))
`);

const getSessionEventSummary = db.prepare(`
  SELECT type, tool, COUNT(*) as count
  FROM session_events
  WHERE session_id = ?
  GROUP BY type, tool
  ORDER BY count DESC
`);

const insertProposal = db.prepare(`
  INSERT OR IGNORE INTO proposals
    (type, status, title, summary, detail, evidence_session_ids, confidence, score_impact, created_at)
  VALUES (?, 'proposed', ?, ?, ?, ?, ?, ?, ?)
`);

// ── Main ───────────────────────────────────────────────────────────

export async function runWorkflowCritique(sessionIds?: string[]): Promise<number> {
  const timeRange = "-30 days";
  const now = new Date().toISOString();
  let count = 0;

  // ── Phase 1: Programmatic checks ────────────────────────────────

  // 1a. Sessions with edits but no verification
  const noVerification = sessionIds
    ? (getEditsWithoutVerificationScoped.all(JSON.stringify(sessionIds)) as Array<{ session_id: string }>)
    : (getEditsWithoutVerification.all(timeRange) as Array<{ session_id: string }>);

  if (noVerification.length > 0) {
    const sessionIdList = noVerification.map(s => s.session_id);
    try {
      insertProposal.run(
        "workflow_critique",
        "Missing verification after code changes",
        `${noVerification.length} session(s) edited or wrote files without running tsc, tests, or linter afterward.`,
        JSON.stringify({
          rule_violated: "Verify Before Done: run tests, check logs, verify behavior",
          sessions_affected: noVerification.length,
        }),
        JSON.stringify(sessionIdList),
        Math.min(0.95, 0.7 + noVerification.length * 0.05),
        JSON.stringify({ verification_rigor: -1.5 }),
        now,
      );
      count++;
    } catch (err) {
      console.error("[meta:workflow] Failed to insert verification critique:", err);
    }
  }

  // 1b. Sessions using bash for dedicated tool tasks
  const bashMisuse = sessionIds
    ? (getBashMisuseScoped.all(JSON.stringify(sessionIds)) as Array<{ session_id: string; bash_misuse_count: number }>)
    : (getBashMisuse.all(timeRange) as Array<{ session_id: string; bash_misuse_count: number }>);

  if (bashMisuse.length > 0) {
    const sessionIdList = bashMisuse.map(s => s.session_id);
    const totalMisuses = bashMisuse.reduce((sum, s) => sum + s.bash_misuse_count, 0);
    try {
      insertProposal.run(
        "workflow_critique",
        "Used bash instead of dedicated tools",
        `${bashMisuse.length} session(s) used bash for grep/cat/find/head/tail instead of Read/Grep/Glob tools (${totalMisuses} total instances).`,
        JSON.stringify({
          rule_violated: "Use dedicated tools (Read, Grep, Glob) instead of bash equivalents",
          sessions_affected: bashMisuse.length,
          total_instances: totalMisuses,
        }),
        JSON.stringify(sessionIdList),
        Math.min(0.95, 0.7 + bashMisuse.length * 0.03),
        JSON.stringify({ tool_efficiency: -1.0 }),
        now,
      );
      count++;
    } catch (err) {
      console.error("[meta:workflow] Failed to insert bash misuse critique:", err);
    }
  }

  // 1c. Sessions with many tool calls but no delegation
  const noDelegation = sessionIds
    ? (getMissingDelegationScoped.all(JSON.stringify(sessionIds)) as Array<{ session_id: string; consecutive_tools: number }>)
    : (getMissingDelegation.all(timeRange) as Array<{ session_id: string; consecutive_tools: number }>);

  if (noDelegation.length > 0) {
    const sessionIdList = noDelegation.map(s => s.session_id);
    try {
      insertProposal.run(
        "workflow_critique",
        "Missing delegation to subagents",
        `${noDelegation.length} session(s) had >10 tool calls in the main thread without any subagent spawns.`,
        JSON.stringify({
          rule_violated: "Delegate substantial work to subagents to keep main thread clean",
          sessions_affected: noDelegation.length,
        }),
        JSON.stringify(sessionIdList),
        Math.min(0.95, 0.7 + noDelegation.length * 0.04),
        JSON.stringify({ context_discipline: -1.5 }),
        now,
      );
      count++;
    } catch (err) {
      console.error("[meta:workflow] Failed to insert delegation critique:", err);
    }
  }

  // ── Phase 2: LLM critique for low-scoring sessions ──────────────

  const lowScoreSessions = sessionIds
    ? (getLowScoreSessionsScoped.all(JSON.stringify(sessionIds)) as Array<{ session_id: string; composite_score: number }>)
    : (getLowScoreSessions.all(timeRange) as Array<{ session_id: string; composite_score: number }>);

  for (const session of lowScoreSessions) {
    const events = getSessionEventSummary.all(session.session_id) as Array<{
      type: string;
      tool: string | null;
      count: number;
    }>;

    const eventSummary = events
      .map(e => `${e.type}${e.tool ? `:${e.tool}` : ""} (${e.count})`)
      .join(", ");

    try {
      const response = await anthropic.messages.create({
        model: config.metaAnalysisModel,
        max_tokens: config.metaMaxTokens,
        system: WORKFLOW_CRITIQUE_PROMPT,
        messages: [{
          role: "user",
          content: `Session ${session.session_id} (composite score: ${session.composite_score}):\nEvent summary: ${eventSummary}`,
        }],
      });

      const text = response.content[0].type === "text" ? response.content[0].text : "[]";
      const cleaned = text.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "").trim();
      const critiques = JSON.parse(cleaned) as Array<{
        title: string;
        description: string;
        rule_violated: string;
        sessions_affected: number;
        confidence: number;
      }>;

      if (!Array.isArray(critiques)) continue;

      for (const critique of critiques) {
        if (critique.confidence < config.metaDefaultConfidenceThreshold) continue;

        try {
          insertProposal.run(
            "workflow_critique",
            critique.title,
            critique.description,
            JSON.stringify({
              rule_violated: critique.rule_violated,
              sessions_affected: critique.sessions_affected,
              source: "llm_analysis",
            }),
            JSON.stringify([session.session_id]),
            critique.confidence,
            null,
            now,
          );
          count++;
        } catch (err) {
          console.error("[meta:workflow] Failed to insert LLM critique:", err);
        }
      }
    } catch (err) {
      console.error("[meta:workflow] LLM call failed for session", session.session_id, err);
    }
  }

  return count;
}
