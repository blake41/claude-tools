---
title: Session Explorer Insights Layer
date: 2026-04-06
origin: Conversation comparing Memory Lane (alexknowshtml gist) to Session Explorer
status: draft
---

# Session Explorer Insights Layer

## Overview

Add a passive insight extraction and browsing layer to Session Explorer. Background jobs extract learnings (corrections, decisions, patterns) from session transcripts, link them to files and entities, detect repeated patterns across sessions, and surface them in a browsable UI with feedback ranking. No hooks, no context injection — purely observational.

## Problem Frame

Claude Code's built-in auto-memory is manually curated and lives in flat markdown files. Session Explorer indexes full transcripts but doesn't extract structured learnings from them. Patterns that repeat across dozens of sessions (e.g., the same correction given 4 times in a month) are invisible — no single session reveals cross-session patterns. Memory Lane (alexknowshtml) solves this with PostgreSQL + pgvector + hooks, but that architecture injects into the workflow and requires heavy infrastructure. We want the analytical value without the workflow contamination.

## Design Constraints

1. **Passive** — operates on already-ingested session data, never injects into Claude Code sessions
2. **No new infrastructure** — SQLite only, no vector DB, no embeddings server
3. **Separate from summarization** — independent extraction job, different prompt, can re-run without re-summarizing
4. **Browsable UI** — insights are a first-class thing you can look at, not hidden metadata
5. **User controls relevance** — feedback (thumbs up/down) tunes what surfaces, extraction doesn't auto-act

## Requirements Trace

| Req | Description | Unit(s) |
|-----|-------------|---------|
| R1 | Extract typed insights from session transcripts | 1, 2 |
| R2 | Link insights to file paths and entities | 1, 2 |
| R3 | Detect repeated patterns across sessions (observation counting) | 3 |
| R4 | Tag insights from subagent sessions with provenance | 2 |
| R5 | Feedback mechanism (thumbs up/down) that affects ranking | 4 |
| R6 | Browsable UI for insights with filtering and ranking | 5 |
| R7 | Integrate insights into existing search and file views | 6 |

## Context

### Existing Infrastructure We Build On

- **Ingestion pipeline** (`server/ingest.ts`): Already parses JSONL, extracts messages, merges subagent sessions, tracks file operations. Insights extraction runs after this.
- **Summarization job** (`server/index.ts` POST `/api/workspaces/:id/summarize`): Pattern to follow — finds sessions needing work, queues with p-queue (5 concurrent), uses Claude Haiku. We'll mirror this pattern.
- **session_files table**: Already tracks file_path + operation per session. Entity resolution links insights to these.
- **messages table**: Full transcript with role, content, sequence, message_type. Source material for extraction.
- **FTS5 index** (messages_fts): Can search for correction/decision patterns across sessions to seed clustering.
- **Chat AI** (`server/chat.ts`): Has `run_sql` tool and `buildSystemPrompt()`. New tables automatically become queryable if we add them to the schema docs in the prompt.
- **Tags system**: Existing tag infrastructure. Insights could auto-suggest tags but shouldn't auto-apply.

### Subagent Handling

The ingestion pipeline already merges subagent messages into parent sessions with sequence offsets. However, there's no flag distinguishing which messages came from a subagent vs the parent. The strip function processes subagent JSONL files separately then merges — we can add a `source` field during merge to preserve provenance.

## Key Technical Decisions

### Insight Types

Six types, chosen for what's actually extractable from session transcripts and useful across sessions:

| Type | What It Captures | Example |
|------|-----------------|---------|
| `correction` | User correcting Claude's approach or output | "Don't use mocks for these tests" |
| `decision` | Explicit architectural or design decision made | "We'll use SQLite, not Postgres" |
| `pattern` | Recurring approach or workflow that worked | "Always run tsc on new files" |
| `discovery` | Something learned about the codebase or system | "The auth middleware stores tokens in X" |
| `gotcha` | A pitfall encountered and resolved | "git rebase swaps ours/theirs" |
| `preference` | User's stated preference for how things should work | "Use bun, not npm" |

Memory Lane uses 10 types. We use 6 because: `commitment` and `workflow_note` are subsets of `decision`; `confidence` is a metadata property not a type; `cross_agent` is a provenance flag not a type; `gap` is better handled by observation counting (repeated corrections = gap).

