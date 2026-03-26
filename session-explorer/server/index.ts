import express from "express";
import cors from "cors";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import Anthropic from "@anthropic-ai/sdk";
import PQueue from "p-queue";
import db from "./db.js";
import { config } from "./config.js";
import chatRouter, { SYSTEM_PROMPT, tools, executeSql, parseResult } from "./chat.js";

function cleanXmlNoise(text: string): string {
  return text
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, "")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<(?:output-file|tool-use-id|task-id|status|summary|result|available-deferred-tools)>[\s\S]*?<\/(?:output-file|tool-use-id|task-id|status|summary|result|available-deferred-tools)>/g, "")
    .replace(/<\/?(?:task-notification|system-reminder|output-file|tool-use-id|task-id|status|summary|result|available-deferred-tools)[^>]*>/g, "")
    .trim();
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = config.port;

app.use(cors());
app.use(express.json());
app.use(chatRouter);

// Serve static frontend in production
app.use(express.static(join(__dirname, "..", "dist", "web")));

// ── Tag Prepared Statements ───────────────────────────────────────

const listTags = db.prepare(`
  SELECT t.*, COUNT(st.session_id) as session_count
  FROM tags t LEFT JOIN session_tags st ON t.id = st.tag_id
  GROUP BY t.id ORDER BY t.name
`);

const createTag = db.prepare(`
  INSERT INTO tags (name, color, description, created_at) VALUES (?, ?, ?, ?)
`);

const deleteTag = db.prepare(`DELETE FROM tags WHERE id = ?`);
const deleteTagSessions = db.prepare(`DELETE FROM session_tags WHERE tag_id = ?`);

const addSessionTag = db.prepare(`
  INSERT OR IGNORE INTO session_tags (session_id, tag_id, added_at) VALUES (?, ?, ?)
`);

const removeSessionTag = db.prepare(`
  DELETE FROM session_tags WHERE session_id = ? AND tag_id = ?
`);

const getTagById = db.prepare(`SELECT * FROM tags WHERE id = ?`);
const getTagByName = db.prepare(`SELECT * FROM tags WHERE name = ?`);

const updateTag = db.prepare(`
  UPDATE tags SET name = COALESCE(?, name), color = COALESCE(?, color) WHERE id = ?
`);

const insertAuditLog = db.prepare(
  `INSERT INTO audit_log (action, entity_type, entity_id, details, created_at) VALUES (?, ?, ?, ?, datetime('now'))`
);

const getTagsForSession = db.prepare(`
  SELECT t.* FROM tags t JOIN session_tags st ON t.id = st.tag_id WHERE st.session_id = ?
`);

const getSessionsForTag = db.prepare(`
  SELECT s.id, s.workspace_id, s.started_at, s.ended_at, s.git_branch, s.title,
         s.message_count, s.user_message_count, s.summary,
         w.display_name as workspace_name, w.path as workspace_path
  FROM sessions s
  JOIN session_tags st ON s.id = st.session_id
  JOIN workspaces w ON s.workspace_id = w.id
  WHERE st.tag_id = ?
  ORDER BY s.started_at DESC
`);

// ── Prepared Statements ────────────────────────────────────────────

const listWorkspaces = db.prepare(`
  SELECT id, path, dir_name, display_name, session_count, last_activity
  FROM workspaces
  ORDER BY last_activity DESC
`);

const listSessions = db.prepare(`
  SELECT id, started_at, ended_at, git_branch, title, message_count, user_message_count, summary
  FROM sessions
  WHERE workspace_id = ?
  ORDER BY started_at DESC
  LIMIT ? OFFSET ?
`);

const countSessions = db.prepare(`
  SELECT COUNT(*) as total FROM sessions WHERE workspace_id = ?
`);

const listAllSessions = db.prepare(`
  SELECT id, workspace_id, started_at, ended_at, git_branch, title, message_count, user_message_count, summary
  FROM sessions
  ORDER BY started_at DESC
  LIMIT ? OFFSET ?
`);

const countAllSessions = db.prepare(`
  SELECT COUNT(*) as total FROM sessions
`);

const getSession = db.prepare(`
  SELECT s.*, w.display_name as workspace_name, w.path as workspace_path
  FROM sessions s
  JOIN workspaces w ON s.workspace_id = w.id
  WHERE s.id = ?
`);

const getMessages = db.prepare(`
  SELECT role, content, timestamp, sequence, message_type
  FROM messages
  WHERE session_id = ?
  ORDER BY sequence ASC
`);

// Fetch the matched message's content for a readable preview
const getMessageContent = db.prepare(`
  SELECT content FROM messages
  WHERE session_id = ? AND sequence = ?
`);

// Fetch the adjacent message from the opposite role for context around a match
const getAdjacentContext = db.prepare(`
  SELECT role, content, sequence FROM messages
  WHERE session_id = ? AND sequence < ? AND role != ?
  ORDER BY sequence DESC LIMIT 1
`);

const getFollowingContext = db.prepare(`
  SELECT role, content, sequence FROM messages
  WHERE session_id = ? AND sequence > ? AND role != ?
  ORDER BY sequence ASC LIMIT 1
`);

