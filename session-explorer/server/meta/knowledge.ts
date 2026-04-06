import Anthropic from "@anthropic-ai/sdk";
import db from "../db.js";
import { config } from "../config.js";
import { KNOWLEDGE_GAP_PROMPT } from "./prompts.js";

const anthropic = new Anthropic();

// ── Prepared Statements ────────────────────────────────────────────

const getQuestions = db.prepare(`
  SELECT m.content, m.session_id FROM messages m
  WHERE m.role = 'user' AND m.message_type = 'text'
  AND (m.content LIKE '%?%' OR m.content LIKE '%how do%' OR m.content LIKE '%where is%' OR m.content LIKE '%what''s the%')
  AND length(m.content) < 500
  AND m.session_id IN (
    SELECT id FROM sessions WHERE started_at >= datetime('now', ?)
  )
`);

const getQuestionsScoped = db.prepare(`
  SELECT m.content, m.session_id FROM messages m
  WHERE m.role = 'user' AND m.message_type = 'text'
  AND (m.content LIKE '%?%' OR m.content LIKE '%how do%' OR m.content LIKE '%where is%' OR m.content LIKE '%what''s the%')
  AND length(m.content) < 500
  AND m.session_id IN (SELECT value FROM json_each(?))
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

const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "to", "of", "in", "for",
  "on", "with", "at", "by", "from", "it", "its", "this", "that",
  "i", "me", "my", "we", "our", "you", "your", "he", "she", "they",
  "them", "his", "her", "their", "what", "which", "who", "whom",
  "how", "where", "when", "why", "and", "or", "but", "if", "then",
  "so", "not", "no", "just", "also", "about",
]);

function normalizeQuestion(content: string): string {
  return content
    .toLowerCase()
    .trim()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter(w => !STOP_WORDS.has(w) && w.length > 1)
    .sort()
    .join(" ");
}

function wordSet(normalized: string): Set<string> {
  return new Set(normalized.split(/\s+/).filter(Boolean));
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const word of a) {
    if (b.has(word)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

interface QuestionRow {
  content: string;
  session_id: string;
}

interface QuestionCluster {
  representative: string;
  questions: QuestionRow[];
  session_ids: string[];
}

function clusterQuestions(rows: QuestionRow[], threshold = 0.5): QuestionCluster[] {
  const clusters: QuestionCluster[] = [];

  for (const row of rows) {
    const normalized = normalizeQuestion(row.content);
    const words = wordSet(normalized);

    let merged = false;
    for (const cluster of clusters) {
      const repNorm = normalizeQuestion(cluster.representative);
      const repWords = wordSet(repNorm);

      if (jaccardSimilarity(words, repWords) >= threshold) {
        cluster.questions.push(row);
        if (!cluster.session_ids.includes(row.session_id)) {
          cluster.session_ids.push(row.session_id);
        }
        merged = true;
        break;
      }
    }

    if (!merged) {
      clusters.push({
        representative: row.content,
        questions: [row],
        session_ids: [row.session_id],
      });
    }
  }

  return clusters;
}

// ── Main ───────────────────────────────────────────────────────────

export async function runKnowledgeGapDetection(sessionIds?: string[]): Promise<number> {
  const timeRange = "-30 days";

  // 1. Extract questions from user messages
  const questions = sessionIds
    ? (getQuestionsScoped.all(JSON.stringify(sessionIds)) as QuestionRow[])
    : (getQuestions.all(timeRange) as QuestionRow[]);

  if (questions.length === 0) return 0;

  // 2. Cluster similar questions
  const clusters = clusterQuestions(questions);

  // 3. Filter to clusters with 3+ occurrences across different sessions
  const candidates = clusters.filter(c => c.session_ids.length >= 3);

  if (candidates.length === 0) return 0;

  // 4. Build context for LLM
  const context = candidates.map(c => ({
    question_pattern: c.representative,
    times_asked: c.questions.length,
    unique_sessions: c.session_ids.length,
    examples: c.questions.slice(0, 5).map(q => q.content),
  }));

  // 5. Call LLM
  let gaps: Array<{
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
  }>;

  try {
    const response = await anthropic.messages.create({
      model: config.metaAnalysisModel,
      max_tokens: config.metaMaxTokens,
      system: KNOWLEDGE_GAP_PROMPT,
      messages: [{ role: "user", content: JSON.stringify(context) }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "[]";
    gaps = parseLLMJson(text) as typeof gaps;
  } catch (err) {
    console.error("[meta:knowledge] LLM call failed:", err);
    return 0;
  }

  if (!Array.isArray(gaps)) return 0;

  // 6. Filter and insert proposals
  const now = new Date().toISOString();
  let count = 0;

  for (const gap of gaps) {
    if (gap.confidence < config.metaDefaultConfidenceThreshold) continue;

    // Find matching cluster to get session IDs
    const matchingCluster = candidates.find(c =>
      c.representative === gap.question_pattern
      || c.questions.some(q => q.content === gap.question_pattern),
    );
    const evidenceSessionIds = matchingCluster?.session_ids || [];

    try {
      insertProposal.run(
        "knowledge_gap",
        gap.title,
        `Repeated question (${gap.times_asked}x): "${gap.question_pattern}"`,
        JSON.stringify({
          question_pattern: gap.question_pattern,
          proposed_memory: gap.proposed_memory,
          times_asked: gap.times_asked,
        }),
        JSON.stringify(evidenceSessionIds),
        gap.confidence,
        null,
        now,
      );
      count++;
    } catch (err) {
      console.error("[meta:knowledge] Failed to insert proposal:", err);
    }
  }

  return count;
}