### No Vector Embeddings

Memory Lane uses pgvector with 1024-dim embeddings for semantic search. We skip this because:
- SQLite FTS5 on insight content + entity matching covers the main retrieval patterns
- The UI is browsable (not injected into context), so exact-match search is fine
- Avoids Ollama/embedding server dependency
- If semantic search becomes needed later, SQLite-vec exists as a drop-in

### Observation Counting via Content Hashing

To detect "you've said this 4 times," we need to cluster similar insights across sessions. Approach:

1. During extraction, Claude generates a `canonical_form` — a normalized, terse version of the insight (e.g., "use bun not npm for package management")
2. We store a hash of the canonical form
3. New insights check for existing insights with the same hash → increment observation count
4. Near-duplicates (different wording, same meaning) are harder — we handle this with a periodic "cluster" job that asks Claude to group similar insights

This avoids embeddings while still catching exact repeats. The clustering job catches fuzzy repeats on a slower cadence.

### Feedback Scoring

Simple multiplicative model, no ML:

```
display_score = base_score × feedback_multiplier × recency_factor

base_score = observation_count × type_weight
feedback_multiplier = 1.0 + (0.2 × net_upvotes)  // clamped to [0.1, 5.0]
recency_factor = 1.0 / (1.0 + days_since_last_observed × 0.01)
```

Type weights: `correction: 1.5, decision: 1.3, gotcha: 1.2, pattern: 1.0, discovery: 0.8, preference: 0.8`

Corrections weighted highest because they represent things Claude keeps getting wrong.

## Implementation Units

### Unit 1: Database Schema and Extraction Job

**Goal:** Add insights table, create the extraction background job that processes sessions and stores typed insights.

**Requirements:** R1, R2

**Dependencies:** None

**Files:**
- Modify `server/db.ts` — add tables and indexes
- Create `server/insights.ts` — extraction job logic
- Modify `server/index.ts` — add extraction API routes

**Approach:**

New tables:

```sql
-- Core insight storage
CREATE TABLE insights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  type TEXT NOT NULL,           -- correction, decision, pattern, discovery, gotcha, preference
  content TEXT NOT NULL,        -- human-readable description
  canonical_form TEXT,          -- normalized form for dedup
  canonical_hash TEXT,          -- hash of canonical_form
  context TEXT,                 -- surrounding conversation excerpt
  entities TEXT,                -- JSON array of { type, name, path? }
  source TEXT DEFAULT 'parent', -- 'parent' or 'subagent'
  observation_count INTEGER DEFAULT 1,
  score REAL DEFAULT 1.0,      -- computed display score
  upvotes INTEGER DEFAULT 0,
  downvotes INTEGER DEFAULT 0,
  extracted_at TEXT NOT NULL,
  last_observed_at TEXT NOT NULL
);

CREATE INDEX idx_insights_session ON insights(session_id);
CREATE INDEX idx_insights_type ON insights(type);
CREATE INDEX idx_insights_hash ON insights(canonical_hash);
CREATE INDEX idx_insights_score ON insights(score DESC);

-- Link insights to files (leverages existing session_files)
CREATE TABLE insight_files (
  insight_id INTEGER NOT NULL REFERENCES insights(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  PRIMARY KEY (insight_id, file_path)
);

CREATE INDEX idx_insight_files_path ON insight_files(file_path);

-- Track which sessions have been processed
ALTER TABLE sessions ADD COLUMN insights_extracted INTEGER DEFAULT 0;

-- Settings (key-value, for extraction interval etc.)
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);
```

Settings used:
- `extraction_interval_days` — how often auto-extraction runs (0 = manual only, default)
- `last_extraction_at` — ISO 8601 timestamp of last completed extraction run

Extraction job mirrors summarization pattern:
- Find sessions where `insights_extracted = 0` and `message_count > 5` (skip trivial sessions)
- Queue with p-queue (3 concurrent — extraction is heavier than summarization)
- For each session, send transcript to Claude with extraction prompt
- Parse response, insert insights, link to files from session_files
- Mark session as `insights_extracted = 1`
- On completion, update `last_extraction_at` setting

**Auto-extraction scheduling:**
After each ingestion run completes, check: if `extraction_interval_days > 0` and `now - last_extraction_at >= interval`, automatically trigger extraction for all workspaces. This piggybacks on ingestion (which already runs via launchd) rather than adding a separate scheduler. The interval is set from the UI (see Unit 5).