const searchMessagesFts = db.prepare(`
  SELECT m.session_id, m.role, m.message_type, m.timestamp, m.sequence,
         snippet(messages_fts, 0, '‹mark›', '‹/mark›', '…', 24) as snippet,
         s.title, s.started_at, s.git_branch,
         rank
  FROM messages_fts
  JOIN messages m ON m.id = messages_fts.rowid
  JOIN sessions s ON m.session_id = s.id
  WHERE messages_fts MATCH ?
  ORDER BY rank
  LIMIT 200
`);

const searchMessagesFtsInWorkspace = db.prepare(`
  SELECT m.session_id, m.role, m.message_type, m.timestamp, m.sequence,
         snippet(messages_fts, 0, '‹mark›', '‹/mark›', '…', 24) as snippet,
         s.title, s.started_at, s.git_branch,
         rank
  FROM messages_fts
  JOIN messages m ON m.id = messages_fts.rowid
  JOIN sessions s ON m.session_id = s.id
  WHERE s.workspace_id = ? AND messages_fts MATCH ?
  ORDER BY rank
  LIMIT 200
`);

/** Convert user query to FTS5 query — wraps words in double quotes for phrase-like matching */
/** Convert a glob pattern (*, ?) to a SQL LIKE pattern */
function globToLike(glob: string): string {
  let result = '';
  for (const ch of glob) {
    if (ch === '*') result += '%';
    else if (ch === '?') result += '_';
    else if (ch === '%' || ch === '_') result += '\\' + ch;
    else result += ch;
  }
  return result;
}

function toFtsQuery(query: string): string {
  // Escape double quotes, wrap each word in quotes for prefix matching
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '""';
  // Use AND between terms for better precision
  return words.map(w => `"${w.replace(/"/g, '""')}"`).join(' AND ');
}

// ── Summarization Prepared Statements ─────────────────────────────

const getUnsummarizedSessions = db.prepare(`
  SELECT id, title FROM sessions WHERE workspace_id = ? AND summary IS NULL AND message_count > 0
`);

const getAllUnsummarizedSessions = db.prepare(`
  SELECT id, title FROM sessions WHERE summary IS NULL AND message_count > 0
`);

const updateSessionSummary = db.prepare(`
  UPDATE sessions SET summary = ? WHERE id = ?
`);

// ── Summarization Job Tracker ────────────────────────────────────

interface SummarizeJob {
  workspaceId: number;
  total: number;
  completed: number;
  failed: number;
  running: boolean;
  cancelled: boolean;
  errors: Array<{ sessionId: string; error: string }>;
}

let activeJob: SummarizeJob | null = null;
const anthropic = new Anthropic();
let summarizeQueue: PQueue | null = null;

async function runSummarization(
  sessionIds: Array<{ id: string; title: string }>
) {
  const queue = new PQueue({ concurrency: config.summaryConcurrency });
  summarizeQueue = queue;

  const tasks = sessionIds.map((s) => {
    return queue.add(async () => {
      if (!activeJob || activeJob.cancelled) return;

      try {
        const rawMessages = getMessages.all(s.id) as Array<{
          role: string;
          content: string;
          timestamp: string;
          sequence: number;
        }>;

        const transcript = rawMessages
          .map((m) => {
            const cleaned = cleanXmlNoise(m.content);
            if (!cleaned) return null;
            return `[${m.role}]: ${cleaned}`;
          })
          .filter(Boolean)
          .join("\n\n");

        if (!transcript) {
          activeJob.completed++;
          return;
        }

        const truncated = transcript.slice(0, 32000);

        const response = await anthropic.messages.create({
          model: config.summaryModel,
          max_tokens: config.summaryMaxTokens,
          messages: [
            {
              role: "user",
              content: `Summarize this coding session as 2-3 bullet points. MAX 12 words per bullet.

Format — output ONLY bullets, nothing else:
- Verb + what + where (e.g. "Added auto-ingest polling to session-explorer server")
- Verb + what (e.g. "Fixed FTS5 search ranking for long queries")

Rules:
- Start each bullet with a past-tense verb: Built, Fixed, Added, Decided, Explored, Debugged, Refactored
- Max 12 words per bullet. Be terse. Cut filler words.
- Use file names, feature names, and specific concepts
- No sub-bullets, no multi-sentence bullets, no colons, no explanations
- No preamble like "Summary:" or "Here are the bullets:"
- If the session has no meaningful coding work, output a single bullet: "No substantive work"

Conversation:
${truncated}`,
            },
          ],
        });

        const summary =
          response.content[0].type === "text" ? response.content[0].text : "";

        if (summary) {
          updateSessionSummary.run(summary, s.id);
        }
        activeJob.completed++;
      } catch (err: unknown) {
        activeJob.failed++;
        const msg = err instanceof Error ? err.message : String(err);
        activeJob.errors.push({ sessionId: s.id, error: msg });
      }
    });
  });

  await Promise.allSettled(tasks);

  if (activeJob) {
    activeJob.running = false;
  }
  summarizeQueue = null;
}

