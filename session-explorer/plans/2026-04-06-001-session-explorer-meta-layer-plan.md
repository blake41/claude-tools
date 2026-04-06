---
title: Session Explorer Meta Layer
date: 2026-04-06
origin: conversation (cognee research + session-explorer architecture review)
status: draft
---

# Session Explorer Meta Layer

## Overview

Extend session-explorer with a self-improving meta layer that watches Claude Code sessions and surfaces actionable suggestions across six dimensions: session scoring, skill amendment, skill discovery, pattern detection, workflow critique, and knowledge gaps. All suggestions go through a review UI — nothing auto-applies.

## Problem Frame

Claude Code sessions contain rich signal about what works and what doesn't — tool efficiency, repeated mistakes, missing skills, knowledge that should be in memory. Today this data is indexed (CASS) and partially analyzed (insights extraction), but nobody is systematically reviewing it to improve the workflow. The user wants a background process that does this analysis and surfaces suggestions for human review.

## Requirements

- **R1**: Score sessions on multiple quality axes (efficiency, convergence, verification, architecture)
- **R2**: Propose amendments to existing SKILL.md files when performance is poor or mediocre
- **R3**: Suggest new skills when repeated manual patterns are detected
- **R4**: Detect cross-session patterns (recurring blockers, repeated failures in the same domain)
- **R5**: Critique workflow gaps (pipeline steps that get skipped, tools that aren't being used)
- **R6**: Flag knowledge gaps (questions asked repeatedly that should be in memory)
- **R7**: All suggestions surfaced in a review UI with approve/reject/defer
- **R8**: Three trigger modes: manual CLI, cron schedule, post-session hook — user configurable
- **R9**: Approved skill amendments create a git branch (user reviews diff before merging)
- **R10**: Built in TypeScript, extends existing session-explorer codebase

## Scope Boundaries

**In scope:**
- All six analysis layers
- Review UI integrated into session-explorer's React app
- CLI commands for manual triggers
- Configurable trigger modes
- Git branch creation for approved skill amendments

**Out of scope:**
- Auto-applying any changes (always human-in-the-loop)
- Graph database (SQLite is sufficient)
- MCP server integration (CLI + web UI only for v1)
- Analyzing non-Claude-Code agent sessions (CASS supports others, but we focus on Claude Code)

## Context

### Existing Architecture (session-explorer)

- **Backend**: Express.js + Bun + SQLite (WAL mode) at `~/Documents/Development/tools/session-explorer/`
- **Frontend**: React 18 + TanStack Router + Tailwind CSS 4 + Vite
- **Data**: Sessions ingested from `~/.claude/projects/` JSONL files
- **Insights engine**: Already extracts corrections, decisions, gotchas, patterns, discoveries, preferences per session with deduplication via canonical hash
- **Background jobs**: `BackgroundJob` queue with concurrency control, status polling, cancellation
- **Ports**: Backend 5198, Frontend 5199
- **Auto-poll**: 60-second loop: ingest → summarize → extract insights

### Session Data Available

Each session JSONL contains:
- User messages, assistant responses (with thinking blocks)
- Tool calls (name, input, output) — Read, Write, Edit, Bash, Glob, Grep, Agent, etc.
- Token usage (input, cache_creation, cache_read)
- Timestamps, git branch, working directory
- Subagent conversations (isSidechain: true)
- File history snapshots

### Claude Code Skills Format

Located at `~/.claude/skills/*/SKILL.md`:
```yaml
---
name: skill-id
description: "What it does"
triggers:
  - trigger phrase
allowed-tools: [Bash, Read, Write]
---
# Skill body (markdown instructions)
```

### Cognee's Architecture (inspiration, not dependency)

Four-step loop we're adapting:
1. **Evaluate** — Score output on usefulness (not instruction adherence)
2. **Inspect** — Classify failure root cause into categories
3. **Preview amendify** — Generate proposed improvement
4. **Apply/rollback** — With mandatory review gate

Our improvements over cognee:
- Diff-based amendments (not full rewrites)
- Mediocrity detection (not just failure inspection)
- Richer evaluation context (tool trace, token usage, retry count)
- Domain-specific failure categories for Claude Code
- Six layers instead of just skill amendment

## Key Technical Decisions

### 1. SQLite tables, not a separate database

All meta layer data lives in session-explorer's existing `sessions.db`. The insights engine already demonstrates this pattern. New tables extend the schema.

**Rationale**: Single source of truth, existing backup/migration patterns, joins across session and meta data.

### 2. Structured event extraction before LLM analysis

Before sending sessions to Claude for scoring/analysis, extract a lightweight structured event stream from the JSONL:

```typescript
interface SessionEvent {
  type: 'tool_call' | 'error' | 'retry' | 'user_correction' | 'subagent_spawn' | 'skill_invocation';
  tool?: string;
  target_file?: string;
  success: boolean;
  retry_of?: string; // links to previous failed attempt
  token_cost?: number;
  timestamp: string;
}
```

**Rationale**: LLM analysis on raw transcripts is expensive and noisy. Structured events enable both programmatic pattern detection (frequency counting, sequence analysis) and focused LLM analysis (pass events + context, not full transcript).

### 3. Scoring is multi-axis, not a single number

Five axes, each 1-5:

| Axis | What it measures |
|------|-----------------|
| **Tool efficiency** | Calls made vs minimum plausible. Penalize redundant reads, grep-then-read cycles, bash for things with dedicated tools. |
| **Fix convergence** | Attempts per fix. 5 = first try, 3 = two attempts, 1 = three+ (aligns with "after 2 failed fixes, STOP" rule). |
| **Context discipline** | Appropriate delegation to subagents, no re-reading files already in context, main thread kept clean. |
| **Verification rigor** | Ran tsc/tests/linter before declaring done. Binary penalty for skipping. |
| **Architectural alignment** | Followed existing patterns vs created parallel structures. Used existing components vs built alongside. |

Composite score = weighted average (verification 2x, convergence 2x, others 1x).

**Rationale**: A single score hides what's actually wrong. Multi-axis scoring enables targeted suggestions ("your verification is consistently weak" vs "score: 0.6").

### 4. Diff-based skill amendments

Amendments are generated as targeted changes with evidence, not full rewrites:

```typescript
interface SkillAmendment {
  skill_path: string;
  sections_changed: Array<{
    location: string; // e.g. "## Phase 2: Research" or line range
    current_text: string;
    proposed_text: string;
    reason: string;
  }>;
  evidence_session_ids: string[];
  confidence: number;
  expected_improvement: string;
}
```

**Rationale**: Full rewrites lose carefully tuned phrasing. Diffs are reviewable, composable, and preserve what works.

### 5. Trigger modes stored in settings table

Use session-explorer's existing `settings` key-value table:

```
meta_trigger_mode = "manual" | "cron" | "hook" | "cron+hook"
meta_cron_interval_hours = 24
meta_hook_enabled = true
```

Hook mode: a post-session shell script that calls `curl -X POST http://localhost:5198/api/meta/analyze` with the session ID.

**Rationale**: Reuses existing settings infrastructure. Hook is just an HTTP call — no process management complexity.

### 6. Git branch for approved skill amendments

When user approves a skill amendment in the review UI:
1. Create branch `meta/amend-<skill-name>-<date>` in the skills repo (or `~/.claude/`)
2. Apply the diff to SKILL.md
3. Commit with message describing the change and evidence
4. Show the user the branch name — they merge when ready

**Rationale**: User asked for option (b). Git branch gives full review + rollback safety without manual copy-paste.

## Implementation Units

### Unit 1: Schema & Event Extraction

**Goal**: Add meta layer tables to SQLite and build the structured event extractor that converts raw session JSONL into analyzable events.

**Requirements**: Foundation for R1-R6

**Dependencies**: None

**Files**:
- Modify `server/db.ts` — add new tables
- Create `server/meta/events.ts` — event extraction from session messages
- Create `server/meta/types.ts` — shared types for meta layer

**New tables**:

```sql
-- Session quality scores
CREATE TABLE session_scores (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  tool_efficiency REAL,      -- 1-5
  fix_convergence REAL,      -- 1-5
  context_discipline REAL,   -- 1-5
  verification_rigor REAL,   -- 1-5
  architectural_alignment REAL, -- 1-5
  composite_score REAL,      -- weighted average
  raw_event_count INTEGER,
  scored_at TEXT NOT NULL,
  UNIQUE(session_id)
);

-- Proposals (all six layers output to this single queue)
CREATE TABLE proposals (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL, -- 'skill_amendment' | 'new_skill' | 'pattern' | 'workflow_critique' | 'knowledge_gap'
  status TEXT NOT NULL DEFAULT 'proposed', -- 'proposed' | 'approved' | 'rejected' | 'deferred'
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  detail TEXT NOT NULL, -- JSON: full proposal payload (amendment diff, skill draft, etc.)
  evidence_session_ids TEXT NOT NULL, -- JSON array of session IDs
  confidence REAL NOT NULL,
  score_impact TEXT, -- which scoring axes this addresses
  created_at TEXT NOT NULL,
  reviewed_at TEXT,
  review_note TEXT, -- user's reason for reject/defer
  applied_at TEXT,
  applied_ref TEXT, -- git branch name or commit SHA
  UNIQUE(type, title) -- prevent duplicate proposals
);

-- Analysis runs (audit trail)
CREATE TABLE meta_runs (
  id INTEGER PRIMARY KEY,
  trigger TEXT NOT NULL, -- 'manual' | 'cron' | 'hook'
  started_at TEXT NOT NULL,
  completed_at TEXT,
  sessions_analyzed INTEGER,
  proposals_created INTEGER,
  error TEXT
);

-- Structured events extracted from sessions (for programmatic analysis)
CREATE TABLE session_events (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL, -- 'tool_call' | 'error' | 'retry' | 'user_correction' | 'subagent_spawn' | 'skill_invocation'
  tool TEXT,
  target_file TEXT,
  success INTEGER NOT NULL DEFAULT 1,
  token_cost INTEGER,
  timestamp TEXT NOT NULL,
  metadata TEXT, -- JSON: extra context per event type
  UNIQUE(session_id, sequence)
);
CREATE INDEX idx_session_events_session ON session_events(session_id);
CREATE INDEX idx_session_events_type ON session_events(type);

CREATE INDEX idx_session_scores_composite ON session_scores(composite_score);
CREATE INDEX idx_proposals_status ON proposals(status);
CREATE INDEX idx_proposals_type ON proposals(type);
CREATE INDEX idx_meta_runs_started ON meta_runs(started_at);
```

**Approach**:

Event extraction parses session messages (already in the `messages` table) and extracts structured events:
- Tool calls → `tool_call` events (parse assistant message content for tool_use blocks)
- Errors in tool results → `error` events
- Same tool+file called again after error → `retry` event
- User saying "no", "don't", "stop", "wrong" → `user_correction` event
- Agent tool calls → `subagent_spawn` events
- Skill tool invocations → `skill_invocation` events

This runs as part of ingestion — after messages are stored, events are extracted.

**Test scenarios**:
- Happy path: Session with mixed tool calls, errors, retries → correct event sequence
- Edge case: Session with only user messages (no tool calls) → empty events, no crash
- Edge case: Subagent sessions (isSidechain) → events tagged with source
- Error: Malformed message content → skip gracefully, log warning

**Verification**: Query `session_events` table after ingesting a known session, verify event types and counts match manual inspection.

---

### Unit 2: Session Scoring (Layer 1)

**Goal**: Score sessions across five quality axes using a combination of programmatic rules and LLM evaluation.

**Requirements**: R1

**Dependencies**: Unit 1 (needs session_events)

**Files**:
- Create `server/meta/scoring.ts` — scoring engine
- Create `server/meta/prompts.ts` — all LLM prompts for the meta layer
- Modify `server/index.ts` — add scoring API routes

**Approach**:

Two-phase scoring:

**Phase 1 — Programmatic (no LLM, instant)**:
- **Tool efficiency**: Count tool calls. Flag redundant reads (same file read 2+ times without edit between). Flag bash used for grep/read/write. Flag grep→read→grep cycles. Score = 5 - penalty (clamped to 1-5).
- **Fix convergence**: Count retry events. Group by target_file. Score per-file, average across session.
- **Verification rigor**: Check if tsc/test/lint commands appear in tool calls after the last edit. Binary: 5 if present, 1 if absent.

**Phase 2 — LLM (Claude Haiku for cost, batched)**:
- **Context discipline**: Send event summary + subagent spawn count + main thread tool count. Ask: "Did this session delegate appropriately?"
- **Architectural alignment**: Send file list + edit diffs. Ask: "Did this session follow existing patterns or create parallel structures?"

Composite = (tool_efficiency + fix_convergence×2 + context_discipline + verification_rigor×2 + architectural_alignment) / 7

**API routes**:
```
POST /api/meta/score/:sessionId     — Score a single session
POST /api/meta/score-batch          — Score unscored sessions (background job)
GET  /api/meta/scores               — List scored sessions (sortable, filterable)
GET  /api/meta/scores/trends        — Aggregate scores over time
```

**Test scenarios**:
- Happy path: Session with clean first-try implementation → high scores
- Happy path: Session with 5 retries and no tsc → low convergence + verification
- Edge case: Very short session (1-2 messages) → skip scoring, mark as "insufficient data"
- Edge case: Session that's all subagent work → context discipline should score high

**Verification**: Score 10 recent sessions manually, compare to automated scores. Spot-check LLM evaluations for sanity.

---

### Unit 3: Skill Amendment (Layer 2)

**Goal**: Identify underperforming skills and propose targeted amendments based on session evidence.

**Requirements**: R2, R9

**Dependencies**: Unit 2 (needs session_scores), Unit 1 (needs skill_invocation events)

**Files**:
- Create `server/meta/skill-amendment.ts` — inspect + amendify pipeline
- Add to `server/meta/prompts.ts` — inspection and amendment prompts
- Create `server/meta/git.ts` — git branch creation for approved amendments

**Approach**:

**Step 1 — Identify candidates**: Query skill_invocation events joined with session_scores. Group by skill name. Flag skills where:
- Average session score < 3.5 (underperforming)
- Average session score 3.5-4.0 with 5+ invocations (mediocre but frequent — high impact)
- Any session score < 2.0 (acute failure)

**Step 2 — Inspect** (LLM call): For each candidate skill, send:
- The SKILL.md content (read from disk)
- Session events from the low-scoring sessions where this skill was invoked
- User corrections from those sessions
- The specific scoring axes that were weak

Domain-specific failure categories (not cognee's generic ones):
```
instruction_gap        — skill doesn't cover a scenario the user hits
verification_missing   — skill doesn't enforce tsc/test/lint
delegation_unclear     — skill doesn't specify when to use subagents
context_overload       — skill instructions are too long, causing context waste
pattern_violation      — skill contradicts codebase conventions (CLAUDE.md rules)
tool_misuse           — skill uses wrong tools for the job
scope_creep           — skill does too much, should be split
```

**Step 3 — Preview amendment**: Generate diff-based amendment with evidence. Insert into `proposals` table with `status: 'proposed'`.

**Step 4 — Apply** (on user approval): Read SKILL.md → apply diff → create git branch → commit.

**Git integration** (`server/meta/git.ts`):
```typescript
async function createAmendmentBranch(
  skillPath: string,
  amendment: SkillAmendment
): Promise<string> {
  // 1. Determine repo root for skillPath
  // 2. Create branch: meta/amend-<skill-name>-<YYYYMMDD>
  // 3. Apply diff to SKILL.md
  // 4. Commit with message + evidence session IDs
  // 5. Return branch name
}
```

**Test scenarios**:
- Happy path: Skill with 3 low-scoring sessions → inspection identifies instruction_gap → amendment adds missing section
- Edge case: Skill with high scores everywhere → no proposal generated
- Edge case: Skill invoked once → below min_invocations threshold, skip
- Error: SKILL.md doesn't exist on disk (deleted since last session) → skip, log warning

**Verification**: Run amendment pipeline on 3 known underperforming skills. Review generated diffs for quality. Verify git branch creation works.

---

### Unit 4: Skill Discovery, Pattern Detection, Workflow Critique, Knowledge Gaps (Layers 3-6)

**Goal**: Analyze sessions for new skill opportunities, recurring patterns, workflow gaps, and missing memory entries.

**Requirements**: R3, R4, R5, R6

**Dependencies**: Unit 1 (needs session_events), Unit 2 (needs session_scores)

**Files**:
- Create `server/meta/discovery.ts` — new skill suggestions
- Create `server/meta/patterns.ts` — cross-session pattern detection
- Create `server/meta/workflow.ts` — workflow critique
- Create `server/meta/knowledge.ts` — knowledge gap detection
- Add prompts to `server/meta/prompts.ts`

**Approach**:

**Layer 3 — Skill Discovery** (`discovery.ts`):

Programmatic pre-filter: Find sessions where the user repeatedly gives the same class of instruction without a skill invocation. Cluster user_correction events and manual multi-step sequences.

LLM analysis: Send clustered patterns to Claude. Ask: "These manual sequences appear across N sessions. Should any become a reusable skill?" Output: skill name, description, draft SKILL.md, evidence sessions.

Insert into `proposals` table with `type: 'new_skill'`.

**Layer 4 — Pattern Detection** (`patterns.ts`):

Build on existing insights engine. The insights table already has `type: 'correction' | 'gotcha' | 'pattern'` with observation counts. Extend with cross-session analysis:

1. Query insights with observation_count >= 3
2. Group by canonical_hash and entity overlap
3. LLM synthesis: "These N insights across M sessions point to a recurring issue. Summarize the pattern and suggest a fix."

Output: pattern title, description, affected files/domains, suggested action, evidence sessions.

**Layer 5 — Workflow Critique** (`workflow.ts`):

Programmatic checks against known rules (from CLAUDE.md):
- Sessions that edit files without running tsc/tests afterward
- Sessions that don't verify before declaring done
- Sessions that use bash for grep/read/write
- Sessions that don't delegate to subagents when they should (>5 tool calls in sequence on main thread)
- Sessions where /ship was invoked but phases were skipped

LLM analysis for subjective critiques: Send session event summary + CLAUDE.md rules. Ask: "What workflow improvements would have made this session better?"

**Layer 6 — Knowledge Gaps** (`knowledge.ts`):

Programmatic detection:
1. Extract questions from user messages (messages containing "?", "how do I", "where is", "what's the")
2. Fuzzy-match questions across sessions (Levenshtein or embedding similarity)
3. Questions asked 3+ times across different sessions → knowledge gap candidate

LLM synthesis: "This question has been asked N times. Draft a memory entry (following the user's memory system format) that would prevent re-asking."

Output: memory file name, frontmatter, content, evidence sessions. Insert into proposals with `type: 'knowledge_gap'`.

**Test scenarios**:
- Discovery: 5 sessions where user manually runs the same 4-step sequence → skill proposal generated
- Pattern: Insight "prisma migration ordering" observed in 4 sessions → pattern surfaced
- Workflow: Session edits 8 files, never runs tsc → workflow critique generated
- Knowledge: "where are the Render service IDs?" asked in 3 sessions → memory entry proposed
- Edge case: Session with no user questions → knowledge gap layer produces nothing

**Verification**: Run all four analyzers on the last 50 sessions. Review proposals for signal-to-noise ratio. Tune thresholds based on results.

---

### Unit 5: Analysis Orchestrator & Trigger System

**Goal**: Wire all six analyzers into a single orchestration layer with configurable triggers.

**Requirements**: R8

**Dependencies**: Units 1-4

**Files**:
- Create `server/meta/orchestrator.ts` — runs all analyzers in sequence
- Create `server/meta/triggers.ts` — cron and hook setup
- Modify `server/index.ts` — add meta API routes and trigger initialization

**Approach**:

**Orchestrator** (`orchestrator.ts`):
```typescript
async function runMetaAnalysis(opts: {
  trigger: 'manual' | 'cron' | 'hook';
  sessionIds?: string[]; // if hook trigger, analyze specific sessions
  since?: string; // if cron/manual, analyze sessions since this date
}): Promise<MetaRunResult>
```

Pipeline:
1. Insert `meta_runs` row with `started_at`
2. Extract events for target sessions (skip if already extracted)
3. Score target sessions (skip if already scored)
4. Run all six analyzers in parallel (they read from events/scores, don't conflict)
5. Deduplicate proposals against existing proposals (same type + title)
6. Update `meta_runs` with completion stats
7. Return summary

**Trigger modes**:

- **Manual**: `POST /api/meta/analyze` with optional `since` parameter
- **Cron**: `setInterval` in server startup, configurable via settings table. Default: disabled.
- **Hook**: `POST /api/meta/analyze/session/:sessionId` — lightweight endpoint for post-session hook. The hook script:

```bash
#!/bin/bash
# ~/.claude/hooks/post-session.sh
SESSION_ID=$(cat ~/.claude/sessions/$PPID.json | jq -r '.sessionId')
curl -s -X POST "http://localhost:5198/api/meta/analyze/session/$SESSION_ID"
```

**Settings API**:
```
GET  /api/meta/settings          — current trigger config
PUT  /api/meta/settings          — update trigger config
POST /api/meta/analyze           — manual trigger
POST /api/meta/analyze/session/:id — hook trigger (single session)
GET  /api/meta/runs              — analysis run history
GET  /api/meta/runs/:id          — run detail (proposals generated)
```

**Test scenarios**:
- Happy path: Manual trigger analyzes last 7 days → proposals created for each layer
- Happy path: Hook trigger with single session ID → fast analysis, 1-2 proposals
- Edge case: Cron fires but no new sessions since last run → short-circuits, no LLM calls
- Edge case: Two triggers fire simultaneously → orchestrator uses mutex, second waits
- Error: LLM call fails mid-analysis → partial results saved, error logged in meta_runs

**Verification**: Test each trigger mode. Verify deduplication (run twice, no duplicate proposals). Check meta_runs audit trail.

---

### Unit 6: Review UI

**Goal**: React pages for reviewing proposals, browsing scores, and configuring triggers.

**Requirements**: R7

**Dependencies**: Units 1-5 (needs all API routes)

**Files**:
- Create `web/components/MetaDashboard.tsx` — overview page
- Create `web/components/ProposalQueue.tsx` — review queue
- Create `web/components/ProposalDetail.tsx` — single proposal review
- Create `web/components/ScoreTrends.tsx` — session score visualization
- Create `web/components/MetaSettings.tsx` — trigger configuration
- Modify `web/router.ts` — add meta routes
- Modify `web/components/Sidebar.tsx` — add meta navigation

**Routes**:
```
/meta                  → MetaDashboard (overview: pending proposals, score trends, recent runs)
/meta/proposals        → ProposalQueue (filterable by type, status)
/meta/proposals/:id    → ProposalDetail (full detail, approve/reject/defer)
/meta/scores           → ScoreTrends (charts, per-axis breakdown, workspace comparison)
/meta/settings         → MetaSettings (trigger mode, cron interval, thresholds)
```

**MetaDashboard**:
- Pending proposal count by type (badges)
- Composite score trend line (last 30 days)
- Recent analysis runs with status
- Quick links to filtered proposal views

**ProposalQueue**:
- Filter by type (skill_amendment, new_skill, pattern, workflow_critique, knowledge_gap)
- Filter by status (proposed, approved, rejected, deferred)
- Sort by confidence, date, score impact
- Bulk actions (approve all high-confidence, defer all low-confidence)

**ProposalDetail** (varies by type):
- **Skill amendment**: Side-by-side diff of current vs proposed SKILL.md. Evidence: links to sessions that triggered the amendment. Approve button creates git branch.
- **New skill**: Draft SKILL.md preview. Evidence sessions. Approve button writes SKILL.md to disk.
- **Pattern**: Pattern description + affected domains + evidence sessions. Approve archives it (acknowledged). No code change.
- **Workflow critique**: Description + specific sessions + suggested change. Approve archives it.
- **Knowledge gap**: Draft memory entry preview. Approve writes to `~/.claude/projects/.../memory/`.

**ScoreTrends**:
- Line chart: composite score over time
- Radar chart: per-axis breakdown for selected session
- Heatmap: score by workspace (which projects have the worst sessions?)
- Table: lowest-scoring sessions with links

**MetaSettings**:
- Trigger mode toggle (manual / cron / hook / cron+hook)
- Cron interval slider (hours)
- Hook setup instructions (copy-pasteable script)
- Scoring thresholds (what counts as "underperforming")
- Min invocations before skill amendment

**Test scenarios**:
- Happy path: User opens /meta, sees 5 pending proposals, reviews and approves a skill amendment → git branch created
- Happy path: User rejects a knowledge gap proposal with note "already in CLAUDE.md" → proposal marked rejected, note saved
- Happy path: User defers a workflow critique → disappears from active queue, visible under "deferred" filter
- Edge case: No proposals yet → empty state with "Run analysis" CTA
- Edge case: Proposal for skill that was already amended → show "superseded" status

**Verification**: Manual walkthrough of all proposal types. Verify approve/reject/defer flows. Check git branch creation from UI. Verify settings changes take effect on next analysis run.

---

## Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| LLM costs for scoring all sessions | High API spend if many sessions | Score on-demand or batch recent only. Haiku for programmatic axes, Sonnet only for subjective ones. |
| Noisy proposals (too many low-value suggestions) | User ignores the tool | Confidence threshold (default 0.7). Dismissed proposals suppress re-suggestion. Tune after first 50 proposals. |
| Skill amendment diffs don't apply cleanly | Amendment references stale SKILL.md content | Read SKILL.md at apply time, not proposal time. If content changed, re-generate amendment. |
| Event extraction misclassifies tool calls | Scoring is wrong | Validate against 10 manually-inspected sessions before trusting. Add escape hatch to re-extract. |
| Session-explorer server becomes slow with meta tables | Slow page loads | Index meta tables properly. Meta analysis runs as background job, doesn't block main queries. |

## Sources

- Session explorer codebase: `~/Documents/Development/tools/session-explorer/`
- Cognee skills system: `cognee/cognee_skills/` on tag `v0.5.4rc1`
- Cognee blog: cognee.ai/blog/deep-dives/building-self-improving-skills-for-agents
- Claude Code session format: `~/.claude/projects/` JSONL files
- CASS CLI: `~/.local/bin/cass` v0.1.35
- Existing insights engine: `session-explorer/server/insights.ts`
- Terra skill extraction: `terra/src/services/skills/extraction.ts` (inspiration, different scope)
