# Session Explorer — Architecture Review + Parser Research Panel

Date: 2026-08-09. Sources: full code walk (server + web), live UI review on :5199, server logs, DB queries, and a 3-pass /research-panel (Fable code-verified, best-practices-researcher gh-verified, Codex gpt-5.5 with search + cloned repos) merged by Fable.

## Part 1 — Architecture review findings (ranked)

### P0 — money/CPU leaks in the pipeline

1. **Stuck summarize retry loop.** 6 sessions (oldest from January) fail summarization and retry every 30s tick, forever. `getAllUnsummarizedSessions` selects them each cycle; a failed parse writes NULLs (`server/index.ts:431`) so they never leave the set. 128,030 "unsummarized" lines in `~/Library/Logs/session-explorer.log` . Each retry is a real Haiku call unless the API errors first. Fix: persist a `summary_failed_at` / retry-count column; back off.
2. **Reingest wipes `summary_short` → active sessions re-summarized every 30s.** Reingest restores only `summary` (`server/ingest.ts:121` restore statement, `:334`), but the unsummarized filter is `summary IS NULL OR summary_short IS NULL` (`server/index.ts:272`). Any session that grows gets re-summarized on the next tick. One Haiku call per active session per 30s while you work.
3. **Every 30s cycle strips the first JSONL of all ~240 project dirs** just to resolve the workspace cwd (`server/ingest.ts:430-447`), even though the workspace is already in the DB keyed by `dir_name`. That's 240 full-file reads+JSON parses per cycle over a 14GB tree. Fix: look up `workspaces.dir_name` first; only strip for unknown dirs.
4. **Reingest = delete all rows + reinsert the whole session** on any size change (`server/ingest.ts:194-203`), firing FTS delete+insert triggers per message. Also resets `insights_extracted`/`events_extracted` → repeat Sonnet insight-extraction cost on the next extraction run. Incremental append (byte offset) is the eventual fix; preserving the flags is the cheap immediate one.
5. **FTS5 full rebuild on every server boot** (`server/db.ts:224`) over 1.4M message rows. Should be a one-time migration, not startup code.

### P0 — correctness bug (from panel merge, code-verified)

6. **`canonicalBranch` infinite-loops on parentUuid cycles.** Both parent-walks (`server/strip.ts:102-106` and `:119-123`) have no visited-set. Rewind/replay is documented (claude-code-log) to produce cycles; one such session hangs ingest permanently. 20-minute fix.

### P1 — the architectural mistake: lossy strip-at-ingest feeds the detail view

7. The session detail view renders from the stripped DB, and the strip is destructive:
   - thinking blocks dropped entirely (no `thinking` branch in `strip.ts`)
   - assistant text ≤100 chars dropped (`strip.ts:423`) — short answers vanish from transcripts
   - tool results whitespace-collapsed + truncated to 500 chars (`strip.ts:373`) — code blocks/diffs destroyed
   - `toolUseResult` (incl. `structuredPatch` for real diffs), usage/tokens, `summary` and `compact_boundary` records: all unrecoverable from the DB
   This caps rendering quality permanently. Fix (panel consensus): DB stays the search/list index; detail view parses raw JSONL on demand (see Part 3).
8. **Heuristic system-context detection eats real content.** `isSkillInjection`/`isSystemContext` classify by length + markdown-header count (`strip.ts:144-150`). A pasted plan (>2000 chars, >5 headers) is stored as `[Skill loaded: …]` — user data loss.
9. **Deepest-leaf branch selection is wrong.** `canonicalBranch` picks the deepest leaf (`strip.ts:94-112`); after a rewind, a long abandoned branch beats the shorter real one. Correct: prefer `last-prompt`/`leafUuid` leaf, else last record's leaf; also handle compaction replays (same-timestamp siblings = replay, not fork).
10. **Visible title bug:** session list shows raw `<local-command-stdout>Set model to [1mFable 5[22m…` titles with ANSI codes. `pickTitle`/`isTitleWorthy` don't exclude `<local-command-stdout>`/`<local-command-caveat>` content (claude-devtools filters these tags explicitly).

### P2 — frontend

11. **No virtualization.** `/api/sessions/:id` returns every message (2.8MB JSON for a 4,054-message session); SessionDetail renders all rows into the DOM. Needs windowing + pagination.
12. **Hand-rolled markdown/syntax-highlighting** via regex → HTML strings (`web/sessionFormat.tsx`). Fragile escaping, no code-fence fidelity. Replace with react-markdown + shiki (or keep for snippets only).
13. Misc: "WORKING" label on historical tool groups; window scroll dead (nested scroll container) so browser-level scrolling/automation fails; right third of wide viewports empty; summary input is first 32k chars only (`index.ts:383`) so long sessions are summarized by their beginning.

### P3 — hygiene

14. `package-lock.json` in a bun repo (dead weight); CLAUDE.md says better-sqlite3 but code uses `bun:sqlite`; images filtered only by `.png`/`.jpg` extension.

## Part 2 — Our parser vs claude-devtools (and AgentsView)

