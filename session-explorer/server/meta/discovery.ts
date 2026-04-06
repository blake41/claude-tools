import Anthropic from "@anthropic-ai/sdk";
import db from "../db.js";
import { config } from "../config.js";
import { SKILL_DISCOVERY_PROMPT } from "./prompts.js";

const anthropic = new Anthropic();

// ── Prepared Statements ────────────────────────────────────────────

const getSessionsWithCorrectionsNoSkills = db.prepare(`
  SELECT DISTINCT se.session_id
  FROM session_events se
  WHERE se.type = 'user_correction'
  AND se.session_id NOT IN (
    SELECT DISTINCT session_id FROM session_events WHERE type = 'skill_invocation'
  )
  AND se.session_id IN (
    SELECT id FROM sessions WHERE started_at >= datetime('now', ?)
  )
`);

const getSessionsWithCorrectionsNoSkillsScoped = db.prepare(`
  SELECT DISTINCT se.session_id
  FROM session_events se
  WHERE se.type = 'user_correction'
  AND se.session_id NOT IN (
    SELECT DISTINCT session_id FROM session_events WHERE type = 'skill_invocation'
  )
  AND se.session_id IN (SELECT value FROM json_each(?))
`);

const getToolSequences = db.prepare(`
  SELECT se.session_id, GROUP_CONCAT(se.tool, '->') as tool_sequence
  FROM session_events se
  WHERE se.type = 'tool_call' AND se.session_id IN (
    SELECT id FROM sessions WHERE started_at >= datetime('now', ?)
  )
  GROUP BY se.session_id
`);

const getToolSequencesScoped = db.prepare(`
  SELECT se.session_id, GROUP_CONCAT(se.tool, '->') as tool_sequence
  FROM session_events se
  WHERE se.type = 'tool_call' AND se.session_id IN (SELECT value FROM json_each(?))
  GROUP BY se.session_id
`);

const getUserCorrections = db.prepare(`
  SELECT session_id, metadata FROM session_events
  WHERE type = 'user_correction' AND session_id IN (SELECT value FROM json_each(?))
  ORDER BY session_id, sequence
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

function findRepeatedSequences(
  sequences: Array<{ session_id: string; tool_sequence: string }>,
  minOccurrences = 3,
): Map<string, string[]> {
  // Extract 3-tool subsequences and count occurrences
  const subseqMap = new Map<string, string[]>();

  for (const { session_id, tool_sequence } of sequences) {
    const tools = tool_sequence.split("->");
    for (let i = 0; i <= tools.length - 3; i++) {
      const subseq = tools.slice(i, i + 3).join("->");
      if (!subseqMap.has(subseq)) subseqMap.set(subseq, []);
      const sessions = subseqMap.get(subseq)!;
      if (!sessions.includes(session_id)) sessions.push(session_id);
    }
  }

  // Filter to subsequences appearing in 3+ sessions
  const repeated = new Map<string, string[]>();
  for (const [subseq, sessions] of subseqMap) {
    if (sessions.length >= minOccurrences) {
      repeated.set(subseq, sessions);
    }
  }
  return repeated;
}

// ── Main ───────────────────────────────────────────────────────────

export async function runSkillDiscovery(sessionIds?: string[]): Promise<number> {
  const timeRange = "-30 days";

  // 1. Sessions with corrections but no skill invocations
  const correctionSessions = sessionIds
    ? (getSessionsWithCorrectionsNoSkillsScoped.all(JSON.stringify(sessionIds)) as Array<{ session_id: string }>)
    : (getSessionsWithCorrectionsNoSkills.all(timeRange) as Array<{ session_id: string }>);

  const correctionSessionIds = correctionSessions.map(s => s.session_id);

  // 2. Repeated tool sequences
  const sequences = sessionIds
    ? (getToolSequencesScoped.all(JSON.stringify(sessionIds)) as Array<{ session_id: string; tool_sequence: string }>)
    : (getToolSequences.all(timeRange) as Array<{ session_id: string; tool_sequence: string }>);

  const repeatedSequences = findRepeatedSequences(sequences);

  // 3. Get user corrections for context
  const allRelevantIds = [
    ...new Set([
      ...correctionSessionIds,
      ...Array.from(repeatedSequences.values()).flat(),
    ]),
  ];

  if (allRelevantIds.length === 0) return 0;

  const corrections = getUserCorrections.all(JSON.stringify(allRelevantIds)) as Array<{
    session_id: string;
    metadata: string | null;
  }>;

  const correctionsBySession = new Map<string, string[]>();
  for (const c of corrections) {
    if (!correctionsBySession.has(c.session_id)) correctionsBySession.set(c.session_id, []);
    const meta = c.metadata ? JSON.parse(c.metadata) : {};
    correctionsBySession.get(c.session_id)!.push(meta.preview || "");
  }

  // 4. Build context for LLM
  const clusters = {
    sessions_with_corrections: correctionSessionIds.map(id => ({
      session_id: id,
      corrections: correctionsBySession.get(id) || [],
    })),
    repeated_tool_sequences: Array.from(repeatedSequences.entries()).map(([seq, sessions]) => ({
      sequence: seq,
      session_count: sessions.length,
      session_ids: sessions,
    })),
  };

  // 5. Call LLM
  let suggestions: Array<{
    skill_name: string;
    description: string;
    triggers: string[];
    draft_instructions: string;
    evidence_summary: string;
    confidence: number;
  }>;

  try {
    const response = await anthropic.messages.create({
      model: config.metaAnalysisModel,
      max_tokens: config.metaMaxTokens,
      system: SKILL_DISCOVERY_PROMPT,
      messages: [{ role: "user", content: JSON.stringify(clusters) }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "[]";
    suggestions = parseLLMJson(text) as typeof suggestions;
  } catch (err) {
    console.error("[meta:discovery] LLM call failed:", err);
    return 0;
  }

  if (!Array.isArray(suggestions)) return 0;

  // 6. Filter and insert proposals
  const now = new Date().toISOString();
  let count = 0;

  for (const suggestion of suggestions) {
    if (suggestion.confidence < config.metaDefaultConfidenceThreshold) continue;

    try {
      insertProposal.run(
        "new_skill",
        suggestion.skill_name,
        suggestion.description,
        JSON.stringify({
          triggers: suggestion.triggers,
          draft_instructions: suggestion.draft_instructions,
          evidence_summary: suggestion.evidence_summary,
        }),
        JSON.stringify(allRelevantIds),
        suggestion.confidence,
        null,
        now,
      );
      count++;
    } catch (err) {
      console.error("[meta:discovery] Failed to insert proposal:", err);
    }
  }

  return count;
}
