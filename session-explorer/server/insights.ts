import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "crypto";
import { BackgroundJob } from "./background-job.js";
import db from "./db.js";
import { config } from "./config.js";

const anthropic = new Anthropic();

// ── Prepared Statements ────────────────────────────────────────────

const getMessages = db.prepare(`
  SELECT role, content, timestamp, sequence, message_type
  FROM messages
  WHERE session_id = ?
  ORDER BY sequence ASC
`);

const getSessionFiles = db.prepare(`
  SELECT DISTINCT file_path
  FROM session_files WHERE session_id = ?
  AND file_path NOT LIKE '%.png'
  AND file_path NOT LIKE '%.jpg'
  AND file_path NOT LIKE '%.jpeg'
  AND file_path NOT LIKE '%.gif'
  AND file_path NOT LIKE '%.webp'
  AND file_path NOT LIKE '%.svg'
`);

const getUnextractedSessions = db.prepare(`
  SELECT s.id, s.title FROM sessions s
  WHERE s.workspace_id = ? AND s.insights_extracted = 0 AND s.message_count > 5
`);

const getAllUnextractedSessions = db.prepare(`
  SELECT s.id, s.title FROM sessions s
  WHERE s.insights_extracted = 0 AND s.message_count > 5
`);

const markSessionExtracted = db.prepare(`
  UPDATE sessions SET insights_extracted = 1 WHERE id = ?
`);

const clearWorkspaceExtracted = db.prepare(`
  UPDATE sessions SET insights_extracted = 0 WHERE workspace_id = ?
`);

const clearAllExtracted = db.prepare(`
  UPDATE sessions SET insights_extracted = 0
`);

const findByCanonicalHash = db.prepare(`
  SELECT id, observation_count, score FROM insights
  WHERE canonical_hash = ? AND deleted_at IS NULL
  LIMIT 1
`);

const insertInsight = db.prepare(`
  INSERT INTO insights (session_id, type, content, canonical_form, canonical_hash, context, entities, source, observation_count, score, extracted_at, last_observed_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
`);

const updateObservation = db.prepare(`
  UPDATE insights SET observation_count = observation_count + 1, last_observed_at = ? WHERE id = ?
`);

const insertInsightFile = db.prepare(`
  INSERT OR IGNORE INTO insight_files (insight_id, file_path) VALUES (?, ?)
`);

const insertInsightSession = db.prepare(`
  INSERT OR IGNORE INTO insight_sessions (insight_id, session_id, extracted_at) VALUES (?, ?, ?)
`);

const getInsightById = db.prepare(`
  SELECT * FROM insights WHERE id = ? AND deleted_at IS NULL
`);

const updateInsightScore = db.prepare(`
  UPDATE insights SET score = ? WHERE id = ?
`);

const incrementUpvotes = db.prepare(`
  UPDATE insights SET upvotes = upvotes + 1 WHERE id = ?
`);

const incrementDownvotes = db.prepare(`
  UPDATE insights SET downvotes = downvotes + 1 WHERE id = ?
`);

const softDeleteInsight = db.prepare(`
  UPDATE insights SET deleted_at = ? WHERE id = ?
`);

const getSessionSourceBreakdown = db.prepare(`
  SELECT source, COUNT(*) as count FROM messages
  WHERE session_id = ? GROUP BY source
`);

const getSetting = db.prepare(`
  SELECT value FROM settings WHERE key = ?
`);

const upsertSetting = db.prepare(`
  INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
`);

// ── XML Noise Cleanup ──────────────────────────────────────────────

function cleanXmlNoise(text: string): string {
  return text
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, "")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<(?:output-file|tool-use-id|task-id|status|summary|result|available-deferred-tools)>[\s\S]*?<\/(?:output-file|tool-use-id|task-id|status|summary|result|available-deferred-tools)>/g, "")
    .replace(/<\/?(?:task-notification|system-reminder|output-file|tool-use-id|task-id|status|summary|result|available-deferred-tools)[^>]*>/g, "")
    .trim();
}

// ── Hashing ────────────────────────────────────────────────────────

function hashCanonical(canonical: string): string {
  return createHash("sha256").update(canonical.toLowerCase().trim()).digest("hex");
}

// ── Type Weights ───────────────────────────────────────────────────