| Dimension | session-explorer (`strip.ts`, 462 lines) | claude-devtools (parsing+analysis, ~4.4k lines TS) | AgentsView (`claude.go`, 2.7k lines + suite) |
|---|---|---|---|
| Philosophy | destructive strip at ingest → flat rows | lossless parse-on-demand → typed model → chunk/step pipeline | incremental index for multi-agent product |
| Entry types | ~4 known, rest skipped | typed schema (user/assistant/system/summary/file-history/queue-op), tolerant | broad, gjson-based, tolerant, versioned projections |
| Thinking | dropped | preserved + token counts per step | preserved |
| Tool results | 500-char single line | full, paired by id, `toolUseResult` incl. `structuredPatch` | full, paired across incremental windows |
| Usage/tokens | dropped | per-message usage, dedup by requestId, context deltas (`contextAccumulator`) | merged cumulative chunks by message.id |
| Subagents | merged into parent with sequence offsets | 3-phase linking (toolUseResult.agentId → description → positional), nested trees, old+new layouts | link via agentId + progress/queue events |
| Branches/rewind | deepest-leaf walk, no cycle guard (bug #6) | none — parse order (its real gap) | fork policy: ≤3 user turns = retry (newest wins), else synthetic session split (product-specific, don't copy) |
| Incremental | full reparse on size change | watcher-driven reparse | byte-offset + partial-tail + full-reparse triggers |
| Reusability | — | MIT, plain TS, fs injected via FileSystemProvider → vendorable into Express | Go, embedded in 100+-provider package → reference only |

Verdict: claude-devtools' parser is strictly more capable than ours everywhere except branch semantics, where both are weak (ours buggy, theirs absent). It is directly vendorable.

## Part 3 — Research panel merged verdict

Full stage-1 passes archived at /tmp/panel-all-passes.md .

**Convergence (all 3 passes independently):** claude-code-log (daaain) is the correctness oracle — real parentUuid DAG with cycle breaking, compaction-replay detection, continuation-fork handling, subagent anchoring, coverage verification. Compose roles, don't vendor one project wholesale. Dedup streamed assistant entries by requestId/message.id. Subagents are file-split and linked via `toolUseResult.agentId` first. Append order ≠ display order.

**Decisions:**
- **Vendor claude-devtools' parsing + analysis layers** as the drillable trace-view engine (verified: MIT, no Electron imports in those layers, FileSystemProvider injected; already computes thinking rows, per-tool durations, context deltas, subagent drill-in).
- **Port claude-code-log's dag.py rules (~200 lines)** into our `canonicalBranch` as an active-path pre-filter that runs *in front of* the vendored pipeline — keep vendored code pristine: raw JSONL → active-path filter → devtools pipeline → trace view.
- **AgentsView = design reference only** for future byte-offset incremental ingest; explicitly do not copy its fork policy (synthetic session splits) — analytics policy, not transcript semantics.
- **Architecture:** keep lossy strip as search index; add `GET /api/sessions/:id/trace` that parses raw JSONL on demand; **archive raw JSONL (gzip) at ingest** so traces survive Claude Code's `cleanupPeriodDays` pruning. Skip a full raw-record SQLite schema.
- d-kimuson/claude-code-viewer's 15 Zod entry schemas: completeness checklist, not runtime validation (strict Zod breaks on format drift). ccusage/claude-trace/crystal/sniffly: nothing to take.

**Priority order (merge output):**
1. Fix `canonicalBranch` cycle-safety (visited-set) — `strip.ts:102-123`
2. Archive raw JSONL (+subagents) at ingest
3. Vendor claude-devtools parsing/analysis → `server/trace/vendor/` + `/api/sessions/:id/trace` + drillable UI
4. Upgrade active-path pre-filter with claude-code-log rules (leafUuid preference, compaction-replay rule, tool-result-carrier fork exemption)
5. Cheap wins: compact_boundary divider, per-session token totals, `structuredPatch` diffs
6. Schema-drift canary: unknown-record-type counter at ingest
7. Later, only if measured: byte-offset incremental ingest (AgentsView trigger set)

(My P0 cost fixes from Part 1 — summarize retry loop, summary_short wipe, per-cycle dir stripping, boot-time FTS rebuild — slot in alongside item 1; they're independent of the parser work.)

## Part 4 — recall (session-explorer) vs cass

| | recall / session-explorer | cass 0.1.35 |
|---|---|---|
| Scope | Claude Code only | 10 connectors (claude_code, codex, gemini, cursor, opencode, amp, cline, aider, chatgpt, pi_agent) |
| Index | 3,282 sessions / 1.41M rows / 1.7GB | 17,781 conversations / 996k messages / 5.8GB |
| Search latency | 0.2–0.7s (FTS5 NEAR + LIKE fallback + file-path cross-search + context pairing) | ~0.16s (BM25, cursor pagination, field selection) |
| Interface | web UI + JSON API | TUI + robot-first CLI (JSON contracts, introspect, api-version) |
| Enrichment | LLM summaries, insights, tags/notes, bookmarks, resume-bundle, meta scoring, chat | none (zero LLM cost) |
| Extras | activity heatmap, library, open-in-app | export, expand, timeline, context (related sessions), view |
| Ingest | 30s poll, size-diff reingest | indexer run (index currently STALE on this machine — `healthy: false`) |
| Fidelity | lossy (see Part 1) | stores raw content, display-oriented |

Different jobs: cass = fast cross-agent search primitive for agents; recall = curated Claude-only knowledge layer (summaries/insights/resume) with a UI. recall misses all codex/cursor history; cass has no summaries, tags, or web UI. Note: cass index is stale right now — its indexer isn't running.

## Part 5 — the Mac GUI

**claude-devtools** (matt1398/claude-devtools) — `brew install --cask claude-devtools`, v0.5.0, installed 2026-06-16, still in /Applications. Found via recall search of the 2026-06-16 "session visualizers" session.