// ── Routes ─────────────────────────────────────────────────────────

app.get("/api/workspaces", (_req, res) => {
  const workspaces = listWorkspaces.all();
  res.json(workspaces);
});

app.get("/api/sessions", (req, res) => {
  const workspaceId = req.query.workspace
    ? Number(req.query.workspace)
    : null;
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
  const offset = (page - 1) * limit;

  let sessions;
  let total: number;

  if (workspaceId) {
    sessions = listSessions.all(workspaceId, limit, offset);
    total = (countSessions.get(workspaceId) as { total: number }).total;
  } else {
    sessions = listAllSessions.all(limit, offset);
    total = (countAllSessions.get() as { total: number }).total;
  }

  // Enrich sessions with tags and created files
  const enriched = (sessions as Array<Record<string, unknown>>).map((s) => ({
    ...s,
    tags: getTagsForSession.all(s.id),
    files_changed: changedFilesForSession.all(s.id),
  }));

  res.json({
    sessions: enriched,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    },
  });
});

app.post("/api/sessions/bulk", (req, res) => {
  const { ids } = req.body as { ids: string[] };
  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    res.status(400).json({ error: "ids array is required" });
    return;
  }

  const placeholders = ids.map(() => "?").join(",");
  const bulkQuery = db.prepare(`
    SELECT s.id, s.workspace_id, s.started_at, s.ended_at, s.git_branch, s.title,
           s.message_count, s.user_message_count, s.summary,
           w.display_name as workspace_name, w.path as workspace_path
    FROM sessions s
    JOIN workspaces w ON s.workspace_id = w.id
    WHERE s.id IN (${placeholders})
    ORDER BY s.started_at DESC
  `);

  const sessions = bulkQuery.all(...ids);
  const enriched = (sessions as Array<Record<string, unknown>>).map((s) => ({
    ...s,
    tags: getTagsForSession.all(s.id as string),
    files_changed: changedFilesForSession.all(s.id as string),
  }));

  res.json({ sessions: enriched });
});

app.get("/api/sessions/:id", (req, res) => {
  const session = getSession.get(req.params.id);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  const rawMessages = getMessages.all(req.params.id) as Array<{ role: string; content: string; timestamp: string; sequence: number }>;
  const messages = rawMessages
    .map((m) => ({ ...m, content: cleanXmlNoise(m.content) }))
    .filter((m) => m.content.length > 0);
  const tags = getTagsForSession.all(req.params.id);
  res.json({ ...(session as Record<string, unknown>), messages, tags });
});