Extraction prompt shape (Claude Sonnet, not Haiku — needs reasoning):
- Receives: session messages (truncated to ~8k tokens if needed), list of files touched
- Returns: JSON array of insights with type, content, canonical_form, entities, relevant_files
- Instructed to only extract genuinely useful learnings, not summarize the session
- Told to generate canonical_form as a terse, normalized statement

API routes:
- `POST /api/workspaces/:id/extract-insights` — trigger extraction job
- `GET /api/workspaces/:id/extract-insights/status` — poll progress
- `DELETE /api/workspaces/:id/extract-insights` — cancel
- `GET /api/settings/extraction` — get current interval + last run time
- `PUT /api/settings/extraction` — set interval (body: `{ interval_days: number }`)

**Test scenarios:**
- Happy path: session with clear correction → insight extracted with correct type and entities
- Trivial session (< 5 messages) → skipped
- Session already extracted → skipped unless force flag
- Subagent messages present → source field set correctly
- Extraction prompt returns empty array → session marked extracted, no insights stored

**Verification:** Run extraction on a known session, verify insights appear in DB with correct types and entity links.

---

### Unit 2: Subagent Provenance Tracking

**Goal:** During ingestion, tag messages that came from subagent sessions so extraction can mark insight source.

**Requirements:** R4

**Dependencies:** Unit 1 (needs the source field)

**Files:**
- Modify `server/strip.ts` — add source tracking during subagent merge
- Modify `server/db.ts` — add `source` column to messages table
- Modify `server/ingest.ts` — pass source through during insert

**Approach:**

The current merge logic in `ingest.ts` combines subagent messages into the parent's message array with sequence offsets. We add a `source` field to `StrippedMessage`:

```typescript
interface StrippedMessage {
  // ... existing fields
  source: 'parent' | 'subagent';
  subagentId?: string;  // session ID of the subagent
}
```

During merge, subagent messages get `source: 'subagent'`. The messages table gets a new column:

```sql
ALTER TABLE messages ADD COLUMN source TEXT DEFAULT 'parent';
```

The extraction job in Unit 1 checks: if the insight was extracted from a message range where most messages are `source: 'subagent'`, mark the insight as `source: 'subagent'`.

**Test scenarios:**
- Session with subagents → messages correctly tagged
- Session without subagents → all messages tagged 'parent'
- Re-ingestion → source tags preserved correctly

**Verification:** Ingest a session known to have subagents, query messages table to verify source tags.

---

### Unit 3: Observation Counting and Clustering

**Goal:** Detect repeated insights across sessions via hash matching and periodic Claude-powered clustering.

**Requirements:** R3

**Dependencies:** Unit 1 (needs insights table populated)

**Files:**
- Modify `server/insights.ts` — add dedup logic during extraction, add clustering job
- Modify `server/index.ts` — add clustering API route

**Approach:**

**On extraction (real-time dedup):**
When inserting a new insight, check `canonical_hash`:
- If exact match exists: increment `observation_count` on existing insight, update `last_observed_at`, add the new session_id to a `insight_sessions` junction table (so we know all sessions that produced this insight), skip inserting duplicate
- If no match: insert as new insight

New junction table:
```sql
CREATE TABLE insight_sessions (
  insight_id INTEGER NOT NULL REFERENCES insights(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  extracted_at TEXT NOT NULL,
  PRIMARY KEY (insight_id, session_id)
);
```

This replaces the single `session_id` on insights — an insight with observation_count > 1 belongs to multiple sessions. The `insights.session_id` becomes `first_session_id` (the session that first produced this insight).

**Clustering job (periodic fuzzy dedup):**
- Triggered manually or on schedule
- Groups insights by type
- For each type, sends batches of insights (content + canonical_form) to Claude
- Claude identifies clusters of semantically equivalent insights
- Merges clusters: keep the best-worded version, sum observation counts, union session links
- This is the expensive operation — runs infrequently (weekly or on-demand)

API:
- `POST /api/insights/cluster` — trigger clustering
- `GET /api/insights/cluster/status` — poll

**Test scenarios:**
- Two sessions produce same correction (identical canonical_hash) → observation_count = 2
- Two sessions produce similar but not identical correction → separate until clustering merges them
- Clustering correctly merges near-duplicates and sums counts
- Clustering preserves the clearest wording as the surviving content