const TYPE_WEIGHTS: Record<string, number> = {
  correction: 1.5,
  decision: 1.3,
  gotcha: 1.2,
  pattern: 1.0,
  discovery: 0.8,
  preference: 0.8,
};

// ── Score Calculation ──────────────────────────────────────────────

function calculateScore(insight: {
  observation_count: number;
  type: string;
  upvotes: number;
  downvotes: number;
  last_observed_at: string;
}): number {
  const typeWeight = TYPE_WEIGHTS[insight.type] ?? 1.0;
  const baseScore = insight.observation_count * typeWeight;
  const feedbackMultiplier = Math.max(0.1, Math.min(5.0, 1.0 + 0.2 * (insight.upvotes - insight.downvotes)));
  const daysSinceObserved = (Date.now() - new Date(insight.last_observed_at).getTime()) / (1000 * 60 * 60 * 24);
  const recencyFactor = 1.0 / (1.0 + daysSinceObserved * 0.01);
  return baseScore * feedbackMultiplier * recencyFactor;
}

const extractionJob = new BackgroundJob(config.insightConcurrency);

// ── Extraction Prompt ──────────────────────────────────────────────

const EXTRACTION_SYSTEM_PROMPT = `You are an insight extractor for coding session transcripts. Your job is to identify genuinely useful learnings from the conversation between a human and an AI coding assistant.

Extract ONLY insights that would be valuable if encountered again in a future session. Skip trivial observations, routine code changes, and anything that's obvious from the code itself.

## Insight Types

- **correction**: The human redirected the AI's approach — even subtly. This includes: "no, don't do X", "use Y instead", pushing back on a suggestion, overriding a default, asking to undo/revert, or expressing dissatisfaction with output. Even politely phrased redirections count ("actually, let's...", "I'd prefer...", "that's not what I meant"). These are the most valuable type — they reveal gaps in the AI's defaults. When in doubt between correction and preference, choose correction if the human was responding to something the AI did wrong.
- **decision**: An explicit architectural or design decision was made with clear reasoning. Not just "we used X" but "we chose X over Y because Z." The reasoning must be present in the conversation.
- **gotcha**: A non-obvious pitfall, edge case, or compatibility issue that was discovered the hard way. Something that would bite you again if you forgot it. Failed attempts that led to a workaround count.
- **pattern**: A workflow or convention that the human wants followed in future sessions — something you'd do again. NOT a description of how existing code is structured. "Always run X before Y" is a pattern. "The codebase uses a registry pattern in registry.ts" is NOT a pattern (that's just reading the code).
- **discovery**: Something genuinely surprising was learned — an undocumented API behavior, a library quirk, a system characteristic that contradicts expectations. NOT obvious architecture descriptions you could derive from reading the code.
- **preference**: A stated user preference for tools, style, naming, workflow, or approach. "Use bun not npm", "I like terse commit messages", "always use Sonnet for this". Only extract if explicitly stated, not inferred.

## Rules

1. Each insight must be self-contained and useful without the full session context.
2. Be specific — include file names, function names, config keys, error messages when relevant.
3. The canonical_form should be a terse, normalized statement suitable for deduplication (e.g., "bun not npm in this repo").
4. Only extract 0-8 insights per session. Quality over quantity. Many sessions will have 0-2 insights.
5. If the session has no extractable insights, return an empty array.
6. The entities field should list specific technical entities mentioned (library names, API endpoints, config keys, etc.).
7. The relevant_files field should list file paths that are directly related to the insight.
8. Prioritize corrections and preferences — these are the highest-signal types. Look for any moment where the human pushed back, redirected, or stated how they want things done.
9. Do NOT extract architecture descriptions. "The app uses React Router" is not an insight. "React Router's Link component requires data-status not className for active state styling" IS an insight (gotcha).

## Output Format

Return a JSON array (no markdown fences, no explanation, just the array):

[
  {
    "type": "correction",
    "content": "Full description of the insight with enough context to be useful standalone.",
    "canonical_form": "terse normalized statement for dedup",
    "entities": ["entity1", "entity2"],
    "relevant_files": ["/path/to/file.ts"]
  }
]`;

// ── Core Extraction ────────────────────────────────────────────────