app.get("/api/search", (req, res) => {
  const query = req.query.q as string;
  if (!query || query.length < 2) {
    res.json({ results: [], total_sessions: 0, total_matches: 0 });
    return;
  }

  const ftsQuery = toFtsQuery(query);
  const sort = (req.query.sort as string) || "date";
  const workspaceId = req.query.workspace
    ? Number(req.query.workspace)
    : null;
  const maxMatchesPerSession = 3;

  let results: unknown[];
  try {
    results = workspaceId
      ? searchMessagesFtsInWorkspace.all(workspaceId, ftsQuery)
      : searchMessagesFts.all(ftsQuery);
  } catch {
    // FTS query syntax error — fall back to empty
    res.json({ results: [], total_sessions: 0, total_matches: 0 });
    return;
  }

  // Group raw match rows by session, keeping all of them for prioritization
  const rawMatchesBySession = new Map<string, Array<{ session_id: string; role: string; message_type: string; snippet: string; timestamp: string; sequence: number }>>();
  let totalMatches = 0;

  for (const row of results as Array<{
    session_id: string;
    role: string;
    message_type: string;
    snippet: string;
    timestamp: string;
    sequence: number;
  }>) {
    if (!rawMatchesBySession.has(row.session_id)) {
      rawMatchesBySession.set(row.session_id, []);
    }
    rawMatchesBySession.get(row.session_id)!.push(row);
    totalMatches++;
  }

  // Helper: clean a message into a readable context string
  function cleanForContext(content: string, maxLen = 120): string {
    const clean = content
      .replace(/\x1b\[[\d;]*m/g, '')     // strip ANSI escape codes
      .replace(/\[[\d;]*m/g, '')          // strip partial ANSI codes
      .replace(/```[\s\S]*?```/g, '[code]')
      .replace(/`[^`]+`/g, (m) => m.length > 40 ? '[code]' : m)
      .replace(/\n+/g, ' ')
      .trim();
    return clean.length > maxLen ? clean.slice(0, maxLen) + '…' : clean;
  }

  // Helper: check if a message is "real conversation" vs tool noise
  function isConversational(messageType: string): boolean {
    return messageType === 'text';
  }

  // Helper: extract a readable preview from message content
  function extractPreview(content: string): string | null {
    const lines = content.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    for (const line of lines.slice(0, 8)) {
      const cleaned = line
        .replace(/^#+\s*/, '')
        .replace(/```\w*/, '')
        .replace(/^[-*]\s*/, '')
        .replace(/\x1b\[[\d;]*m/g, '')
        .replace(/\[[\d;]*m/g, '')
        .replace(/^\[?\u2713\]?\s*/, '');
      const pathCount = (cleaned.match(/[\w.-]+\.\w{1,5}/g) || []).length;
      const isNoise = pathCount > 3 || /^[{[\/"<(]/.test(cleaned) || cleaned.length < 8;
      if (!isNoise) {
        return cleaned.length > 150 ? cleaned.slice(0, 150) + '…' : cleaned;
      }
    }
    return null;
  }

  // For context: find nearest conversational message from the other role
  const getNearbyConversation = db.prepare(`
    SELECT role, content, sequence FROM messages
    WHERE session_id = ? AND sequence < ? AND role != ? AND message_type = 'text'
    ORDER BY sequence DESC LIMIT 1
  `);
  const getFollowingConversation = db.prepare(`
    SELECT role, content, sequence FROM messages
    WHERE session_id = ? AND sequence > ? AND role != ? AND message_type = 'text'
    ORDER BY sequence ASC LIMIT 1
  `);

  // Pick best matches per session: prefer text messages over tool messages
  type EnrichedMatch = { role: string; message_type: string; snippet: string; timestamp: string; sequence: number; context: string | null; context_role: string | null; preview: string | null; tool_content: string | null };
  const matchesBySession = new Map<string, { matches: EnrichedMatch[]; match_count: number }>();

  for (const [sessionId, rows] of rawMatchesBySession) {
    // Sort: text messages first, then by original FTS rank order
    const sorted = [...rows].sort((a, b) => {
      const aConv = isConversational(a.message_type) ? 0 : 1;
      const bConv = isConversational(b.message_type) ? 0 : 1;
      return aConv - bConv;
    });

    const picked: EnrichedMatch[] = [];
    for (const row of sorted) {
      if (picked.length >= maxMatchesPerSession) break;

      // Find conversational context (skip tool messages when looking for context)
      let context: string | null = null;
      let contextRole: string | null = null;
      const before = getNearbyConversation.get(sessionId, row.sequence, row.role) as { role: string; content: string } | undefined;
      const after = getFollowingConversation.get(sessionId, row.sequence, row.role) as { role: string; content: string } | undefined;
      const adjacent = before || after;
      if (adjacent) {
        context = cleanForContext(adjacent.content);
        contextRole = adjacent.role;
      }

      // Extract readable preview from matched message
      let preview: string | null = null;
      const msg = getMessageContent.get(sessionId, row.sequence) as { content: string } | undefined;
      if (msg) {
        preview = extractPreview(msg.content);
      }

      // For tool output matches, extract content with line breaks preserved
      let toolContent: string | null = null;
      if (!isConversational(row.message_type) && msg) {
        // Clean ANSI codes
        let cleaned = msg.content
          .replace(/\x1b\[[\d;]*m/g, '')
          .replace(/\[[\d;]*m/g, '');

        // JSON pretty-printing is handled client-side (handles truncated JSON)
        // Truncate by lines, preserving structure
        const lines = cleaned.split('\n').filter(l => l.trim().length > 0);
        let result = '';
        const maxLen = 500; // more room for formatted JSON
        for (const line of lines) {
          if (result.length + line.length > maxLen) {
            result += (result ? '\n' : '') + line.slice(0, Math.max(0, maxLen - result.length)) + '…';
            break;
          }
          result += (result ? '\n' : '') + line;
        }
        toolContent = result || null;
      }

      picked.push({
        role: row.role,
        message_type: row.message_type,
        snippet: row.snippet,
        timestamp: row.timestamp,
        sequence: row.sequence,
        context,
        context_role: contextRole,
        preview,
        tool_content: toolContent,
      });
    }

    matchesBySession.set(sessionId, { matches: picked, match_count: rows.length });
  }

  // Enrich with full session data (summary, tags, files)
  const enriched = Array.from(matchesBySession.entries()).map(([sessionId, { matches, match_count }]) => {
    const session = getSession.get(sessionId) as Record<string, unknown> | undefined;
    if (!session) return null;
    return {
      ...session,
      tags: getTagsForSession.all(sessionId),
      files_changed: changedFilesForSession.all(sessionId),
      matches,
      match_count,
      match_source: 'content' as const,
    };
  }).filter(Boolean) as Array<Record<string, unknown> & { match_count: number; match_source: string; started_at?: string }>;

  // Cross-search: find sessions by file path/name match
  const isGlob = /[*?]/.test(query);
  const fileSearchPattern = isGlob ? globToLike(query.trim()) : `%${query.trim()}%`;
  const fileHits = db.prepare(`
    SELECT sf.session_id, sf.file_name, sf.file_path
    FROM session_files sf
    WHERE (sf.file_name LIKE ? OR sf.file_path LIKE ?)
    AND sf.file_path NOT LIKE '%.png'
    AND sf.file_path NOT LIKE '%.jpg'
    LIMIT 200
  `).all(fileSearchPattern, fileSearchPattern) as Array<{ session_id: string; file_name: string; file_path: string }>;

  // Group matched files by session
  const matchedFilesBySession = new Map<string, string[]>();
  for (const hit of fileHits) {
    if (matchesBySession.has(hit.session_id)) continue;
    if (!matchedFilesBySession.has(hit.session_id)) matchedFilesBySession.set(hit.session_id, []);
    const files = matchedFilesBySession.get(hit.session_id)!;
    if (!files.includes(hit.file_name)) files.push(hit.file_name);
  }

  for (const [session_id, matched_files] of matchedFilesBySession) {
    const session = getSession.get(session_id) as Record<string, unknown> | undefined;
    if (!session) continue;
    if (workspaceId && (session as any).workspace_id !== workspaceId) continue;
    enriched.push({
      ...session,
      tags: getTagsForSession.all(session_id),
      files_changed: changedFilesForSession.all(session_id),
      matches: [],
      match_count: 0,
      match_source: 'files' as const,
      matched_files,
    });
  }

  // Sort based on query parameter
  if (sort === "date") {
    enriched.sort((a, b) => new Date(b.started_at as string).getTime() - new Date(a.started_at as string).getTime());
  } else if (sort === "date_asc") {
    enriched.sort((a, b) => new Date(a.started_at as string).getTime() - new Date(b.started_at as string).getTime());
  } else if (sort === "matches") {
    enriched.sort((a, b) => b.match_count - a.match_count);
  }
  // sort === "relevance" keeps the FTS5 rank order (default from query)

  res.json({
    results: enriched,
    total_sessions: enriched.length,
    total_matches: totalMatches,
  });
});

// ── Tag Routes ────────────────────────────────────────────────────

app.get("/api/tags", (_req, res) => {
  const tags = listTags.all();
  res.json(tags);
});

app.post("/api/tags", (req, res) => {
  const { name, color, description } = req.body;
  if (!name || typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "Name is required" });
    return;
  }
  try {
    const now = new Date().toISOString();
    const result = createTag.run(name.trim(), color || "#58a6ff", description || null, now);
    const tag = getTagById.get(result.lastInsertRowid);
    insertAuditLog.run("create_tag", "tag", String(result.lastInsertRowid), JSON.stringify({ name: name.trim(), color: color || "#58a6ff" }));
    res.status(201).json(tag);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("UNIQUE")) {
      res.status(409).json({ error: "Tag name already exists" });
    } else {
      res.status(500).json({ error: msg });
    }
  }
});

app.patch("/api/tags/:id", (req, res) => {
  const tagId = Number(req.params.id);
  const { name, color } = req.body;
  if (!name && !color) {
    res.status(400).json({ error: "name or color is required" });
    return;
  }
  try {
    updateTag.run(name || null, color || null, tagId);
    const tag = getTagById.get(tagId);
    if (!tag) {
      res.status(404).json({ error: "Tag not found" });
      return;
    }
    res.json(tag);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("UNIQUE")) {
      res.status(409).json({ error: "Tag name already exists" });
    } else {
      res.status(500).json({ error: msg });
    }
  }
});

app.delete("/api/tags/:id", (req, res) => {
  const tagId = Number(req.params.id);
  deleteTagSessions.run(tagId);
  deleteTag.run(tagId);
  insertAuditLog.run("delete_tag", "tag", String(tagId), null);
  res.json({ ok: true });
});

app.post("/api/sessions/:id/tags", (req, res) => {
  const sessionId = req.params.id;
  let { tag_id, name, color } = req.body;

  // Create-and-add flow: if name provided instead of tag_id
  if (!tag_id && name) {
    let existing = getTagByName.get(name.trim()) as { id: number } | undefined;
    if (!existing) {
      const now = new Date().toISOString();
      const result = createTag.run(name.trim(), color || "#58a6ff", null, now);
      existing = getTagById.get(result.lastInsertRowid) as { id: number };
    }
    tag_id = existing!.id;
  }

  if (!tag_id) {
    res.status(400).json({ error: "tag_id or name is required" });
    return;
  }

  const now = new Date().toISOString();
  addSessionTag.run(sessionId, tag_id, now);
  const tag = getTagById.get(tag_id) as { id: number; name: string } | undefined;
  insertAuditLog.run("add_tag", "session", sessionId, JSON.stringify({ tag_id, tag_name: tag?.name }));
  res.json(tag);
});

app.delete("/api/sessions/:id/tags/:tagId", (req, res) => {
  removeSessionTag.run(req.params.id, Number(req.params.tagId));
  insertAuditLog.run("remove_tag", "session", req.params.id, JSON.stringify({ tag_id: Number(req.params.tagId) }));
  res.json({ ok: true });
});

app.get("/api/tags/:id/sessions", (req, res) => {
  const tagId = Number(req.params.id);
  const tag = getTagById.get(tagId);
  if (!tag) {
    res.status(404).json({ error: "Tag not found" });
    return;
  }
  const sessions = getSessionsForTag.all(tagId);
  // Enrich sessions with their tags and created files
  const enriched = (sessions as Array<Record<string, unknown>>).map((s) => ({
    ...s,
    tags: getTagsForSession.all(s.id as string),
    files_changed: changedFilesForSession.all(s.id as string),
  }));
  res.json({ tag, sessions: enriched });
});

app.get("/api/tags/by-name/:name", (req, res) => {
  const tag = getTagByName.get(req.params.name);
  if (!tag) {
    res.status(404).json({ error: "Tag not found" });
    return;
  }
  res.json(tag);
});

app.get("/api/tags/by-name/:name/sessions", (req, res) => {
  const tag = getTagByName.get(req.params.name) as { id: number } | undefined;
  if (!tag) {
    res.status(404).json({ error: "Tag not found" });
    return;
  }
  const sessions = getSessionsForTag.all(tag.id);
  const enriched = (sessions as Array<Record<string, unknown>>).map((s) => ({
    ...s,
    tags: getTagsForSession.all(s.id as string),
    files_changed: changedFilesForSession.all(s.id as string),
  }));
  res.json({ tag, sessions: enriched });
});

// ── Saved Search Prepared Statements ────────────────────────────────

const listSavedSearches = db.prepare(`
  SELECT ss.*, t.name as tag_name, t.color as tag_color
  FROM saved_searches ss
  JOIN tags t ON ss.tag_id = t.id
  ORDER BY ss.last_run_at DESC
`);

const getSavedSearch = db.prepare(`SELECT * FROM saved_searches WHERE id = ?`);
const getSavedSearchByTagId = db.prepare(`SELECT * FROM saved_searches WHERE tag_id = ?`);

const createSavedSearch = db.prepare(`
  INSERT INTO saved_searches (tag_id, query_text, created_at) VALUES (?, ?, ?)
`);

const deleteSavedSearch = db.prepare(`DELETE FROM saved_searches WHERE id = ?`);

const updateSavedSearchRun = db.prepare(`
  UPDATE saved_searches SET last_run_at = ?, last_run_count = ? WHERE id = ?
`);

const clearSessionTagsForTag = db.prepare(`DELETE FROM session_tags WHERE tag_id = ?`);

// ── Saved Search Routes ────────────────────────────────────────────

app.get("/api/saved-searches", (_req, res) => {
  const searches = listSavedSearches.all();
  res.json(searches);
});

app.post("/api/saved-searches", (req, res) => {
  const { tag_id, tag_name, tag_color, query_text } = req.body;

  if (!query_text || typeof query_text !== "string" || !query_text.trim()) {
    res.status(400).json({ error: "query_text is required" });
    return;
  }

  let resolvedTagId = tag_id;

  // Create tag if needed
  if (!resolvedTagId && tag_name) {
    let existing = getTagByName.get(tag_name.trim()) as { id: number } | undefined;
    if (!existing) {
      const now = new Date().toISOString();
      const result = createTag.run(tag_name.trim(), tag_color || "#58a6ff", null, now);
      existing = getTagById.get(result.lastInsertRowid) as { id: number };
    }
    resolvedTagId = existing!.id;
  }

  if (!resolvedTagId) {
    res.status(400).json({ error: "tag_id or tag_name is required" });
    return;
  }

  // Check if tag already has a saved search
  const existingSearch = getSavedSearchByTagId.get(resolvedTagId);
  if (existingSearch) {
    res.status(409).json({ error: "This tag already has a saved search" });
    return;
  }

  try {
    const now = new Date().toISOString();
    const result = createSavedSearch.run(resolvedTagId, query_text.trim(), now);
    const search = getSavedSearch.get(result.lastInsertRowid);
    insertAuditLog.run("create_saved_search", "saved_search", String(result.lastInsertRowid), JSON.stringify({ tag_id: resolvedTagId, query_text: query_text.trim() }));
    res.status(201).json(search);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: msg });
  }
});

app.delete("/api/saved-searches/:id", (req, res) => {
  const id = Number(req.params.id);
  deleteSavedSearch.run(id);
  insertAuditLog.run("delete_saved_search", "saved_search", String(id), null);
  res.json({ ok: true });
});

app.post("/api/saved-searches/:id/run", async (req, res) => {
  const id = Number(req.params.id);
  const search = getSavedSearch.get(id) as { id: number; tag_id: number; query_text: string } | undefined;

  if (!search) {
    res.status(404).json({ error: "Saved search not found" });
    return;
  }

  try {
    // Build messages for the AI call
    let anthropicMessages: Anthropic.Messages.MessageParam[] = [
      { role: "user", content: search.query_text },
    ];

    const maxIterations = config.chatMaxToolIterations;
    let fullText = "";

    for (let i = 0; i < maxIterations; i++) {
      const response = await anthropic.messages.create({
        model: config.chatModel,
        max_tokens: config.chatMaxTokens,
        system: SYSTEM_PROMPT,
        tools,
        messages: anthropicMessages,
      });

      // Collect text and tool uses
      const toolUses: Anthropic.Messages.ToolUseBlock[] = [];
      for (const block of response.content) {
        if (block.type === "text") {
          fullText += block.text;
        } else if (block.type === "tool_use") {
          toolUses.push(block);
        }
      }

      if (toolUses.length === 0) break;

      // Execute tool calls
      anthropicMessages = [
        ...anthropicMessages,
        { role: "assistant" as const, content: response.content },
      ];

      const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
      for (const toolUse of toolUses) {
        const input = toolUse.input as { query: string; params?: unknown[] };
        const result = executeSql(input.query, input.params || []);
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: JSON.stringify(result),
        });
      }

      anthropicMessages.push({
        role: "user" as const,
        content: toolResults,
      });
    }

    // Parse result to get session_ids
    const result = parseResult(fullText);
    const sessionIds = result?.session_ids || [];

    // Clear existing session_tags for this tag, then re-add
    const updateTagMembership = db.transaction(() => {
      clearSessionTagsForTag.run(search.tag_id);
      const now = new Date().toISOString();
      for (const sessionId of sessionIds) {
        addSessionTag.run(sessionId, search.tag_id, now);
      }
      updateSavedSearchRun.run(now, sessionIds.length, search.id);
    });
    updateTagMembership();

    insertAuditLog.run("run_saved_search", "saved_search", String(id), JSON.stringify({ count: sessionIds.length }));

    res.json({ session_ids: sessionIds, count: sessionIds.length });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Saved search run error:", msg);
    res.status(500).json({ error: msg });
  }
});

