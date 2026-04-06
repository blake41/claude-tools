import Anthropic from "@anthropic-ai/sdk";
import db from "../db.js";
import { config } from "../config.js";
import { PATTERN_SYNTHESIS_PROMPT } from "./prompts.js";

const anthropic = new Anthropic();

// ── Prepared Statements ────────────────────────────────────────────

const getHighObservationInsights = db.prepare(`
  SELECT * FROM insights
  WHERE observation_count >= 3 AND deleted_at IS NULL
  ORDER BY observation_count DESC
  LIMIT 50
`);

const getHighObservationInsightsScoped = db.prepare(`
  SELECT i.* FROM insights i
  JOIN insight_sessions ise ON i.id = ise.insight_id
  WHERE i.observation_count >= 3 AND i.deleted_at IS NULL
  AND ise.session_id IN (SELECT value FROM json_each(?))
  ORDER BY i.observation_count DESC
  LIMIT 50
`);

const getRecurringErrors = db.prepare(`
  SELECT tool, target_file, COUNT(*) as count
  FROM session_events
  WHERE type = 'error'
  AND session_id IN (
    SELECT id FROM sessions WHERE started_at >= datetime('now', ?)
  )
  GROUP BY tool, target_file
  HAVING count >= 3
`);

const getRecurringErrorsScoped = db.prepare(`
  SELECT tool, target_file, COUNT(*) as count
  FROM session_events
  WHERE type = 'error'
  AND session_id IN (SELECT value FROM json_each(?))
  GROUP BY tool, target_file
  HAVING count >= 3
`);

const insertProposal = db.prepare(`
  INSERT OR IGNORE INTO proposals
    (type, status, title, summary, detail, evidence_session_ids, confidence, score_impact, created_at)
  VALUES (?, 'proposed', ?, ?, ?, ?, ?, ?, ?)
`);

// ── Helpers ────────────────────────────────────────────────────────

function parseLLMJson(text: string): unknown {
  const cleaned = text.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "").trim();
  return JSON.parse(cleaned);
}

interface InsightRow {
  id: number;
  session_id: string;
  type: string;
  content: string;
  entities: string | null;
  observation_count: number;
  score: number;
}

interface InsightGroup {
  insights: InsightRow[];
  shared_entities: string[];
}

function groupInsightsByEntities(insights: InsightRow[]): InsightGroup[] {
  // Parse entities for each insight
  const parsed = insights.map(i => ({
    ...i,
    entitySet: new Set<string>(i.entities ? JSON.parse(i.entities) : []),
  }));

  const groups: InsightGroup[] = [];
  const assigned = new Set<number>();

  for (let i = 0; i < parsed.length; i++) {
    if (assigned.has(parsed[i].id)) continue;

    const group: typeof parsed = [parsed[i]];
    assigned.add(parsed[i].id);

    for (let j = i + 1; j < parsed.length; j++) {
      if (assigned.has(parsed[j].id)) continue;

      // Check for 2+ shared entities
      let overlap = 0;
      for (const entity of parsed[i].entitySet) {
        if (parsed[j].entitySet.has(entity)) overlap++;
      }
      if (overlap >= 2) {
        group.push(parsed[j]);
        assigned.add(parsed[j].id);
      }
    }

    // Build shared entities list
    const sharedEntities: string[] = [];
    if (group.length > 1) {
      for (const entity of group[0].entitySet) {
        if (group.every(g => g.entitySet.has(entity))) {
          sharedEntities.push(entity);
        }
      }
    }

    groups.push({
      insights: group.map(({ entitySet, ...rest }) => rest),
      shared_entities: sharedEntities,
    });
  }

  return groups;
}

// ── Main ───────────────────────────────────────────────────────────

export async function runPatternDetection(sessionIds?: string[]): Promise<number> {
  const timeRange = "-30 days";

  // 1. Get high-observation insights
  const insights = sessionIds
    ? (getHighObservationInsightsScoped.all(JSON.stringify(sessionIds)) as InsightRow[])
    : (getHighObservationInsights.all() as InsightRow[]);

  // 2. Group by overlapping entities
  const groups = groupInsightsByEntities(insights);

  // 3. Get recurring error patterns
  const errors = sessionIds
    ? (getRecurringErrorsScoped.all(JSON.stringify(sessionIds)) as Array<{ tool: string; target_file: string | null; count: number }>)
    : (getRecurringErrors.all(timeRange) as Array<{ tool: string; target_file: string | null; count: number }>);

  if (groups.length === 0 && errors.length === 0) return 0;

  // 4. Build context for LLM
  const context = {
    insight_groups: groups.map(g => ({
      shared_entities: g.shared_entities,
      insights: g.insights.map(i => ({
        type: i.type,
        content: i.content,
        observation_count: i.observation_count,
        score: i.score,
      })),
    })),
    recurring_errors: errors.map(e => ({
      tool: e.tool,
      target_file: e.target_file,
      occurrences: e.count,
    })),
  };

  // 5. Call LLM
  let patterns: Array<{
    title: string;
    description: string;
    affected_domains: string[];
    suggested_action: string;
    confidence: number;
  }>;

  try {
    const response = await anthropic.messages.create({
      model: config.metaAnalysisModel,
      max_tokens: config.metaMaxTokens,
      system: PATTERN_SYNTHESIS_PROMPT,
      messages: [{ role: "user", content: JSON.stringify(context) }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "[]";
    patterns = parseLLMJson(text) as typeof patterns;
  } catch (err) {
    console.error("[meta:patterns] LLM call failed:", err);
    return 0;
  }

  if (!Array.isArray(patterns)) return 0;

  // 6. Filter and insert proposals
  const now = new Date().toISOString();
  const evidenceSessionIds = [...new Set(insights.map(i => i.session_id))];
  let count = 0;

  for (const pattern of patterns) {
    if (pattern.confidence < config.metaDefaultConfidenceThreshold) continue;

    try {
      insertProposal.run(
        "pattern",
        pattern.title,
        pattern.description,
        JSON.stringify({
          affected_domains: pattern.affected_domains,
          suggested_action: pattern.suggested_action,
        }),
        JSON.stringify(evidenceSessionIds),
        pattern.confidence,
        null,
        now,
      );
      count++;
    } catch (err) {
      console.error("[meta:patterns] Failed to insert proposal:", err);
    }
  }

  return count;
}
