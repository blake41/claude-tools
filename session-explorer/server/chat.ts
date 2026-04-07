import { Router } from "express";
import { Database } from "bun:sqlite";
import Anthropic from "@anthropic-ai/sdk";
import db, { DB_PATH } from "./db.js";
import { config } from "./config.js";

const router = Router();
const anthropic = new Anthropic();

// Read-only database connection for safety
const readDb = new Database(DB_PATH, { readonly: true });

// Prepared statement for saving chat history
const insertChatHistory = db.prepare(
  `INSERT INTO chat_history (query_text, answer_text, session_ids, session_count, queries, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))`
);

function buildSystemPrompt(): string {
  // Dynamic data profile from the database
  let sessionCount = 0, workspaceCount = 0, messageCount = 0, dateRange = "";
  try {
    const stats = readDb.prepare(`
      SELECT
        (SELECT count(*) FROM sessions) as sessions,
        (SELECT count(*) FROM workspaces) as workspaces,
        (SELECT count(*) FROM messages) as messages,
        (SELECT min(started_at) FROM sessions) as earliest,
        (SELECT max(started_at) FROM sessions) as latest
    `).get() as Record<string, unknown>;
    sessionCount = stats.sessions as number;
    workspaceCount = stats.workspaces as number;
    messageCount = stats.messages as number;
    dateRange = `${(stats.earliest as string || "").slice(0, 10)} to ${(stats.latest as string || "").slice(0, 10)}`;
  } catch {}

  return `You are a search assistant for Session Explorer, a tool for browsing Claude Code session history. You answer questions by querying a SQLite database.

## Schema

workspaces: id INTEGER PRIMARY KEY, path TEXT, dir_name TEXT, display_name TEXT, session_count INTEGER, last_activity TEXT
sessions: id TEXT PRIMARY KEY, workspace_id INTEGER REFERENCES workspaces(id), source_path TEXT, started_at TEXT, ended_at TEXT, git_branch TEXT, title TEXT, message_count INTEGER, user_message_count INTEGER, summary TEXT, ingested_at TEXT
messages: id INTEGER PRIMARY KEY, session_id TEXT REFERENCES sessions(id), role TEXT (user|assistant), content TEXT, timestamp TEXT, sequence INTEGER, message_type TEXT (text|tool_use|tool_result)
tags: id INTEGER PRIMARY KEY, name TEXT UNIQUE, color TEXT, description TEXT, created_at TEXT
session_tags: session_id TEXT, tag_id INTEGER, added_at TEXT
session_files: id INTEGER PRIMARY KEY, session_id TEXT, file_path TEXT, file_name TEXT, operation TEXT (write|edit|read), timestamp TEXT, sequence INTEGER
insights: id INTEGER PRIMARY KEY, session_id TEXT REFERENCES sessions(id), type TEXT (correction|decision|gotcha|pattern|discovery|preference), content TEXT, canonical_form TEXT, canonical_hash TEXT, context TEXT, entities TEXT (JSON array), source TEXT (parent|subagent), observation_count INTEGER, score REAL, upvotes INTEGER, downvotes INTEGER, deleted_at TEXT, extracted_at TEXT, last_observed_at TEXT
insight_files: insight_id INTEGER, file_path TEXT — PRIMARY KEY (insight_id, file_path)
insight_sessions: insight_id INTEGER, session_id TEXT, extracted_at TEXT — junction table linking insights to all sessions where observed
messages_fts: FTS5 virtual table on messages.content — JOIN via messages_fts.rowid = messages.id

## Data Profile

- ${sessionCount} sessions across ${workspaceCount} workspaces, ${messageCount} messages
- Date range: ${dateRange}
- Dates are ISO 8601 strings. Use datetime() for comparisons.
- file_path contains absolute paths. Use LIKE '%pattern%' for matching.
- message_type values: 'text' (conversation), 'tool_use' (format: "ToolName: summary"), 'tool_result' (truncated first 500 chars)
- session_files.operation values: 'write' | 'edit' | 'read'
- Filter out image files (png/jpg/gif/webp/svg) from file queries unless asked.

## Query Recipes (use these patterns directly)

IMPORTANT: Messages with message_type = 'subagent_prompt' are internal agent-to-subagent prompts, NOT real user messages. Always exclude them: AND m.message_type != 'subagent_prompt'

Topic search (always use FTS5, not LIKE):
  SELECT DISTINCT s.id, s.title, s.started_at, s.summary, w.display_name
  FROM messages_fts fts
  JOIN messages m ON m.id = fts.rowid
  JOIN sessions s ON s.id = m.session_id
  JOIN workspaces w ON w.id = s.workspace_id
  WHERE messages_fts MATCH '"exact phrase" OR term1 AND term2'
  ORDER BY s.started_at DESC LIMIT 50

File search:
  SELECT DISTINCT s.id, sf.file_path, sf.operation
  FROM session_files sf JOIN sessions s ON s.id = sf.session_id
  WHERE sf.file_path LIKE '%pattern%' AND sf.operation IN ('write','edit')

Workspace sessions:
  SELECT s.id, s.title, s.started_at, s.message_count FROM sessions s
  JOIN workspaces w ON w.id = s.workspace_id
  WHERE w.display_name LIKE '%name%' ORDER BY s.started_at DESC

Time-bounded:
  SELECT s.id, s.title, s.started_at FROM sessions s
  WHERE s.started_at >= datetime('now', '-7 days') ORDER BY s.started_at DESC

Tool usage:
  SELECT * FROM messages WHERE message_type = 'tool_use' AND content LIKE 'ToolName:%'

Most frequent corrections:
  SELECT type, content, observation_count, score FROM insights
  WHERE type = 'correction' AND deleted_at IS NULL ORDER BY observation_count DESC LIMIT 20

Insights related to a topic:
  SELECT content, type, observation_count FROM insights
  WHERE content LIKE '%auth%' AND deleted_at IS NULL ORDER BY score DESC

Files with the most insights:
  SELECT file_path, COUNT(*) as count FROM insight_files
  JOIN insights i ON i.id = insight_files.insight_id WHERE i.deleted_at IS NULL
  GROUP BY file_path ORDER BY count DESC LIMIT 20

## Query Strategy

1. PLAN: From the user's question, determine which 1-2 queries will get the answer.
2. EXECUTE: Run them. Prefer a single well-crafted query over multiple exploratory ones.
3. ANSWER: Write your response immediately.

- Most questions need exactly 1 query. Complex questions need 2. Maximum 3.
- NEVER run exploratory queries to understand the data — the schema, data profile, and recipes above are complete.
- If a query returns 0 rows, try ONE broader alternative, then answer with what you have.
- A partial answer is ALWAYS better than more searching. Present what you found and note any caveats.
- LIMIT results: 50 for browsing, 200 for collecting session IDs.

## Response Rules

- Do NOT narrate your search process. The user sees your SQL queries in a separate UI element.
- NEVER write "Let me search...", "I found X results...", "Let me look at...", "Let me verify...", or "To be thorough..."
- Run your queries, then write a clean final answer. No preamble.

## Response Format

Write a concise answer (under 150 words):
1. **What matched** — count, workspaces, date range, key patterns.
2. **Notable sessions** — call out 2-3 interesting ones if helpful.

Then include a machine-readable result block when you have session IDs:

<result>
{"session_ids": ["id1", "id2", ...]}
</result>

To suggest an action (tag sessions), add an action field:
<result>
{"session_ids": ["id1", "id2", ...], "action": {"type": "add_tag", "tag_name": "my-tag"}}
</result>

Available actions: add_tag, remove_tag. Omit action if not requested.
Only include <result> when you have concrete session IDs.`;
}