async function extractFromSession(sessionId: string): Promise<void> {
  const rawMessages = getMessages.all(sessionId) as Array<{
    role: string;
    content: string;
    timestamp: string;
    sequence: number;
    message_type: string;
  }>;

  const sourceBreakdown = getSessionSourceBreakdown.all(sessionId) as Array<{ source: string; count: number }>;
  const subagentCount = sourceBreakdown.find(s => s.source === 'subagent')?.count || 0;
  const parentCount = sourceBreakdown.find(s => s.source === 'parent')?.count || 0;
  const sessionSource = subagentCount > parentCount ? 'subagent' : 'parent';

  // Build transcript with smart truncation for long sessions:
  // 1. Strip tool_use/tool_result messages (low insight density, high token cost)
  // 2. For long sessions, sample beginning + middle + end sections
  const conversational = rawMessages.filter(
    (m) => m.message_type === "text" || m.message_type === "system"
  );

  const formatted = conversational
    .map((m) => {
      const cleaned = cleanXmlNoise(m.content);
      if (!cleaned) return null;
      return `[${m.role}]: ${cleaned}`;
    })
    .filter(Boolean) as string[];

  if (formatted.length === 0) {
    markSessionExtracted.run(sessionId);
    return;
  }

  const fullTranscript = formatted.join("\n\n");
  let truncated: string;

  if (fullTranscript.length <= config.insightTranscriptMaxChars) {
    truncated = fullTranscript;
  } else {
    // Sample three sections: beginning (40%), middle (30%), end (30%)
    // This ensures we see the problem setup AND the corrections/decisions later
    const budget = config.insightTranscriptMaxChars;
    const beginBudget = Math.floor(budget * 0.4);
    const midBudget = Math.floor(budget * 0.3);
    const endBudget = budget - beginBudget - midBudget;

    const begin = fullTranscript.slice(0, beginBudget);
    const midPoint = Math.floor(fullTranscript.length / 2);
    const mid = fullTranscript.slice(midPoint - Math.floor(midBudget / 2), midPoint + Math.floor(midBudget / 2));
    const end = fullTranscript.slice(-endBudget);

    truncated = `${begin}\n\n[... middle of session ...]\n\n${mid}\n\n[... later in session ...]\n\n${end}`;
  }

  const files = (getSessionFiles.all(sessionId) as Array<{ file_path: string }>)
    .map((f) => f.file_path);

  const filesSection = files.length > 0
    ? `\n\nFiles touched in this session:\n${files.join("\n")}`
    : "";

  const response = await anthropic.messages.create({
    model: config.insightModel,
    max_tokens: config.insightMaxTokens,
    system: EXTRACTION_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Extract insights from this coding session transcript.${filesSection}\n\n---\n\n${truncated}`,
      },
    ],
  });

  const text = response.content[0].type === "text" ? response.content[0].text : "";

  // Parse JSON response — handle possible markdown fences
  let insights: Array<{
    type: string;
    content: string;
    canonical_form: string;
    entities?: string[];
    relevant_files?: string[];
  }>;

  try {
    const jsonStr = text.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "").trim();
    insights = JSON.parse(jsonStr);
  } catch {
    // If parsing fails, mark as extracted and move on
    markSessionExtracted.run(sessionId);
    return;
  }

  if (!Array.isArray(insights)) {
    markSessionExtracted.run(sessionId);
    return;
  }

  const now = new Date().toISOString();

  const insertTransaction = db.transaction(() => {
    for (const insight of insights) {
      if (!insight.type || !insight.content) continue;

      const canonicalHash = insight.canonical_form
        ? hashCanonical(insight.canonical_form)
        : null;

      // Check for existing insight with same canonical hash
      if (canonicalHash) {
        const existing = findByCanonicalHash.get(canonicalHash) as {
          id: number;
          observation_count: number;
          score: number;
        } | undefined;

        if (existing) {
          // Increment observation count, update last_observed_at
          updateObservation.run(now, existing.id);
          // Add to junction table
          insertInsightSession.run(existing.id, sessionId, now);
          // Add any new file associations
          if (insight.relevant_files) {
            for (const filePath of insight.relevant_files) {
              insertInsightFile.run(existing.id, filePath);
            }
          }
          // Recalculate score
          const updated = getInsightById.get(existing.id) as Record<string, unknown> | undefined;
          if (updated) {
            const newScore = calculateScore({
              observation_count: updated.observation_count as number,
              type: updated.type as string,
              upvotes: updated.upvotes as number,
              downvotes: updated.downvotes as number,
              last_observed_at: updated.last_observed_at as string,
            });
            updateInsightScore.run(newScore, existing.id);
          }
          continue;
        }
      }

      // Insert new insight
      const typeWeight = TYPE_WEIGHTS[insight.type] ?? 1.0;
      const initialScore = 1.0 * typeWeight; // observation_count=1 * typeWeight * feedback=1 * recency~=1

      const result = insertInsight.run(
        sessionId,
        insight.type,
        insight.content,
        insight.canonical_form || null,
        canonicalHash,
        null, // context
        insight.entities ? JSON.stringify(insight.entities) : null,
        sessionSource, // source
        initialScore,
        now,
        now
      );

      const insightId = Number(result.lastInsertRowid);

      // Add to junction table
      insertInsightSession.run(insightId, sessionId, now);

      // Add file associations
      if (insight.relevant_files) {
        for (const filePath of insight.relevant_files) {
          insertInsightFile.run(insightId, filePath);
        }
      }
    }

    markSessionExtracted.run(sessionId);
  });

  insertTransaction();
}

// ── Exported Functions ─────────────────────────────────────────────

export function startExtraction(workspaceId: number, force?: boolean): {
  total: number;
  message?: string;
} {
  if (extractionJob.isRunning) {
    return { total: 0, message: "An extraction job is already running" };
  }

  // If force, clear extraction flags for the workspace
  if (force) {
    if (workspaceId > 0) {
      clearWorkspaceExtracted.run(workspaceId);
    } else {
      clearAllExtracted.run();
    }
  }

  const sessions = workspaceId > 0
    ? (getUnextractedSessions.all(workspaceId) as Array<{ id: string; title: string }>)
    : (getAllUnextractedSessions.all() as Array<{ id: string; title: string }>);

  if (sessions.length === 0) {
    return { total: 0, message: "All sessions already have insights extracted" };
  }

  return extractionJob.start(
    sessions,
    (s) => s.id,
    async (s) => extractFromSession(s.id),
    () => upsertSetting.run("extraction_last_run", new Date().toISOString())
  );
}

export function getExtractionStatus() {
  return extractionJob.getStatus();
}

export function cancelExtraction(): void {
  extractionJob.cancel();
}

export function recalculateScore(insightId: number): number | null {
  const insight = getInsightById.get(insightId) as Record<string, unknown> | undefined;
  if (!insight) return null;

  const newScore = calculateScore({
    observation_count: insight.observation_count as number,
    type: insight.type as string,
    upvotes: insight.upvotes as number,
    downvotes: insight.downvotes as number,
    last_observed_at: insight.last_observed_at as string,
  });

  updateInsightScore.run(newScore, insightId);
  return newScore;
}

export function upvoteInsight(insightId: number): { score: number } | null {
  const insight = getInsightById.get(insightId) as Record<string, unknown> | undefined;
  if (!insight) return null;

  incrementUpvotes.run(insightId);
  const newScore = recalculateScore(insightId);
  return { score: newScore! };
}

export function downvoteInsight(insightId: number): { score: number } | null {
  const insight = getInsightById.get(insightId) as Record<string, unknown> | undefined;
  if (!insight) return null;

  incrementDownvotes.run(insightId);
  const newScore = recalculateScore(insightId);
  return { score: newScore! };
}

export function deleteInsight(insightId: number): boolean {
  const insight = getInsightById.get(insightId) as Record<string, unknown> | undefined;
  if (!insight) return false;

  softDeleteInsight.run(new Date().toISOString(), insightId);
  return true;
}

export function getExtractionSettings(): { interval_days: number; last_run: string | null } {
  const interval = getSetting.get("extraction_interval_days") as { value: string } | undefined;
  const lastRun = getSetting.get("extraction_last_run") as { value: string } | undefined;
  return {
    interval_days: interval ? Number(interval.value) : 7,
    last_run: lastRun?.value ?? null,
  };
}

export function setExtractionInterval(days: number): void {
  upsertSetting.run("extraction_interval_days", String(days));
}