// ── File Endpoints ──────────────────────────────────────────────────

const searchFiles = db.prepare(`
  SELECT DISTINCT sf.file_path, sf.file_name, sf.operation,
         COUNT(DISTINCT sf.session_id) as session_count,
         MAX(sf.timestamp) as last_seen
  FROM session_files sf
  JOIN sessions s ON sf.session_id = s.id
  WHERE (sf.file_path LIKE ? OR sf.file_name LIKE ?)
  AND sf.file_path NOT LIKE '%.png'
  AND sf.file_path NOT LIKE '%.jpg'
  GROUP BY sf.file_path, sf.operation
  ORDER BY last_seen DESC
  LIMIT 200
`);

const searchFilesInWorkspace = db.prepare(`
  SELECT DISTINCT sf.file_path, sf.file_name, sf.operation,
         COUNT(DISTINCT sf.session_id) as session_count,
         MAX(sf.timestamp) as last_seen
  FROM session_files sf
  JOIN sessions s ON sf.session_id = s.id
  WHERE (sf.file_path LIKE ? OR sf.file_name LIKE ?)
  AND s.workspace_id = ?
  AND sf.file_path NOT LIKE '%.png'
  AND sf.file_path NOT LIKE '%.jpg'
  GROUP BY sf.file_path, sf.operation
  ORDER BY last_seen DESC
  LIMIT 200
`);