const tools: Anthropic.Messages.Tool[] = [
  {
    name: "run_sql",
    description:
      "Execute a read-only SQL query against the session database. Returns rows as a JSON array. " +
      "Use this to answer the user's question directly — not to explore or understand the data. " +
      "The schema and query recipes in your instructions have everything you need.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "SQLite SELECT query" },
        params: {
          type: "array",
          description: "Bind parameters (optional)",
          items: { type: "string" },
        },
      },
      required: ["query"],
    },
  },
];

function executeSql(
  query: string,
  params: unknown[] = []
): { rows: unknown[] } | { error: string } {
  if (!/^\s*SELECT\b/i.test(query)) {
    return { error: "Only SELECT queries are allowed" };
  }
  try {
    const stmt = readDb.prepare(query);
    const rows = stmt.all(...params);
    return { rows };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: msg };
  }
}

function parseResult(
  content: string
): { session_ids: string[]; action?: { type: string; tag_name?: string; tag_color?: string; tag_id?: number } } | null {
  const match = content.match(/<result>\s*([\s\S]*?)\s*<\/result>/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

// SSE helper
function sendEvent(res: import("express").Response, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

router.post("/api/chat", async (req, res) => {
  try {
    const { messages } = req.body as {
      messages: Array<{ role: "user" | "assistant"; content: string }>;
    };

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({ error: "messages array is required" });
      return;
    }

    // Set up SSE
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    // Build the Anthropic messages format
    let anthropicMessages: Anthropic.Messages.MessageParam[] = messages.map(
      (m) => ({
        role: m.role,
        content: m.content,
      })
    );

    const systemPrompt = buildSystemPrompt();
    const queries: string[] = [];
    const maxIterations = config.chatMaxToolIterations;
    let fullText = "";

    for (let i = 0; i < maxIterations; i++) {
      // Stream each Claude call
      const stream = anthropic.messages.stream({
        model: config.chatModel,
        max_tokens: config.chatMaxTokens,
        system: systemPrompt,
        tools,
        messages: anthropicMessages,
      });

      // Accumulate text and tool uses from this round
      const toolUses: Anthropic.Messages.ToolUseBlock[] = [];
      let roundText = "";

      stream.on("text", (text) => {
        roundText += text;
        fullText += text;
        sendEvent(res, "text", { text });
      });

      const response = await stream.finalMessage();

      // Collect tool use blocks (not emitted via text event)
      for (const block of response.content) {
        if (block.type === "tool_use") {
          toolUses.push(block);
        }
      }

      if (toolUses.length === 0) {
        // No tool calls — done
        break;
      }

      // Execute tool calls, streaming each one
      anthropicMessages = [
        ...anthropicMessages,
        { role: "assistant" as const, content: response.content },
      ];

      const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
      for (const toolUse of toolUses) {
        const input = toolUse.input as { query: string; params?: unknown[] };
        queries.push(input.query);

        // Send query event so frontend can show it live
        sendEvent(res, "query", { query: input.query });

        const result = executeSql(input.query, input.params || []);
        const rowCount = "rows" in result ? result.rows.length : 0;

        // Send query result count
        sendEvent(res, "query_result", { query: input.query, row_count: rowCount });

        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: JSON.stringify(result),
        });
      }

      // Soft nudge after 3+ rounds of tool calls: ask the model to wrap up
      if (i >= 2) {
        anthropicMessages.push({
          role: "user" as const,
          content: [
            ...toolResults,
            { type: "text" as const, text: "You've run several queries. Please summarize your findings and provide your final answer now." },
          ],
        });
      } else {
        anthropicMessages.push({
          role: "user" as const,
          content: toolResults,
        });
      }

      // If last iteration, whatever text we got is all we'll get
      if (i === maxIterations - 1 && !roundText) {
        fullText += roundText;
      }
    }

    // Parse result block from accumulated text
    const result = parseResult(fullText);

    // Save to chat history
    try {
      const userQuery = [...messages].reverse().find((m) => m.role === "user")?.content || "";
      const displayText = fullText.replace(/<result>\s*[\s\S]*?\s*<\/result>/g, "").trim();
      const sessionIds = result?.session_ids || [];
      insertChatHistory.run(
        userQuery,
        displayText || null,
        sessionIds.length > 0 ? JSON.stringify(sessionIds) : null,
        sessionIds.length,
        queries.length > 0 ? JSON.stringify(queries) : null,
      );
    } catch (historyErr) {
      console.error("Failed to save chat history:", historyErr);
    }

    // Send final event with result and queries
    sendEvent(res, "done", {
      result: result || undefined,
      queries: queries.length > 0 ? queries : undefined,
    });

    res.end();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Chat error:", msg);
    // If headers already sent (SSE started), send error event
    if (res.headersSent) {
      sendEvent(res, "error", { error: msg });
      res.end();
    } else {
      res.status(500).json({ error: msg });
    }
  }
});

export { buildSystemPrompt, tools, executeSql, parseResult };
export default router;
