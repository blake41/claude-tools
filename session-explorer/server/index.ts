import express from "express";
import cors from "cors";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import Anthropic from "@anthropic-ai/sdk";
import PQueue from "p-queue";
import db from "./db.js";

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
const PORT = 5198;

app.use(cors());
app.use(express.json());

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
  SELECT role, content, timestamp, sequence
  FROM messages
  WHERE session_id = ?
  ORDER BY sequence ASC
`);

const searchMessages = db.prepare(`
  SELECT m.session_id, m.role, m.content, m.timestamp, m.sequence,
         s.title, s.started_at, s.git_branch
  FROM messages m
  JOIN sessions s ON m.session_id = s.id
  WHERE m.content LIKE ?
  ORDER BY m.timestamp DESC
  LIMIT 100
`);

const searchMessagesInWorkspace = db.prepare(`
  SELECT m.session_id, m.role, m.content, m.timestamp, m.sequence,
         s.title, s.started_at, s.git_branch
  FROM messages m
  JOIN sessions s ON m.session_id = s.id
  WHERE s.workspace_id = ? AND m.content LIKE ?
  ORDER BY m.timestamp DESC
  LIMIT 100
`);

// ── Summarization Prepared Statements ─────────────────────────────

const getUnsummarizedSessions = db.prepare(`
  SELECT id, title FROM sessions WHERE workspace_id = ? AND summary IS NULL AND message_count > 0
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
  const queue = new PQueue({ concurrency: 5 });
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
          model: "claude-haiku-4-5-20251001",
          max_tokens: 200,
          messages: [
            {
              role: "user",
              content: `Summarize this coding session as 2-4 bullet points. Each bullet should be one short line.

Format:
- Built/Fixed/Added [concrete thing] in [file or area]
- Decided [specific decision or approach]
- Produced [specific output or result]

Rules:
- Start each bullet with a past-tense verb (Built, Fixed, Added, Decided, Explored, Debugged, etc.)
- Use file names, feature names, and specific concepts
- No sub-bullets, no multi-sentence bullets
- Do not start with "The user" or "In this session"

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
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
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
    res.json({ results: [] });
    return;
  }

  const pattern = `%${query}%`;
  const workspaceId = req.query.workspace
    ? Number(req.query.workspace)
    : null;

  const results = workspaceId
    ? searchMessagesInWorkspace.all(workspaceId, pattern)
    : searchMessages.all(pattern);

  // Group by session
  const grouped = new Map<
    string,
    { session_id: string; title: string; started_at: string; git_branch: string; matches: unknown[] }
  >();

  for (const row of results as Array<{
    session_id: string;
    title: string;
    started_at: string;
    git_branch: string;
    role: string;
    content: string;
    timestamp: string;
    sequence: number;
  }>) {
    if (!grouped.has(row.session_id)) {
      grouped.set(row.session_id, {
        session_id: row.session_id,
        title: row.title,
        started_at: row.started_at,
        git_branch: row.git_branch,
        matches: [],
      });
    }
    const cleaned = cleanXmlNoise(row.content);
    if (!cleaned) continue;
    grouped.get(row.session_id)!.matches.push({
      role: row.role,
      content: cleaned.slice(0, 300),
      timestamp: row.timestamp,
      sequence: row.sequence,
    });
  }

  res.json({ results: Array.from(grouped.values()) });
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
  const tag = getTagById.get(tag_id);
  res.json(tag);
});

app.delete("/api/sessions/:id/tags/:tagId", (req, res) => {
  removeSessionTag.run(req.params.id, Number(req.params.tagId));
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
  LIMIT 50
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
  LIMIT 50
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

  const pattern = `%${query}%`;
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

// SPA fallback — serve index.html for non-API routes
app.get("*", (_req, res) => {
  res.sendFile(join(__dirname, "..", "dist", "web", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Session Explorer API running on http://localhost:${PORT}`);
});
