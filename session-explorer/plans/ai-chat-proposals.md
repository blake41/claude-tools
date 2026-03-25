# AI Chat + Proposals

Natural language query and batch-action layer for Session Explorer.

## Concept

A chat panel in the web UI talks to Claude, which has tool access to the
session database. Users describe what they want ("tag all sessions that edited
plans/v4 with v4-docs"), Claude queries the DB, finds matching sessions, and
the user reviews them in a familiar session list view before applying.

## The Elegant Insight

If AI-assisted querying was foundational, the whole app is a query interface
over session data. The sidebar filters by workspace. Tag pages filter by tag.
Search filters by content. The AI just builds queries in natural language.

This means:

1. **No new persistence model.** Claude returns session IDs + intended action.
   The frontend holds them in React state and renders them with existing
   components. Applying the action uses existing tag endpoints. No proposals
   table, no proposal items, no CRUD.

2. **One tool, not five.** Claude gets `run_sql` — a single read-only SQL
   tool with the full schema in the system prompt. No predefined query set
   to design or maintain. Claude composes any query it needs. This is simpler
   to build AND arbitrarily more powerful.

3. **The chat panel is the command center.** Claude's response includes
   structured data (session IDs + action). The main content area shows the
   result set using existing SessionCard components. The chat panel stays open
   as a slide-over for refinement ("exclude sessions before March 1st" →
   updated result set).

4. **After applying, navigate to the real thing.** Tag 14 sessions with
   v4-docs → apply → navigate to `/tag/5`. The tag page IS the permanent
   results view. No separate proposal page needed.

## Architecture

```
  Chat Panel (slide-over)         Main Content Area
       │                               │
  user message                    renders result set
  + conversation                  from chatResult state
       │                               │
       v                               │
  POST /api/chat                       │
       │                               │
  ┌────┴────┐                          │
  │  Claude  │ ── run_sql ───> db      │
  │ Sonnet   │    (read-only)          │
  └────┬────┘                          │
       │                               │
  returns:                             │
  { content, result }                  │
       │                               │
       v                               v
  setChatResult() ──────────> /results route renders
                              SessionCards + "Apply" button
                                       │
                                  on Apply:
                              POST /api/sessions/:id/tags
                              (existing endpoint, per session)
                                       │
                                  navigate to /tag/:id
```

## Plan

### Step 1: Chat Endpoint (`server/chat.ts`)

One file. Tool definitions, tool execution, and the endpoint.

**Endpoint:** `POST /api/chat`

```json
// Request
{ "messages": [{ "role": "user", "content": "..." }] }

// Response (streamed via SSE for progressive text)
{
  "role": "assistant",
  "content": "Found 14 sessions that edited files in plans/v4.",
  "result": {
    "session_ids": ["abc", "def", ...],
    "action": { "type": "add_tag", "tag_id": 5, "tag_name": "v4-docs" }
  }
}
```

**Tools** — Claude gets one tool: `run_sql`.

```typescript
{
  name: "run_sql",
  description: "Execute a read-only SQL query against the session database. Returns rows as JSON array. Use SELECT only — writes are blocked.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "SQLite SELECT query" },
      params: { type: "array", description: "Bind parameters (optional)", items: { type: "string" } }
    },
    required: ["query"]
  }
}
```

**Implementation** — 5 lines:

```typescript
function executeTool(query: string, params: any[] = []) {
  if (!/^\s*SELECT\b/i.test(query)) throw new Error("Only SELECT queries allowed");
  const stmt = db.prepare(query);
  return stmt.all(...params);
}
```

That's it. One tool definition, one executor. No predefined query set to
maintain. Claude composes any query it needs against the schema.

**Why one tool instead of five?** The 5 predefined tools encode assumptions
about what queries are useful. But the point of adding AI is to handle
queries you didn't anticipate. With `run_sql`:

- "sessions that touched both plans/v4 AND types.ts" — self-join
- "my busiest week this year" — GROUP BY strftime + COUNT
- "sessions with more than 20 messages from me" — WHERE on column
- "workspaces I haven't touched in 2 weeks" — date arithmetic
- Any combination of the above — just SQL

Each of these would require a new tool definition in the predefined approach.
With `run_sql`, they're all free.

**Safety:** The regex check blocks non-SELECT statements. For belt-and-
suspenders, open a second read-only db connection:
`new Database(DB_PATH, { readonly: true })`.

No `create_proposal` tool either. Claude returns structured data in its
response. The frontend parses the result and renders it. The "proposal"
is just React state: `{ sessionIds, action }`.

**System prompt sketch:**

```
You are an assistant for Session Explorer, a tool for browsing Claude Code
session history. You have direct SQL access to the SQLite database.

## Schema

workspaces: id, path, dir_name, display_name, session_count, last_activity
sessions: id (TEXT), workspace_id → workspaces, source_path, started_at,
          ended_at, git_branch, title, message_count, user_message_count,
          summary, ingested_at
messages: id, session_id → sessions, role (user|assistant), content,
          timestamp, sequence
tags: id, name (UNIQUE), color, description, created_at
session_tags: session_id → sessions, tag_id → tags, added_at (PK: both)
session_files: id, session_id → sessions, file_path, file_name,
              operation (write|edit|read), timestamp, sequence

## Guidelines

- Use run_sql to query the database. SELECT only.
- Dates are ISO 8601 strings. Use datetime() for comparisons.
- file_path contains full absolute paths. Use LIKE '%pattern%' for matching.
- Filter out image files (png/jpg/gif/webp/svg) from file queries.
- Return concise result counts, not raw data dumps.
- LIMIT large result sets to avoid token bloat.

## Returning results

When you have identified target sessions and an action, include a result
block in your response:

<result>
{"session_ids": [...], "action": {"type": "add_tag", "tag_name": "v4-docs"}}
</result>

Available actions: add_tag, remove_tag

If the tag doesn't exist yet, include tag_name and optionally tag_color.
The frontend will create it on apply.

For query-only requests (no action), omit the action field:

<result>
{"session_ids": [...]}
</result>
```

### Step 2: Chat Panel (`web/components/ChatPanel.tsx`)

Slide-over panel from the right. Overlays main content, doesn't push it.

- Message list (user + assistant bubbles)
- Text input at bottom
- Sends conversation history with each request (stateless server)
- Parses `<result>` blocks from assistant responses
- When a result is returned, calls `onResult(result)` to lift state to App

Simple. No markdown rendering needed — just text with maybe code formatting
for session IDs. Keep it minimal.

### Step 3: Results View (inline in `App.tsx`)

A new route `/results` — but it's not a separate component file. It's
defined inline in App.tsx, just like TagView and FileView already are.

Reads from `chatResult` state (lifted to App level):

```tsx
const [chatResult, setChatResult] = useState<ChatResult | null>(null);

// In Routes:
<Route path="/results" element={<ResultsView result={chatResult} />} />
```

ResultsView:
- Header: "Found 14 sessions" + action description ("Tag with v4-docs")
- Session list: grouped by workspace, using SessionCard (same as TagView)
- "Apply to all" button at top
- On apply: calls existing `POST /api/sessions/:id/tags` for each session
- After apply: navigates to `/tag/:id`

This is ~80 lines of JSX. It's TagView with a different data source and
an apply button.

### Step 4: Wire It Up

- `server/index.ts` — import and mount chat routes
- `web/App.tsx` — add chat panel state, toggle, /results route
- `web/components/Sidebar.tsx` — chat toggle button (icon next to search)
- `web/types.ts` — add ChatResult type

---

## What We're NOT Building

| Avoided | Why |
|---------|-----|
| `proposals` table | Frontend state is sufficient. The real artifact is the tag, not the proposal. |
| `proposal_items` table | Per-item accept/reject is over-designed. Refine with the AI instead. |
| Proposal CRUD endpoints | No proposals to CRUD. |
| `server/queries.ts` | No shared query layer needed. Claude writes its own SQL. |
| `server/tools.ts` | One tool (`run_sql`), defined inline in chat.ts. |
| 5 predefined tools | `run_sql` replaces them all and handles queries you didn't anticipate. |
| `ProposalView.tsx` | ResultsView is inline in App.tsx (~80 lines). |
| Proposal sidebar section | Nothing to list. Chat results are ephemeral. |

---

## File Changes

### New files
| File | Purpose |
|------|---------|
| `server/chat.ts` | Chat endpoint + tool definitions + tool execution |
| `web/components/ChatPanel.tsx` | Slide-over chat UI |

### Modified files
| File | Change |
|------|--------|
| `server/index.ts` | Mount chat routes (2 lines) |
| `web/App.tsx` | ChatResult state, chat panel toggle, /results route + inline ResultsView |
| `web/components/Sidebar.tsx` | Chat toggle button |
| `web/types.ts` | ChatResult + ChatMessage types |

2 new files. 4 modified files. 0 new tables.

---

## Key Decisions

**No new persistence.** The conversation lives in React state. The result set
lives in React state. The permanent artifact is the tag that gets applied.
If you want to redo it, just ask again — the conversation takes 5 seconds.

**One tool: `run_sql`.** Instead of designing 5 tools that encode assumptions
about useful queries, give Claude read-only SQL access and the schema.
Less code to write, no tool set to maintain, and arbitrarily more powerful.
Safety via SELECT-only regex + read-only db connection.

**Sonnet 4.6 for reasoning.** The chat agent needs to interpret intent,
decide which tools to call, and compose results. Haiku can't do this.
Sonnet is the right model.

**Refinement happens in conversation, not in UI.** Instead of checkboxes to
exclude individual sessions, the user tells the AI: "exclude sessions older
than last week." This is faster, more natural, and eliminates the need for
per-item state management.

---

## Future Extensions (not MVP)

- **SSE streaming** for progressive text display
- **Context injection** — tell Claude what page the user is on
- **Conversation persistence** — save chat history to sessionStorage
- **More actions** — remove_tag, bulk summarize, export
- **Query-only mode** — "show me sessions that touched auth" without any action

---

## Build Order

1. `server/chat.ts` — endpoint + tools + system prompt
2. `web/components/ChatPanel.tsx` — slide-over UI
3. ResultsView inline in `App.tsx` — render results + apply button
4. Wire up: mount routes, add toggle, add types