const filesByPath = db.prepare(`
  SELECT DISTINCT s.id, s.started_at, s.ended_at, s.git_branch, s.title,
         s.message_count, s.user_message_count, sf.operation,
         w.display_name as workspace_name
  FROM session_files sf
  JOIN sessions s ON sf.session_id = s.id
  JOIN workspaces w ON s.workspace_id = w.id
  WHERE sf.file_path = ?
  ORDER BY s.started_at DESC
`);

const filesForSession = db.prepare(`
  SELECT DISTINCT file_path, file_name, operation
  FROM session_files WHERE session_id = ?
  AND file_path NOT LIKE '%.png'
  AND file_path NOT LIKE '%.jpg'
  AND file_path NOT LIKE '%.jpeg'
  AND file_path NOT LIKE '%.gif'
  AND file_path NOT LIKE '%.webp'
  AND file_path NOT LIKE '%.svg'
  ORDER BY sequence ASC
`);

const changedFilesForSession = db.prepare(`
  SELECT DISTINCT file_path, file_name, operation
  FROM session_files WHERE session_id = ? AND operation IN ('write', 'edit')
  AND file_path NOT LIKE '%.png'
  AND file_path NOT LIKE '%.jpg'
  AND file_path NOT LIKE '%.jpeg'
  AND file_path NOT LIKE '%.gif'
  AND file_path NOT LIKE '%.webp'
  AND file_path NOT LIKE '%.svg'
  ORDER BY sequence ASC
`);