**Verification:** Extract insights from multiple sessions with known repeated corrections, verify counts aggregate.

---

### Unit 4: Feedback Mechanism

**Goal:** Thumbs up/down on insights that affects display ranking.

**Requirements:** R5

**Dependencies:** Unit 1 (needs insights table)

**Files:**
- Modify `server/index.ts` — add feedback API routes
- Modify `server/insights.ts` — add score recalculation

**Approach:**

API routes:
- `POST /api/insights/:id/upvote` — increment upvotes, recalculate score
- `POST /api/insights/:id/downvote` — increment downvotes, recalculate score
- `DELETE /api/insights/:id` — soft delete (set `deleted_at`, exclude from queries)

Score recalculation runs on every vote, using the formula from Key Technical Decisions above. Stored as a materialized `score` column for efficient sorting.

Type weights are stored in a config object in `insights.ts`, not in the DB — they're tuning knobs, not user data.

**Test scenarios:**
- Upvote increases score
- Downvote decreases score (but score floors at 0.1 × base, never disappears entirely)
- Delete removes from all query results
- Score ordering: high-observation + upvoted > low-observation + no-votes

**Verification:** Create insights, apply votes, verify score ordering matches expected ranking.

---

### Unit 5: Insights UI — Browse and Filter

**Goal:** New "Insights" page in Session Explorer where you can browse, filter, search, and give feedback on extracted insights.

**Requirements:** R6

**Dependencies:** Units 1, 3, 4

**Files:**
- Create `web/src/components/Insights.tsx` — main insights page
- Create `web/src/components/InsightCard.tsx` — individual insight display
- Modify `web/src/router.ts` — add `/insights` route
- Modify `web/src/components/Sidebar.tsx` — add insights nav item
- Modify `web/src/types.ts` — add insight types

**Approach:**

Route: `/insights` with optional query params `?type=correction&sort=score&file=path`

API routes (added to server/index.ts):
- `GET /api/insights` — list insights with pagination, filtering, sorting
  - Filters: `type`, `file_path` (LIKE match), `min_observations`, `source`, `workspace`
  - Sorts: `score` (default), `observation_count`, `extracted_at`, `last_observed_at`
- `GET /api/insights/:id` — single insight with all linked sessions and files
- `GET /api/insights/stats` — type distribution, total count, top files, extraction coverage

UI layout:

```
┌─────────────────────────────────────────────────┐
│ Insights                [Every ▾ 3 days] [Run Now] │
│                                                  │
│ ┌──────────┐ ┌──────┐ ┌──────┐ ┌─────────────┐ │
│ │ All (47) │ │ 🔴12 │ │ 🟡8  │ │ Filter: ___ │ │
│ └──────────┘ └──────┘ └──────┘ └─────────────┘ │
│                                                  │
│ ┌──────────────────────────────────────────────┐ │
│ │ correction × 4 sessions                  ▲ ▼ │ │
│ │ "Use bun, not npm for package management"    │ │
│ │ Files: package.json, scripts/install.sh      │ │
│ │ Last seen: 2 days ago                        │ │
│ └──────────────────────────────────────────────┘ │
│ ┌──────────────────────────────────────────────┐ │
│ │ decision × 1 session                     ▲ ▼ │ │
│ │ "SQLite for insights, no vector DB"          │ │
│ │ Files: server/db.ts                          │ │
│ │ Last seen: today                             │ │
│ └──────────────────────────────────────────────┘ │
│ ...                                              │
└─────────────────────────────────────────────────┘
```

Each InsightCard shows:
- Type badge (color-coded)
- Content text
- Observation count ("× N sessions") — clickable to see which sessions
- Linked files — clickable to file view
- Source badge if from subagent
- Last observed date
- Thumbs up / thumbs down buttons with current counts
- Expand to see context excerpt and session list

Filter bar:
- Type pills (all, correction, decision, pattern, discovery, gotcha, preference) with counts
- File path filter (text input with autocomplete from insight_files)
- Sort dropdown (relevance, observation count, recent, oldest)
- Source filter (all, parent, subagent)

**Test scenarios:**
- Empty state (no insights extracted yet) → shows prompt to run extraction
- Filters correctly narrow results
- Voting updates card inline without page reload
- Clicking session count expands to show linked sessions
- Clicking file navigates to file view

