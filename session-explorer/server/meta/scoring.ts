import Anthropic from "@anthropic-ai/sdk";
import db from "../db.js";
import { config } from "../config.js";
import { extractEvents, getSessionEvents, getSessionEventStats } from "./events.js";
import { CONTEXT_DISCIPLINE_PROMPT, ARCHITECTURAL_ALIGNMENT_PROMPT } from "./prompts.js";
import type { SessionScore } from "./types.js";

const anthropic = new Anthropic();

// ── Prepared Statements ────────────────────────────────────────────

const getScore = db.prepare(`
  SELECT * FROM session_scores WHERE session_id = ?
`);

const insertScore = db.prepare(`
  INSERT OR REPLACE INTO session_scores
    (session_id, tool_efficiency, fix_convergence, context_discipline,
     verification_rigor, architectural_alignment, composite_score, raw_event_count, scored_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const getSessionFiles = db.prepare(`
  SELECT DISTINCT file_path FROM session_files
  WHERE session_id = ?
  AND file_path NOT LIKE '%.png' AND file_path NOT LIKE '%.jpg'
  AND file_path NOT LIKE '%.jpeg' AND file_path NOT LIKE '%.gif'
`);

const getSessionInfo = db.prepare(`
  SELECT id, message_count, user_message_count FROM sessions WHERE id = ?
`);

const getUnscoredSessions = db.prepare(`
  SELECT s.id FROM sessions s
  LEFT JOIN session_scores sc ON s.id = sc.session_id
  WHERE sc.id IS NULL AND s.message_count > 5 AND s.events_extracted = 1
`);

const listScores = db.prepare(`
  SELECT sc.*, s.title, s.started_at, s.git_branch
  FROM session_scores sc
  JOIN sessions s ON sc.session_id = s.id
  ORDER BY sc.scored_at DESC
  LIMIT ? OFFSET ?
`);

const scoreTrends = db.prepare(`
  SELECT
    date(s.started_at) as date,
    AVG(sc.composite_score) as avg_composite,
    AVG(sc.tool_efficiency) as avg_tool_efficiency,
    AVG(sc.fix_convergence) as avg_fix_convergence,
    AVG(sc.context_discipline) as avg_context_discipline,
    AVG(sc.verification_rigor) as avg_verification_rigor,
    AVG(sc.architectural_alignment) as avg_architectural_alignment,
    COUNT(*) as session_count
  FROM session_scores sc
  JOIN sessions s ON sc.session_id = s.id
  WHERE s.started_at >= ?
  GROUP BY date(s.started_at)
  ORDER BY date ASC
`);

// ── Phase 1: Programmatic Scoring ──────────────────────────────────

interface EventRow {
  type: string;
  tool: string | null;
  target_file: string | null;
  success: number;
  metadata: string | null;
  sequence: number;
}

function scoreToolEfficiency(events: EventRow[]): number {
  const toolCalls = events.filter(e => e.type === 'tool_call' || e.type === 'retry' || e.type === 'error');
  if (toolCalls.length === 0) return 5;

  let penalty = 0;

  // Penalize redundant reads (same file read 2+ times without edit between)
  const readFiles = new Map<string, number>(); // file -> count since last edit
  for (const e of toolCalls) {
    if (e.tool === 'Read' && e.target_file) {
      const count = (readFiles.get(e.target_file) || 0) + 1;
      readFiles.set(e.target_file, count);
      if (count > 1) penalty += 0.3;
    } else if ((e.tool === 'Edit' || e.tool === 'Write') && e.target_file) {
      readFiles.delete(e.target_file);
    }
  }

  // Penalize bash used for tasks with dedicated tools
  const bashCalls = toolCalls.filter(e => e.tool === 'Bash');
  for (const bash of bashCalls) {
    const meta = bash.metadata ? JSON.parse(bash.metadata) : {};
    const cmd = (meta.command || '').toLowerCase();
    if (/\b(grep|rg)\b/.test(cmd)) penalty += 0.5;
    if (/\b(cat|head|tail)\b/.test(cmd)) penalty += 0.5;
    if (/\b(find)\b/.test(cmd)) penalty += 0.3;
  }

  // Penalize grep→read→grep cycles on same pattern
  const grepPatterns = new Set<string>();
  let lastWasGrep = false;
  for (const e of toolCalls) {
    if (e.tool === 'Grep' || e.tool === 'Glob') {
      if (lastWasGrep) penalty += 0.2;
      lastWasGrep = true;
    } else {
      lastWasGrep = false;
    }
  }

  return Math.max(1, Math.min(5, 5 - penalty));
}

function scoreFixConvergence(events: EventRow[]): number {
  const errorsByTarget = new Map<string, number>();
  const retries = events.filter(e => e.type === 'retry' || e.type === 'error');

  if (retries.length === 0) return 5;

  for (const e of retries) {
    const key = e.target_file || e.tool || 'unknown';
    errorsByTarget.set(key, (errorsByTarget.get(key) || 0) + 1);
  }

  // Average retries per target
  const values = Array.from(errorsByTarget.values());
  const avgRetries = values.reduce((a, b) => a + b, 0) / values.length;

  // Score: 5 = 0 retries, 4 = 1, 3 = 2, 2 = 3, 1 = 4+
  return Math.max(1, Math.min(5, 5 - avgRetries));
}

function scoreVerificationRigor(events: EventRow[]): number {
  const toolCalls = events.filter(e => e.type === 'tool_call');
  if (toolCalls.length === 0) return 3; // insufficient data

  // Find last edit/write
  let lastEditIdx = -1;
  for (let i = toolCalls.length - 1; i >= 0; i--) {
    if (toolCalls[i].tool === 'Edit' || toolCalls[i].tool === 'Write') {
      lastEditIdx = i;
      break;
    }
  }

  if (lastEditIdx === -1) return 4; // no edits, likely a research session

  // Check if tsc/test/lint commands appear after last edit
  const afterEdit = toolCalls.slice(lastEditIdx + 1);
  const hasVerification = afterEdit.some(e => {
    if (e.tool !== 'Bash') return false;
    const meta = e.metadata ? JSON.parse(e.metadata) : {};
    const cmd = (meta.command || '').toLowerCase();
    return /\b(tsc|jest|vitest|mocha|pytest|test|lint|eslint|check)\b/.test(cmd);
  });

  return hasVerification ? 5 : 1;
}

// ── Phase 2: LLM Scoring ────────────────────────────────────────────

async function scoreLLM(
  prompt: string,
  context: string,
): Promise<{ score: number; reason: string }> {
  try {
    const response = await anthropic.messages.create({
      model: config.metaScoringModel,
      max_tokens: 256,
      system: prompt,
      messages: [{ role: "user", content: context }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "";
    const parsed = JSON.parse(text.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "").trim());
    return {
      score: Math.max(1, Math.min(5, Number(parsed.score) || 3)),
      reason: parsed.reason || "",
    };
  } catch {
    return { score: 3, reason: "LLM scoring failed, defaulting to 3" };
  }
}

function computeComposite(scores: Omit<SessionScore, 'session_id' | 'composite_score' | 'raw_event_count' | 'scored_at'>): number {
  // Weighted: verification 2x, convergence 2x, others 1x
  const weighted =
    scores.tool_efficiency +
    scores.fix_convergence * 2 +
    scores.context_discipline +
    scores.verification_rigor * 2 +
    scores.architectural_alignment;
  return Math.round((weighted / 7) * 100) / 100;
}

// ── Public API ──────────────────────────────────────────────────────

export async function scoreSession(sessionId: string, force = false): Promise<SessionScore | null> {
  // Check if already scored
  if (!force) {
    const existing = getScore.get(sessionId) as SessionScore | undefined;
    if (existing) return existing;
  }

  // Ensure events are extracted
  extractEvents(sessionId);

  const session = getSessionInfo.get(sessionId) as { id: string; message_count: number; user_message_count: number } | undefined;
  if (!session || session.message_count <= 5) return null;

  const events = getSessionEvents(sessionId) as EventRow[];
  if (events.length === 0) return null;

  const stats = getSessionEventStats(sessionId);

  // Phase 1: Programmatic scoring
  const tool_efficiency = scoreToolEfficiency(events);
  const fix_convergence = scoreFixConvergence(events);
  const verification_rigor = scoreVerificationRigor(events);

  // Phase 2: LLM scoring
  const files = (getSessionFiles.all(sessionId) as Array<{ file_path: string }>).map(f => f.file_path);
  const eventSummary = stats.map(s => `${s.type}: ${s.count}`).join(', ');
  const subagentCount = events.filter(e => e.type === 'subagent_spawn').length;
  const mainToolCount = events.filter(e => e.type === 'tool_call').length;

  const contextResult = await scoreLLM(
    CONTEXT_DISCIPLINE_PROMPT,
    `Session stats:\n- Total tool calls in main thread: ${mainToolCount}\n- Subagent spawns: ${subagentCount}\n- Event breakdown: ${eventSummary}\n- Total messages: ${session.message_count}\n- Files touched: ${files.length}`,
  );

  const archResult = await scoreLLM(
    ARCHITECTURAL_ALIGNMENT_PROMPT,
    `Files edited: ${files.slice(0, 20).join(', ')}\nEvent summary: ${eventSummary}\nTotal events: ${events.length}`,
  );

  const scores = {
    tool_efficiency,
    fix_convergence,
    context_discipline: contextResult.score,
    verification_rigor,
    architectural_alignment: archResult.score,
  };

  const composite = computeComposite(scores);
  const now = new Date().toISOString();

  insertScore.run(
    sessionId,
    scores.tool_efficiency,
    scores.fix_convergence,
    scores.context_discipline,
    scores.verification_rigor,
    scores.architectural_alignment,
    composite,
    events.length,
    now,
  );

  return {
    session_id: sessionId,
    ...scores,
    composite_score: composite,
    raw_event_count: events.length,
    scored_at: now,
  };
}

export function getSessionScore(sessionId: string): SessionScore | null {
  return (getScore.get(sessionId) as SessionScore) ?? null;
}

export function getUnscoredSessionIds(): string[] {
  return (getUnscoredSessions.all() as Array<{ id: string }>).map(s => s.id);
}

export function listSessionScores(limit = 50, offset = 0) {
  return listScores.all(limit, offset);
}

export function getScoreTrends(sinceDays = 30) {
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return scoreTrends.all(since);
}