app.get("/api/files/search", (req, res) => {
  const query = req.query.q as string;
  if (!query || query.length < 2) {
    res.json({ results: [] });
    return;
  }

  const isGlob = /[*?]/.test(query);
  const pattern = isGlob ? globToLike(query) : `%${query}%`;
  const workspaceId = req.query.workspace ? Number(req.query.workspace) : null;

  const results = workspaceId
    ? searchFilesInWorkspace.all(pattern, pattern, workspaceId)
    : searchFiles.all(pattern, pattern);

  res.json({ results });
});

app.get("/api/files/by-path", (req, res) => {
  const path = req.query.path as string;
  if (!path) {
    res.json({ sessions: [] });
    return;
  }

  const sessions = filesByPath.all(path);
  res.json({ sessions, file_path: path });
});

app.get("/api/sessions/:id/files", (req, res) => {
  const files = filesForSession.all(req.params.id);
  res.json({ files });
});

app.get("/api/files/view", (req, res) => {
  const filePath = req.query.path as string;
  if (!filePath) {
    res.status(400).json({ error: "path parameter required" });
    return;
  }

  // Safety: only serve files under the user's home directory
  const home = homedir();
  if (!filePath.startsWith(home)) {
    res.status(403).json({ error: "Access denied: file must be under home directory" });
    return;
  }

  if (!existsSync(filePath)) {
    res.status(404).json({ error: "File not found" });
    return;
  }

  try {
    const content = readFileSync(filePath, "utf-8");
    res.type("text/plain").send(content);
  } catch (err) {
    res.status(500).json({ error: "Failed to read file" });
  }
});