**Verification:** Browse insights after extraction, verify filtering/sorting/voting all work interactively.

---

### Unit 6: Integrate Insights into Existing Views

**Goal:** Surface relevant insights in session detail and file views — not a separate silo.

**Requirements:** R7

**Dependencies:** Units 1, 5

**Files:**
- Modify `web/src/components/SessionDetail.tsx` — add insights section
- Modify file view component — add insights for file path
- Modify `server/chat.ts` — add insights schema to `buildSystemPrompt()`

**Approach:**

**Session detail page:**
Add an "Insights" tab/section below the existing tags panel. Shows insights extracted from this session. If the session hasn't been extracted yet, show a subtle "Extract insights" button.

**File view (`/file?path=`):**
Add "Insights mentioning this file" section. Query `insight_files` by path. Shows all insights linked to this file across all sessions, ranked by score. This is the "open a file, see what happened" use case from entity resolution.

**Chat AI integration:**
Add the `insights` and `insight_files` table schemas to `buildSystemPrompt()` in `chat.ts`, with example queries:
- "What corrections have I made most often?" → `SELECT * FROM insights WHERE type='correction' ORDER BY observation_count DESC`
- "What insights relate to auth?" → `SELECT * FROM insights WHERE content LIKE '%auth%'`
- "Files with the most insights" → `SELECT file_path, COUNT(*) FROM insight_files GROUP BY file_path ORDER BY 2 DESC`

This makes insights queryable via the existing "Ask AI" chat with zero new UI — Claude just knows about the tables.

**Test scenarios:**
- Session detail shows extracted insights for that session
- File view shows cross-session insights for that file
- Chat AI can query insights table and return meaningful answers
- No insights extracted → graceful empty state, not errors

**Verification:** Navigate to a session with insights, verify they appear. Navigate to a file referenced by insights, verify cross-session insights show. Ask the chat "what corrections come up most?" and verify it queries the insights table.

---

## Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Extraction quality varies | Low-value insights clutter the UI | Feedback mechanism + manual delete. Tune extraction prompt iteratively. Start with correction/decision only, add other types once quality is proven. |
| Extraction cost | Sonnet per session adds up | Queue with concurrency limit. Skip short sessions (< 5 messages). Extract on-demand, not automatically on ingest. |
| Canonical hash collisions | Different insights merge incorrectly | Use full canonical_form text in hash, not truncated. Clustering job is the fuzzy layer — hash is exact only. |
| Clustering job merges wrong | Distinct insights collapsed | Clustering is manual/on-demand, results are reviewable. Can undo by re-extracting. |
| Schema migration on existing DB | Data loss during ALTER TABLE | SQLite ALTER TABLE ADD COLUMN is safe. New tables are additive. No destructive changes. |

## Open Questions

### Resolved During Planning

- **Extraction model:** Claude Sonnet (not Haiku — needs reasoning for quality extraction)
- **Storage:** SQLite only, no vector DB
- **Trigger:** On-demand, not automatic on ingest (user controls when extraction runs)
- **Dedup strategy:** Hash-based exact match + periodic Claude clustering for fuzzy

### Deferred to Implementation

- **Extraction prompt tuning:** The exact prompt will need iteration. Start with a conservative prompt that extracts fewer, higher-quality insights. Expand after seeing real results.
- **Transcript truncation strategy:** Long sessions need truncation before sending to Claude. Options: first/last N messages, user messages only, or sliding window. Test during implementation.
- **Clustering batch size:** How many insights per Claude call during clustering? Start with 50, adjust based on quality.
- **Auto-extraction interval UX:** Dropdown in the Insights page header — "Off", "Every 1 day", "Every 3 days", "Every 7 days". Stored in `settings` table, checked after ingestion completes.

## Sources

- Session Explorer codebase: `~/Documents/Development/tools/session-explorer/`
  - `server/db.ts` — existing schema
  - `server/ingest.ts` — ingestion pipeline
  - `server/strip.ts` — message extraction
  - `server/index.ts` — API routes, summarization job pattern
  - `server/chat.ts` — AI chat integration
  - `web/src/` — frontend routes and components
- Memory Lane gist: https://gist.github.com/alexknowshtml/ecf8ea9b265bc82a00650833e73e461f
