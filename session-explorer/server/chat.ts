import { Router } from "express";
import { Database } from "bun:sqlite";
import Anthropic from "@anthropic-ai/sdk";
import { DB_PATH } from "./db.js";
import { config } from "./config.js";

const router = Router();
const anthropic = new Anthropic();

// Read-only database connection for safety
const readDb = new Database(DB_PATH, { readonly: true });

const SYSTEM_PROMPT = `You are an assistant for Session Explorer, a tool for browsing Claude Code session history. You have direct SQL access to the SQLite database.

## Schema

workspaces: id INTEGER PRIMARY KEY, path TEXT, dir_name TEXT, display_name TEXT, session_count INTEGER, last_activity TEXT
sessions: id TEXT PRIMARY KEY, workspace_id INTEGER REFERENCES workspaces(id), source_path TEXT, started_at TEXT, ended_at TEXT, git_branch TEXT, title TEXT, message_count INTEGER, user_message_count INTEGER, summary TEXT, ingested_at TEXT
messages: id INTEGER PRIMARY KEY, session_id TEXT REFERENCES sessions(id), role TEXT (user|assistant), content TEXT, timestamp TEXT, sequence INTEGER, message_type TEXT (text|tool_use|tool_result) — text is conversation, tool_use is "ToolName: summary", tool_result is truncated output
tags: id INTEGER PRIMARY KEY, name TEXT UNIQUE, color TEXT, description TEXT, created_at TEXT
session_tags: session_id TEXT REFERENCES sessions(id), tag_id INTEGER REFERENCES tags(id), added_at TEXT (PK: both)
session_files: id INTEGER PRIMARY KEY, session_id TEXT REFERENCES sessions(id), file_path TEXT, file_name TEXT, operation TEXT (write|edit|read), timestamp TEXT, sequence INTEGER
audit_log: id INTEGER PRIMARY KEY, action TEXT, entity_type TEXT, entity_id TEXT, details TEXT (JSON), created_at TEXT

## Guidelines

- Use run_sql to query the database. SELECT only.
- Dates are ISO 8601 strings. Use datetime() for comparisons.
- file_path contains full absolute paths. Use LIKE '%pattern%' for matching.
- Filter out image files (png/jpg/gif/webp/svg) from file queries unless specifically asked about them.
- Return concise result counts, not raw data dumps.
- LIMIT large result sets to avoid token bloat. Use LIMIT 200 for session ID queries.
- When counting or summarizing, query for the data first, then describe what you found.
- For full-text search on message content, use the FTS5 table: SELECT m.* FROM messages m JOIN messages_fts fts ON m.id = fts.rowid WHERE messages_fts MATCH 'search terms'. This is much faster than LIKE.
- FTS5 supports phrase queries ("exact phrase"), AND/OR operators, and prefix queries (term*).
- For tool usage, query: SELECT * FROM messages WHERE message_type = 'tool_use' — content format is "ToolName: summary".
- For tool results/output, query: SELECT * FROM messages WHERE message_type = 'tool_result' — content is truncated first 500 chars of output.

## Response format

Your response has TWO parts: an explanation for the human, then a machine-readable result block.

### Explanation (required)

Write a clear, concise explanation of what you found and WHY. Structure it like this:

1. **Search strategy** — One sentence: what you searched for and how (e.g. "Searched for sessions with file edits matching \`plans/v4\`")
2. **What matched** — Summarize the results in 1-3 sentences. Mention key patterns: how many sessions, which workspaces, what date range, what branches.
3. **Notable sessions** — If helpful, call out 2-3 interesting sessions by title/date with a brief note on why they stand out.

RULES for the explanation:
- NEVER dump raw query results, tables, or long lists. The UI already shows each session as a card.
- Use markdown: **bold** for emphasis, \`code\` for file paths/SQL, bullet lists for patterns.
- Keep it under 150 words. Be a thoughtful analyst, not a data printer.

### Result block

When you have identified target sessions and/or an action, include a result block:

<result>
{"session_ids": ["id1", "id2", ...], "action": {"type": "add_tag", "tag_name": "my-tag"}}
</result>

Available actions: add_tag, remove_tag

If the tag doesn't exist yet, include tag_name and optionally tag_color. If the tag exists, include tag_id.
The frontend will create the tag on apply if needed.

For query-only requests (no action needed), you can still return session IDs so the user can browse them:

<result>
{"session_ids": ["id1", "id2", ...]}
</result>

Only include the result block when you have concrete session IDs to show. For general questions or counts, just answer in text.`;

const tools: Anthropic.Messages.Tool[] = [
  {
    name: "run_sql",
    description:
      "Execute a read-only SQL query against the session database. Returns rows as a JSON array. Use SELECT only -- writes are blocked.",
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

    const queries: string[] = [];
    const maxIterations = config.chatMaxToolIterations;
    let fullText = "";

    for (let i = 0; i < maxIterations; i++) {
      // Stream each Claude call
      const stream = anthropic.messages.stream({
        model: config.chatModel,
        max_tokens: config.chatMaxTokens,
        system: SYSTEM_PROMPT,
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

      anthropicMessages.push({
        role: "user" as const,
        content: toolResults,
      });

      // If last iteration, whatever text we got is all we'll get
      if (i === maxIterations - 1 && !roundText) {
        fullText += roundText;
      }
    }

    // Parse result block from accumulated text
    const result = parseResult(fullText);

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

export { SYSTEM_PROMPT, tools, executeSql, parseResult };
export default router;