// ── Summarization Routes ─────────────────────────────────────────

app.post("/api/workspaces/:id/summarize", (req, res) => {
  if (activeJob?.running) {
    res.status(409).json({ error: "A summarization job is already running" });
    return;
  }

  const workspaceId = Number(req.params.id);
  const unsummarized = getUnsummarizedSessions.all(workspaceId) as Array<{
    id: string;
    title: string;
  }>;

  if (unsummarized.length === 0) {
    res.status(200).json({ message: "All sessions already summarized" });
    return;
  }

  activeJob = {
    workspaceId,
    total: unsummarized.length,
    completed: 0,
    failed: 0,
    running: true,
    cancelled: false,
    errors: [],
  };

  // Fire-and-forget
  runSummarization(unsummarized);

  res.status(202).json({ total: unsummarized.length });
});

app.get("/api/workspaces/:id/summarize/status", (_req, res) => {
  if (!activeJob) {
    res.json({ running: false });
    return;
  }
  res.json(activeJob);
});

app.delete("/api/workspaces/:id/summarize", (_req, res) => {
  if (activeJob) {
    activeJob.cancelled = true;
    if (summarizeQueue) {
      summarizeQueue.clear();
    }
  }
  res.json({ ok: true });
});

// ── Re-ingest Endpoint ────────────────────────────────────────────────

import { runIngestion, getStaleSessionsNeedingReingest, reingestSession } from "./ingest.js";
import type { IngestProgress } from "./ingest.js";

let ingestProgress: IngestProgress | null = null;

app.post("/api/ingest", async (req, res) => {
  if (ingestProgress?.running) {
    res.status(409).json({ error: "Ingestion already running" });
    return;
  }

  // Start ingestion in background
  ingestProgress = { total: 0, ingested: 0, skipped: 0, running: true };
  runIngestion({ all: true }, (p) => { ingestProgress = p; })
    .then((final) => { ingestProgress = { ...final, running: false }; })
    .catch(() => { ingestProgress = { ...ingestProgress!, running: false }; });

  res.status(202).json({ message: "Ingestion started" });
});

app.get("/api/ingest/status", (_req, res) => {
  res.json(ingestProgress || { running: false });
});

// ── Open file in default app ──────────────────────────────────────
import { execFile } from "node:child_process";

app.post("/api/open-file", (req, res) => {
  const { path: filePath } = req.body as { path?: string };
  if (!filePath || typeof filePath !== "string") {
    res.status(400).json({ error: "path is required" });
    return;
  }
  // Validate path is absolute and exists as a regular file
  if (!filePath.startsWith("/") || !existsSync(filePath)) {
    res.status(404).json({ error: "File not found" });
    return;
  }
  // Use execFile to avoid shell injection — passes path as argument, not through shell
  execFile("open", [filePath], (err) => {
    if (err) {
      res.status(500).json({ error: err.message });
    } else {
      res.json({ ok: true });
    }
  });
});

// SPA fallback — serve index.html for non-API routes
app.get("*", (_req, res) => {
  res.sendFile(join(__dirname, "..", "dist", "web", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Session Explorer API running on http://localhost:${PORT}`);

  // ── Auto-ingest + auto-summarize polling ─────────────────────────
  setInterval(async () => {
    if (ingestProgress?.running || activeJob?.running) return;

    try {
      // Phase 1: Ingest brand new sessions (not in DB yet)
      ingestProgress = { total: 0, ingested: 0, skipped: 0, running: true };
      const final = await runIngestion({ all: false }, (p) => { ingestProgress = p; });
      ingestProgress = { ...final, running: false };

      // Phase 2: Re-ingest stale sessions that have new data
      const stale = getStaleSessionsNeedingReingest(4); // 4 hours idle
      if (stale.length > 0) {
        console.log(`[auto-ingest] Re-ingesting ${stale.length} idle session(s) with new data`);
        for (const s of stale) {
          reingestSession(s.sourcePath, s.workspaceId);
        }
      }

      // Phase 3: Auto-summarize
      if (activeJob?.running) return;
      const unsummarized = getAllUnsummarizedSessions.all() as Array<{ id: string; title: string }>;
      if (unsummarized.length === 0) return;

      console.log(`[auto-ingest] Found ${unsummarized.length} unsummarized session(s), starting summarization`);
      activeJob = {
        workspaceId: 0,
        total: unsummarized.length,
        completed: 0,
        failed: 0,
        running: true,
        cancelled: false,
        errors: [],
      };
      await runSummarization(unsummarized);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[auto-ingest] Error:", msg);
      if (ingestProgress?.running) ingestProgress = { ...ingestProgress, running: false };
    }
  }, config.autoIngestIntervalMs);
});
