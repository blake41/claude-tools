---
title: Unified Parser Architecture Migration
date: 2026-08-10
origin: plans/2026-08-10-unified-parser-architecture.md
status: draft
---

# Unified Parser Architecture Migration

## Overview

Make the vendored claude-devtools parser THE one parse, run once per file change at ingest. Store full-fidelity rows in SQLite (clean projection + raw payload side by side), serve every UI surface — session detail, trace, search, Ask/chat SQL — from rows with zero read-time parsing. Demote lossy from a storage decision to a projection decision, make the gzip archive load-bearing, and force-reingest all ~3,300 sessions at the end.

**Prerequisite (outside this plan's units):** the entire working tree is currently uncommitted (waves 1–3 of a prior fix program plus follow-ups, all verified green: 94 tests pass, tsc clean, build succeeds). Commit that tree first. This plan builds on top of it.

## Problem Frame

Two parsers cover the same raw JSONL input (`~/.claude/projects/*/*.jsonl`, 14 GB corpus):

1. `server/strip.ts` — homegrown LOSSY parser feeding SQLite at ingest. Truncates tool results at 500 chars, collapses skill/system dumps to one line, drops assistant text under 100 chars — permanently. Powers ~95% of the UI.
2. `server/trace/` — vendored claude-devtools parser (pinned sha, `server/trace/vendor/` is never modified). Full fidelity, but re-parses the raw file PER REQUEST for `GET /api/sessions/:id/trace` only. Breaks when Claude Code prunes the original file.

Branch-selection logic is duplicated (`isAbandonedBranch` was manually ported from `active-path.ts` into `strip.ts` — proof the divergence risk is real). The gzip archive (`data/archive/<sessionId>.jsonl.gz`, written at ingest before parse) is read by nothing except the trace endpoint's fallback.

The "lossy is needed for speed/size" assumption is empirically wrong: cass indexes 996k messages / 5.4 GB SQLite+FTS5 and is fast.

## Requirements Trace

| ID | Requirement (from origin doc + resolved decisions) | Unit(s) |
|----|----|----|
| R1 | One parse per file change, at ingest, via the vendored parser. No parse at read time, ever. | U4, U5 |
| R2 | Full fidelity in SQLite: per-message clean `content` projection + raw payload (cass `extra_json` pattern). Nothing unrecoverable. | U1, U3, U4 |
| R3 | Lossy lives only in a pure projection function. `strip.ts` shrinks/disappears; `canonicalBranch`/`isAbandonedBranch` tree logic exists in exactly one place (`server/trace/active-path.ts`). | U3, U8 |
| R4 | Archive becomes load-bearing: ingest falls back to `data/archive/*.jsonl.gz` when the original is pruned. | U4, U8 |
| R5 | FTS5: porter tokenizer, faceted columns (title/workspace alongside content), tool-result bodies indexed (deliberate divergence from cass). | U1, U3 |
| R6 | Secret redaction at ingest, in the projection step, before DB insert (also keeps secrets out of summarize/insights LLM calls). | U2, U3 |
| R7 | Overlong-FTS-term guard: drop/split tokens over ~64 chars before the indexed column. | U2, U3 |
| R8 | mtime fallback for the reingest trigger (same-size rewrites still reingest). | U1, U4 |
| R9 | Truthful ingest health: last-tick time, pending count, recent failures. | U6 |
| R10 | Session detail full fidelity: big tool results collapsed by default with expand-on-click, list virtualization, paginated/windowed fetch (real sessions run 5000+ messages). | U5, U7 |
| R11 | Trace view reads DB rows; per-request re-parse deleted; `?full=1` raw-model bypass dropped (lean only). | U4, U5 |
| R12 | Migration safety: derived-data preserve/restore, summary staleness rule, subagent_prompt contract, canary, archive wiring all survive unchanged in behavior. | U4 |
| R13 | Force-reingest all ~3,300 sessions at the end; cleanup of dead code. | U8 |

## Scope Boundaries

**In scope:** everything in the Requirements Trace above.

**Out of scope (user-agreed):**
- Semantic/vector search (skip entirely for now).
- Other-agent connectors — Claude-only by design.
- Regenerating summaries or insights from richer rows. Existing `summary`/`summary_short`/`summarized_*` values are preserved through force-reingest via the existing preserve/restore logic; the staleness rule in `server/summary-staleness.ts` is unchanged.
- Modifying `server/trace/vendor/` (pinned at `16cc3c87c1e4d0e08ee101fb52dad1b85dbbe48a`; fixes go in the adapter `server/trace/index.ts` or `server/trace/active-path.ts`).
- `web/components/AskView.tsx`'s separate `renderMarkdown` (deliberately untouched in prior work).

### Deferred to Follow-Up Work

- Trace-chunk windowing/pagination on the trace endpoint (initial version returns all chunks in one response — worst measured lean payload is 2.7 MB, acceptable; add windowing only if a session exceeds that comfort zone).
- `secretlint` as a heavier-coverage redaction fallback, only if the hand-rolled regex+entropy pass proves to miss real secrets in corpus data.
- Raw-export endpoint (paginated rows model) if a `?full=1`-style consumer ever reappears.
- Splitting the 1900+-line `server/index.ts` into routers (tempting while touching endpoints; do not do it in this plan).
- Redacting secrets in the *raw* payload store (projection-only redaction is the agreed scope; raw keeps originals — see Decisions D6).

## Context

Grounded by direct inspection on 2026-08-10. All paths repo-relative to `/Users/blake/Documents/Development/tools/session-explorer`.

**Current data flow:**
- `server/ingest.ts:274-511` (`ingestSession`) — the load-bearing sequence is: archive (`archiveSession`, line 306) → parse (`stripSession`, line 313, BEFORE any delete) → preserve derived data (`sessionDerivedData.get`, line 338) → single `db.transaction` delete+reinsert (line 358) → canary tally (line 467) → count update → conditional restore (`isSummaryStale` gate, lines 480-508). A parse failure must leave old rows fully intact.
- Reingest trigger is file-size-only: `ingest.ts:284-295` compares `sessions.file_size` to `statSync(...).size`. The stale-session sweep (`getStaleSessionsNeedingReingest`, lines 519-548) checks mtime only as an idle-cutoff gate, not as an independent trigger.
- Subagent JSONLs under `<session>/subagents/*.jsonl` are merged into the parent (`ingest.ts:407-461`) with `source='subagent'`; subagent user text rows get `message_type='subagent_prompt'` so `message_type='text'` filters exclude them automatically.
- Workspace resolution for a never-seen project dir calls `stripSession` on up to 3 files just to read `header.cwd` (`ingest.ts:613-623`).
- `server/trace/index.ts` (`buildTrace`, line 223) — resolves session id → JSONL path (DB → glob → gzip archive to temp file), pre-filters via `filterActivePath` (`active-path.ts`), runs vendored `SessionParser` → `SubagentResolver` → `ChunkBuilder.buildSessionDetail`. `shapeTraceForResponse` (line 621) reshapes to `LeanSessionDetail` with `TOOL_PAYLOAD_CAP = 4000` / `PROSE_CAP = 8000` (lines 322-324). `GET /api/sessions/:id/trace` (`server/index.ts:1894-1908`) calls this per request; `?full=1` bypasses shaping.
- Known production bug already fixed once, must not regress: `trace/index.ts:487-499` (`shapeSubagent`) — every message in a subagent's own JSONL carries `isSidechain: true` relative to the parent; vendored `ChunkBuilder.buildChunks()` filters `!m.isSidechain`, so subagent messages must be re-flagged `isSidechain: false` before re-chunking or you get zero steps.

**Schema today (`server/db.ts`):**
- `messages`: `id, session_id, role, content, timestamp, sequence` + migrated columns `message_type, source, tool_use_id, tool_name, tool_input`. Rows are block-level: one JSONL assistant record with thinking+text+tool_use blocks becomes multiple rows.
- `messages_fts`: external-content FTS5 (`content='messages'`, `content_rowid='id'`), NO tokenizer clause (db.ts:114-118), kept in sync by insert/delete triggers (120-126).
- Migration idiom: `try { ALTER TABLE ... } catch {}` for columns; `runOnce(db, key, fn)` (`server/db-migrations.ts`) for expensive one-time work (used for `fts_rebuild_v1`, db.ts:228-230).
- `archive_manifest` lives in `server/archive.ts` (skip-if-unchanged by size+mtime). Archive path contract: exactly `data/archive/<session-id>.jsonl.gz`, latest-only (`archivePathFor`).

**Serving surface that assumes the current `messages` shape:**
- `server/index.ts`: `getMessages` (157-162, ALL rows, no pagination — `GET /api/sessions/:id` at 582-609 returns everything, with read-time `cleanXmlNoise`), FTS search statements (183-232, `snippet(messages_fts, 0, ...)`, `message_type != 'subagent_prompt'` filters), inline subqueries counting `message_type = 'tool_use'` and fetching `last_user_message` (102-140).
- `server/chat.ts:36-119`: the Ask/chat SQL agent's schema is HAND-WRITTEN PROSE (lines 40-49) plus query recipes; recipe at line 89 depends on tool_use content format `'ToolName: summary'` (`content LIKE 'ToolName:%'`). Any schema change needs a prompt edit or the SQL agent can't use it.
- `server/insights.ts:13,97` and the summarize path read `messages.content` — they consume the projection and need no change (redaction at projection benefits them for free).
- `server/canary.ts` duplicates strip.ts's type vocabulary (`KNOWN_RECORD_TYPES`, lines 19-26) by explicit design ("strip.ts is out of scope to import from").

**Frontend:**
- `web/components/SessionDetail.tsx` (1507 lines) renders all messages, no virtualization; fetches `/api/sessions/:id` (line 963).
- `web/components/TraceView.tsx` fetches `/api/sessions/:id` (line 224) and `/api/sessions/:id/trace` (line 231); `web/traceTypes.ts` independently mirrors `LeanSessionDetail` (Dates as ISO strings).
- Perf landmines (documented in-code, must survive): `web/sessionFormat.tsx:13-20` — `REMARK_PLUGINS` must stay module-scope or react-markdown re-parses every visible message per re-render; `web/traceFormat.ts:31-36` — `isLong()` is a string-length heuristic, deliberately not a `scrollHeight` DOM read.
- No virtualization library in `package.json` — new dependency required.
- Sequence numbers can be non-chronological (rewind/replay); always sort by `timestamp` when chronological order matters (project CLAUDE.md).

**Verified empirically on this machine (2026-08-10, bun 1.3.14, bundled SQLite 3.51.0):** an external-content FTS5 table declared as `fts5(content, title, workspace, tokenize='porter unicode61', content='messages', content_rowid='id')` over a `messages` table carrying same-named `title`/`workspace` columns works end to end — porter stemming ("search" matches "searching"), column-filtered MATCH (`workspace: terra`), `snippet(..., 0, ...)` on content, and the external-content `'delete'` special insert all behave correctly. Facet columns must exist by name on the content table; triggers must write all three columns.

**Measured numbers (2026-08-10):** raw corpus 14 GB; current lossy DB 1.6 GB (3,293 sessions, 1.4M messages); lean trace payload for worst session (6.7k msgs, 47 MB raw) 2.7 MB (~17x reduction); expected DB after migration 3–5 GB; a `?full=1` payload once hit ~148 MB.

## Key Technical Decisions

### D1. Reuse `buildTrace` machinery for ingest — refactored to accept a resolved file path

The vendored pipeline (`SessionParser` → `SubagentResolver` → `ChunkBuilder.buildSessionDetail` → `shapeTraceForResponse`) already exists, is tested (`server/trace/index.test.ts`, 434 lines), and already handles active-path pre-filtering, the archive-gunzip-to-temp fallback, and the subagent isSidechain re-flag fix. Ingest calls a refactored `buildTraceFromFile(filePath, projectId, sessionId)` (extracted from `buildTrace`) instead of duplicating any of it. One `SessionDetail` result yields BOTH the full per-message data (`detail.messages` + `detail.processes[].messages`) and the lean chunk model. Alternative rejected: calling `SessionParser` directly from ingest and keeping `buildTrace` separate — that recreates the two-pipelines problem this migration exists to kill.

### D2. Raw payload lives in a `raw_records` table, not a per-message-row column ⚠️ REVIEW-THESE

The origin doc says "raw payload column". Implemented literally, it multiplies storage: `messages` rows are block-level (one assistant JSONL record with thinking+text+tool_use becomes 2–3 rows), so a per-row raw column stores the same multi-block record 2–3 times — plausibly pushing the DB well past the 3–5 GB estimate. Instead:

- `raw_records(session_id TEXT, uuid TEXT, seq INTEGER, raw TEXT, PRIMARY KEY (session_id, uuid))` — one row per raw JSONL record (verbatim original line, parent + subagent files both), the literal cass `extra_json` unit.
- `messages.record_uuid TEXT` links each projection row to its source record.
- Full-fidelity reads (expand-on-click, Ask/chat `json_extract` queries) go through the join.

This honors the doc's intent (full original record beside the projection, queryable, nothing unrecoverable) while keeping dedup. Reversible by construction — raw JSONL + archive persist; re-projection never touches source files. **Flagged because it refines a written decision's letter while keeping its spirit.**

### D3. Materialize the lean trace model at ingest into `trace_chunks` rows ⚠️ REVIEW-THESE

"Trace view reads DB rows" has three candidate implementations:
1. **Store raw/ParsedMessage rows, re-run ChunkBuilder at read time** — rejected: `SubagentResolver` reads sibling subagent files from disk at resolve time, so read-time chunk-building breaks for pruned sessions (the exact failure this migration fixes), and re-running the pipeline per request violates "read time is SQL only".
2. **One JSON blob per session** — rejected by the user already (all-or-nothing serving, not queryable, no windowing).
3. **One row per lean chunk** (chosen): `trace_chunks(session_id, chunk_seq, chunk_type, started_at, ended_at, payload TEXT)` where `payload` is one `LeanChunk` JSON (steps embedded — a chunk is the UI's atomic render unit, and payload strings are already capped by `shapeTraceForResponse`), plus a session-level `trace_meta` JSON column on `sessions` for the `LeanSessionDetail` envelope (session, metrics, models, subagentCount, unattachedSubagents, fingerprint). Rows enable windowed fetch later; the endpoint reassembles a response byte-shape-compatible with today's `LeanSessionDetail`, so `web/traceTypes.ts` and `TraceView.tsx` need no structural changes.

**Flagged because chunk payloads are JSON-in-a-column** — deliberately at chunk granularity (not session granularity), which is what preserves pagination-by-row and keeps this outside the rejected blob-cache design. Compute cost note: chunk-building now runs at ingest for every changed session (~30s tick for active ones) — the same O(n) work the trace endpoint previously paid per page view, so net compute moves earlier and happens less often.

### D4. FTS facets via denormalized `title`/`workspace` columns on `messages`

External-content FTS5 reads column values from same-named columns of the content table (verified empirically, see Context). So faceting requires `messages.title` and `messages.workspace` (workspace display_name), written at ingest. Staleness is a non-issue: reingest rewrites all of a session's message rows, and title is only recomputed at reingest. Cost ~1.4M rows × ~80 bytes ≈ 120 MB — acceptable inside the 3–5 GB envelope. Alternative rejected: a separate `sessions_fts` table — two MATCH queries to answer one faceted question, and it can't do `{title workspace}: term AND content-term` in one expression. `content` stays FTS column 0 so existing `snippet(messages_fts, 0, ...)` calls keep working.

### D5. Porter tokenizer requires DROP + recreate of `messages_fts`, not a rebuild

`tokenize` is fixed at CREATE VIRTUAL TABLE time. Migration: drop triggers → `DROP TABLE messages_fts` → recreate with `tokenize='porter unicode61'` + facet columns → recreate triggers (writing all three columns) → `INSERT INTO messages_fts(messages_fts) VALUES('rebuild')`, guarded by `runOnce(db, "fts_porter_facets_v1", ...)` following the existing `fts_rebuild_v1` idiom. The rebuild initially indexes old lossy content — correct and intentional: search keeps working between deploy and the U8 force-reingest, which replaces row content and re-syncs FTS via the triggers.

### D6. Secret redaction: hand-rolled regex + entropy, projection-only

Per research (this is what gitleaks/detect-secrets do internally, minus the engine): a high-confidence prefixed-pattern list (AWS `AKIA[0-9A-Z]{16}`, GitHub `gh[pousr]_...`, Slack `xox[baprs]-...`, Stripe `sk_live_...`, JWT `eyJ...`, `-----BEGIN ... PRIVATE KEY-----`) plus a Shannon-entropy pass for unlabeled tokens (base64-charset runs ≥20 chars with entropy > ~4.5; hex runs ≥32 chars with entropy > ~3), with an allowlist for known-safe high-entropy strings (git SHAs, UUIDs). Zero dependencies, pure string processing. Applied to tool-result bodies in the projection step only — `raw_records` keeps originals (this is a local single-user tool; the goal is keeping secrets out of FTS and out of summarize/insights LLM calls, not at-rest encryption). Redacted spans are replaced with `[REDACTED:<kind>]`.

### D7. Projection rules for tool results ⚠️ REVIEW-THESE (resolved default, user should see)

Index ALL tool-result bodies (no per-tool allowlist) — "which session saw this error string" is a real query pattern and our deliberate divergence from cass. Per-result projection cap: **4000 chars**, matching the existing `TOOL_PAYLOAD_CAP` precedent in `server/trace/index.ts`. Before the indexed column: secret redaction (D6), then split/drop tokens longer than **~64 chars** (do NOT hardcode the unverified 1024-byte figure from cass's changelog — SQLite's own token ceiling is 32768 bytes; 64 is conservative and precedented by `snippet()`'s cap). Lossy rules live only in the projection function; `raw_records` keeps everything. Reversible: rules can be re-tuned and rows re-projected from raw without touching source files. Cap size and index-everything are genuine search-quality-vs-bloat preferences — hence flagged.

### D8. Drop the `?full=1` raw-model bypass ⚠️ REVIEW-THESE (resolved default, user should see)

When the trace endpoint moves to DB rows, serve lean-shaped trace only. The 148 MB single-payload raw model loses its consumer. Raw fidelity stays reachable three ways: `raw_records` in SQLite, `data/archive/<id>.jsonl.gz`, the original JSONL. Zero data loss; pure code removal; if a raw-export need reappears, reinstate as a paginated rows endpoint. Also update the stale `?full=1` mention in `web/traceTypes.ts`'s header comment.

### D9. Message-row granularity is preserved (block-level rows, same `message_type` vocabulary)

The projection maps vendored `ParsedMessage`s to the SAME row shape the UI and Ask/chat already understand: text blocks → `text` rows (verbatim, no more <100-char drops), tool_use blocks → `tool_use` rows with content `'ToolName: <summary>'` (the exact format `chat.ts:89`'s recipe greps), tool results → `tool_result` rows (cleaned/capped per D7), system → `system`. Subagent user text rows keep `message_type='subagent_prompt'`, `source='subagent'`. This keeps every existing prepared statement, subquery, and chat recipe semantically valid — the migration changes what content survives, not what a row means.

### D10. mtime reingest trigger: additive `sessions.file_mtime` column

At the `needsReingest` check, reingest when `stat.size !== stored.file_size` OR `stat.mtimeMs !== stored.file_mtime`. No watcher — the 30s polling tick stays. Same-size rewrites (e.g. in-place compaction) now reingest.

### D11. Virtualization: `@tanstack/react-virtual`

Headless, native dynamic-size support via `measureElement` (chat rows have unpredictable heights), pairs with the already-used `@tanstack/react-router`. `react-window` rejected: fixed-height-first, effectively unmaintained. Install with `bun add` (never npm).

### D12. SQLite version startup assertion

Bun's bundled SQLite regressed to 3.43.2 in some builds (oven-sh/bun#31247), which has an FTS5 bug where external-content `'delete'` inserts raise `SQLITE_CORRUPT_VTAB` — this codebase performs exactly that on every reingest. This machine runs 3.51.0 (verified), but the version is fragile across bun upgrades. Add a startup check in `server/db.ts`: `sqlite_version() >= 3.46` or fail loudly with a message naming the bun issue.

### D13. Force-reingest covers pruned sessions via a DB-driven archive sweep

`runIngestion` discovers work by walking `~/.claude/projects/` — pruned sessions are invisible to it. The force pass therefore needs a second sweep: enumerate DB sessions whose `source_path` no longer exists but whose `archivePathFor(id)` does, and reingest each from the archive (gunzip to temp, parse, same transactional path). Sessions with neither file nor archive keep their old lossy rows (parse-before-delete guarantees this) — degraded but never destroyed.

## Open Questions

### Resolved During Planning

- **Projection rules for tool results** → D7 (index everything, 4000-char cap, 64-char token guard). Flagged REVIEW-THESE.
- **`?full=1` trace export** → D8 (drop it; lean only). Flagged REVIEW-THESE.
- **Summary regeneration from richer rows** → No. Existing summaries preserved through force-reingest by the existing `restoreSummaryFields`/`isSummaryStale` logic; staleness rule unchanged. (User-agreed.)
- **What the raw column holds** (raw JSONL line vs ParsedMessage JSON) → raw verbatim JSONL record, normalized into `raw_records` (D2). ParsedMessage is a derived artifact; trace-serving needs are covered by `trace_chunks` (D3), so nothing ever needs to reconstruct ParsedMessage objects at read time.
- **FTS facet mechanics under external content** → denormalized same-named columns, verified empirically (D4).

### Deferred to Implementation

- **Entropy thresholds and allowlist tuning for redaction (U2):** start with the research values (base64 ≥20 chars / H>4.5; hex ≥32 chars / H>3.0; allowlist 40-char hex git SHAs and UUID shapes), then tune against a sample of real corpus tool results until false positives on ordinary code/output are rare. The test suite pins the patterns; thresholds are named constants.
- **Exact paginated-messages API shape (U5):** offset/limit vs keyset on `(timestamp, sequence)`. Guidance: keyset is safer for 5000+-row sessions, but offset is simpler and sessions are immutable between reingests — implementer's call, document in the endpoint comment.
- **Whether `GET /api/sessions/:id` keeps returning a first page of messages inline** (U5): recommended yes (first `defaultPageSize` window) so the detail view paints without a second round trip; implementer confirms against `SessionDetail.tsx`'s load sequence.
- **Read-time `cleanXmlNoise` (server/index.ts:605):** projection now strips XML noise at ingest; the read-time call should become unnecessary after force-reingest. Keep it during the transition window, remove in U8 if row content is clean.
- **Ingest-health UI placement (U6):** a small status block — Sidebar footer vs settings page. Cosmetic; implementer's call.

## Implementation Units

U-IDs are stable once assigned — never renumbered on edit/split/delete.

### U1. Schema + FTS5 porter/facets migration

- **Goal:** the database can hold full-fidelity data: raw records, trace chunks, facet columns, mtime, with a porter+faceted FTS index — all before any ingest logic changes.
- **Requirements:** R2, R5, R8
- **Dependencies:** none
- **Files:** modify `server/db.ts`, `server/db-migrations.ts` (only if `runOnce` needs a variant); test `server/db.test.ts` (new) or extend `server/db-migrations.test.ts`
- **Approach:**
  - New table `raw_records(session_id TEXT NOT NULL, uuid TEXT NOT NULL, seq INTEGER NOT NULL, raw TEXT NOT NULL, PRIMARY KEY (session_id, uuid))` + `idx_raw_records_session`. (D2)
  - New table `trace_chunks(session_id TEXT NOT NULL, chunk_seq INTEGER NOT NULL, chunk_type TEXT NOT NULL, started_at TEXT, ended_at TEXT, payload TEXT NOT NULL, PRIMARY KEY (session_id, chunk_seq))`. (D3)
  - `try/catch ALTER TABLE` migrations (existing idiom, db.ts:179-216): `messages.record_uuid TEXT`, `messages.title TEXT`, `messages.workspace TEXT`, `sessions.file_mtime INTEGER`, `sessions.trace_meta TEXT`.
  - FTS swap inside `runOnce(db, "fts_porter_facets_v1", ...)`: drop both triggers, `DROP TABLE messages_fts`, recreate as `fts5(content, title, workspace, tokenize='porter unicode61', content='messages', content_rowid='id')`, recreate insert/delete triggers writing all three columns, then `'rebuild'`. `content` must stay column 0 (snippet calls). (D4, D5)
  - Startup assertion: `sqlite_version()` ≥ 3.46, `throw` with a message citing oven-sh/bun#31247. (D12)
  - Preserve the extensive-rationale-comment convention — every table/column gets a why-comment like the existing migrations.
- **Execution note:** the `runOnce` FTS rebuild scans 1.4M rows at next boot — document expected one-time boot delay in the migration comment.
- **Test scenarios:**
  - Happy path: fresh in-memory DB gets all tables/columns; porter stemming works ("search" matches "searching"); faceted MATCH `workspace: <name>` filters correctly; `snippet(messages_fts, 0, ...)` returns content snippets.
  - Edge cases: migration is idempotent (running the module twice adds nothing and throws nothing); delete trigger's external-content `'delete'` insert works after the recreate (insert row → delete row → MATCH finds nothing).
  - Error: version assertion — feed the check function a fake "3.43.2" and assert it throws.
- **Verification:** `bun test server/`; `bunx tsc --noEmit`; boot the dev server against a copy of the real DB and confirm the one-time rebuild completes and search still returns results.

### U2. Sanitization helpers: secret redaction + overlong-token guard

- **Goal:** pure, dependency-free string functions: `redactSecrets(text): { text, redactions }` and `guardFtsTokens(text, maxLen≈64): string`, ready for the projection to compose.
- **Requirements:** R6, R7
- **Dependencies:** none
- **Files:** create `server/redact.ts`, `server/redact.test.ts`
- **Approach:** follow the repo's pure-function-first discipline (`summary-staleness.ts`, `archive.ts`'s `shouldArchive` are the models — pure logic, thin callers). Regex layer (prefixed patterns per D6) runs first; entropy layer scans remaining base64/hex-charset runs; allowlist filters (git SHAs, UUIDs, low-entropy doc examples like `AKIAIOSFODNN7EXAMPLE`). Replacement format `[REDACTED:<kind>]`. Token guard: split on whitespace boundaries is NOT enough (minified JS has none) — scan for runs of non-whitespace > maxLen and either drop them or insert split points; keep the choice a named constant with a rationale comment. Thresholds are named exported constants so tests pin them and tuning is one edit.
- **Test scenarios:**
  - Happy path: each prefixed pattern redacts (AWS, GitHub, Slack, Stripe, JWT, private-key block); a bare 40-char high-entropy base64 token redacts via entropy; a base64 blob and a minified-JS line come out with no token > maxLen.
  - Edge cases: git SHA and UUID pass through unredacted; ordinary English prose and normal code are untouched (no false positives on a realistic tool-result sample fixture); empty string; string exactly at threshold lengths.
  - Error: none (pure functions, no throw paths — assert they never throw on arbitrary junk input including invalid UTF-8-ish sequences).
- **Verification:** `bun test server/redact.test.ts`; `bunx tsc --noEmit`.

### U3. Projection module: vendored ParsedMessage → row fields

- **Goal:** ONE pure function family, `server/projection.ts`, that turns a `ParsedMessage` (plus subagent context) into zero-or-more projected row descriptors `{ role, content, messageType, toolUseId, toolName, toolInput, timestamp, recordUuid }` — the only place lossy transforms live.
- **Requirements:** R2, R3, R5, R6, R7
- **Dependencies:** U2 — U2 provides `redactSecrets`/`guardFtsTokens` in `server/redact.ts`.
- **Files:** create `server/projection.ts`, `server/projection.test.ts`; reference (do not yet delete) `server/strip.ts`
- **Approach:**
  - Input is the vendored `ParsedMessage` (`server/trace/vendor/main/types/messages.ts:63-108`) — content blocks, `toolCalls`, `toolResults`, `toolUseResult`, `sourceToolUseID`. No file reading, no JSON.parse, no tree walking (branch selection already happened via `filterActivePath` upstream).
  - Row mapping per D9: text blocks verbatim (drop the <100-char and skill/system-collapse heuristics — full fidelity is the point; keep only XML-noise stripping for display cleanliness), tool_use → `'ToolName: <summary>'` (port `summarizeToolInput` from `strip.ts:397` — it's the format contract with `chat.ts:89`), tool_result → cleaned body through `redactSecrets` → cap at 4000 chars (`PROJECTION_TOOL_RESULT_CAP`, cite `TOOL_PAYLOAD_CAP` precedent) → `guardFtsTokens`.
  - Also export `extractFileReferences(parsedMessages): FileReference[]` (Write/Edit/Read tool calls → `session_files` rows; port from `strip.ts` `FILE_TOOL_NAMES` logic) and `projectHeader(parsedMessages): { branch, cwd }`.
  - `subagent_prompt` mapping stays an ingest-time concern (it depends on which file a message came from), but the projection accepts a `source: 'parent' | 'subagent'` hint and applies the message_type override for user text rows so the rule lives here, tested, not inline in ingest.
  - Preserve rationale-comment convention; carry over the load-bearing comments from strip.ts where the rule survives (e.g. XML-noise markers).
- **Test scenarios:**
  - Happy path: an assistant record with thinking+text+tool_use projects to the expected rows in order; a tool_result projects with redacted+capped+guarded content; user text is verbatim.
  - Edge cases: subagent user text → `subagent_prompt`; subagent tool rows keep their types; empty content blocks produce no rows; image blocks; a 50 KB tool result caps at 4000 with a truncation marker; content that is only tool_results.
  - Error: malformed/partial ParsedMessage fields (missing role, string content) don't throw.
- **Verification:** `bun test server/projection.test.ts`; `bunx tsc --noEmit`. Golden-file check: run projection over one real fixture transcript and eyeball that text/tool rows match the current UI's expectations (fixture checked into `server/fixtures/` if none exists — `strip.test.ts`'s fixtures may be reusable).

### U4. Ingest swap: vendored parse at ingest, archive fallback, mtime trigger, chunk materialization

- **Goal:** `ingestSession` runs the vendored pipeline once per file change and writes messages + raw_records + trace_chunks + trace_meta + session_files, with every existing safety property intact.
- **Requirements:** R1, R2, R4, R8, R11 (the write side), R12
- **Dependencies:** U1 — U1 provides `raw_records`/`trace_chunks`/`file_mtime`/`trace_meta` in `server/db.ts`. U3 — U3 provides `projectMessage`/`extractFileReferences`/`projectHeader` in `server/projection.ts`.
- **Files:** modify `server/ingest.ts`, `server/trace/index.ts` (refactor only — extract `buildTraceFromFile`; vendor/ untouched); test `server/ingest.test.ts` (new), extend `server/trace/index.test.ts`
- **Approach:**
  - **Characterization tests FIRST** (see Execution note): pin the preserve/restore behavior against the current code before touching it — reingest preserves `insights_extracted`/`events_extracted` unconditionally; `summary`/`summary_short`/`summarized_message_count`/`summarized_at` restored only when `isSummaryStale` is false; parse failure leaves old rows intact; tags survive.
  - Refactor `server/trace/index.ts`: extract `buildTraceFromFile(filePath, projectId | null, sessionId): Promise<SessionDetail>` from `buildTrace` (everything after transcript resolution, including `materializeActivePath` and the SubagentResolver/stub-session logic). `buildTrace` becomes resolve-then-delegate. `shapeSubagent`'s isSidechain re-flag (index.ts:487-499) is inside the shaping path — DO NOT touch it; regression here silently yields zero-step subagents.
  - `ingestSession` new sequence (ordering is load-bearing, keep the existing comments updated, not deleted):
    1. reingest trigger: size OR mtime differs (D10); store `file_mtime` on insert.
    2. `archiveSession` (unchanged, before parse).
    3. resolve parse source: original path if it exists, else `archivePathFor(sessionId)` gunzipped to temp (reuse the temp-file pattern from `trace/index.ts:160-176`) — this is the archive-becomes-load-bearing hook (R4).
    4. parse BEFORE delete: `detail = await buildTraceFromFile(...)`; `lean = shapeTraceForResponse(detail)`. Failure → old rows intact, canary tally, return false (existing contract).
    5. project: parent `detail.messages` with `source='parent'`; each `detail.processes[].messages` with `source='subagent'` (message_type override per U3). Subagent messages come from the resolver output, NOT from re-reading `subagents/*.jsonl` with a second parser — delete the `stripSession` subagent loop.
    6. preserve derived data (`sessionDerivedData.get`) — unchanged.
    7. ONE transaction: delete old messages/files/raw_records/trace_chunks/session row (tags preserved) → insert session (with `file_mtime`, `trace_meta`) → insert messages (with `record_uuid`, `title`, `workspace` facets) → insert raw_records (every ParsedMessage's original line — see note below) → insert trace_chunks (one row per `lean.chunks[i]`) → insert session_files.
    8. canary, `updateSessionCounts`, conditional restore — unchanged.
  - **Raw line capture:** the vendored `ParsedMessage` doesn't retain the original line text. Capture raw records at the same place `materializeActivePath` already reads and splits the file — pass the active-path line array through so ingest can map uuid → raw line (parse each line's `uuid` field cheaply, or extend the return of `buildTraceFromFile` with a `rawLinesByUuid` map built in the adapter, NOT in vendor/). Subagent files: read their lines in the adapter alongside resolver output. Records the active-path filter drops are deliberately not stored (they're abandoned branches; archive keeps them).
  - `ingestSession` becomes async (`buildTraceFromFile` is async) — `runIngestion` already awaits per file; update call sites (`reingestSession`, the tick in `server/index.ts:1929`).
  - Workspace resolution for unknown dirs (`ingest.ts:613-623`): replace the `stripSession` header call with a lightweight `readSessionHeader(path)` that JSON-parses only the first few lines for `cwd` — do not full-parse a 47 MB file for one field.
  - `pickTitle` consumes projected user messages (same shape as today's `userMessages`).
  - Canary wiring stays byte-for-byte (`recordUnknownTypesForSession` call sites); update `server/canary.ts`'s header comment to re-anchor its vocabulary to the vendored parser + `KNOWN_RECORD_TYPES` (comment-only here; deletion decisions live in U8).
- **Execution note:** characterization tests first — the preserve/restore block is the highest-risk regression surface in this plan; pin current behavior before the rewrite, then make the same tests pass against the new implementation.
- **Test scenarios:**
  - Happy path: ingest a fixture transcript → messages rows (block-level, correct types/facets), raw_records keyed by uuid, trace_chunks matching `shapeTraceForResponse` output, session_files extracted, counts right.
  - Edge cases: reingest preserves insights/events flags and non-stale summaries, drops stale summaries (both `isSummaryStale` branches); subagent messages merged with `source='subagent'` and `subagent_prompt` for user text; subagent with all-isSidechain messages still yields non-zero trace steps; original file missing but archive present → ingests from archive; mtime-only change (same size) triggers reingest; size-and-mtime unchanged → skip.
  - Error: parse failure leaves prior rows fully intact (assert row counts and summary fields before/after); stat failure mid-flight; malformed subagent file skipped without failing the parent.
- **Verification:** `bun test server/` (all suites — trace tests must still pass against the refactor); `bunx tsc --noEmit`; manually reingest one real workspace (`bun run server/ingest.ts --force` scoped or via API) and diff message counts/spot-check content against the pre-migration DB copy.

### U5. Serving from rows: paginated detail, raw expand, trace endpoint, chat prompt

- **Goal:** every read path is SQL over rows: paginated messages, per-record raw expand, trace served from `trace_chunks` (re-parse deleted, `?full=1` dropped), Ask/chat SQL agent told about the new schema.
- **Requirements:** R1, R10 (API side), R11
- **Dependencies:** U1 — U1 provides the tables/columns the queries read. U4 — U4 provides populated `trace_chunks`/`trace_meta`/`raw_records` rows and defines their payload shapes.
- **Files:** modify `server/index.ts`, `server/chat.ts`; test extend `server/index`-adjacent tests or new `server/serving.test.ts`; modify `web/traceTypes.ts` (comment only, per D8)
- **Approach:**
  - `GET /api/sessions/:id`: returns session meta + tags + first message window (see deferred question) + total count; new `GET /api/sessions/:id/messages?<window params>` ordered by `timestamp ASC, sequence ASC` (CLAUDE.md rule: timestamp first). Response rows include `record_uuid` and a `truncated` flag when projection capping applied.
  - New `GET /api/sessions/:id/records/:uuid`: returns the raw record from `raw_records` (the expand-on-click source). 404 for unknown uuid.
  - `GET /api/sessions/:id/trace`: reassemble `LeanSessionDetail` from `sessions.trace_meta` + `trace_chunks ORDER BY chunk_seq` — byte-shape-compatible with today's response so `TraceView.tsx` keeps working. Delete the `buildTrace` call from the route, delete the `?full=1` branch (D8). Keep `buildTrace`/`buildTraceFromFile` exported — ingest (U4) and trace tests use them. 404 with a helpful message when a session has no trace rows yet (pre-force-reingest sessions — message should say "reingest to enable trace").
  - Existing statements keep working by design (D9): FTS search (snippet col 0 unchanged), tool_use counts, `last_user_message`. Optionally extend search to accept faceted queries — only if free; facet syntax already works via raw MATCH.
  - `server/chat.ts` prompt (lines 40-119): add `raw_records`, `trace_chunks`, `messages.record_uuid/title/workspace`, porter/facet notes (e.g. `workspace: term` MATCH filters), update the `tool_result` description from "truncated first 500 chars" to the new 4000-cap + redaction reality, add a `json_extract` recipe over `raw_records.raw`.
  - Remove read-time `cleanXmlNoise` only per the deferred question (keep during transition).
- **Test scenarios:**
  - Happy path: paginated fetch returns stable windows covering all rows exactly once; records endpoint returns the verbatim raw line; trace endpoint response deep-equals `shapeTraceForResponse(buildTraceFromFile(...))` output for a fixture session ingested by U4.
  - Edge cases: window past the end → empty array not error; session with no trace_chunks → 404 with reingest hint; subagent_prompt rows excluded from search results (existing filter still applies); faceted MATCH through the search endpoint doesn't crash the FTS query builder (`toFtsQuery` quoting vs `:` syntax — verify interaction).
  - Error: unknown session id → 404 on all three endpoints.
- **Verification:** `bun test server/`; `bunx tsc --noEmit`; `bun run build`; manual: open a reingested session's trace in the browser and confirm identical rendering vs a pre-migration screenshot; confirm an Ask/chat query can `json_extract` from raw_records.

### U6. Truthful ingest health

- **Goal:** `GET /api/ingest/status` reports reality: last completed tick time, pending (known-stale) count, and a bounded ring of recent per-session failures — not "process running = healthy".
- **Requirements:** R9
- **Dependencies:** U4 — U4 provides the rewritten `ingestSession` failure paths and the size+mtime staleness predicate this unit instruments.
- **Files:** modify `server/ingest.ts`, `server/index.ts`; modify one frontend surface (`web/components/Sidebar.tsx` or equivalent — see deferred question); test extend `server/ingest.test.ts`
- **Approach:** in-memory module state in `ingest.ts` (no new tables): `lastTickAt` (set when a tick's `runIngestion` resolves), `recentFailures` capped array (~20 entries: sessionId, message, timestamp — pushed in `ingestSession`'s catch/skip paths), and `getPendingCount()` computed on demand by running the U4 staleness predicate (size+mtime) over `sessions` rows — factor that predicate into a pure exported function so both the trigger and the health count share one definition. Extend the `/api/ingest/status` payload; keep existing fields for compatibility. Small UI readout with a stale-tick warning state (e.g. last tick > 2 minutes ago on a 30s cadence).
- **Test scenarios:**
  - Happy path: after a successful ingest run, `lastTickAt` is set and failures list is empty; a session that fails parse appears in `recentFailures` with its error.
  - Edge cases: ring buffer caps at N (push N+5, length stays N, oldest evicted); pending count reflects an mtime-only stale session.
  - Error: status endpoint never throws when no tick has run yet (nulls, not crashes).
- **Verification:** `bun test server/`; `bunx tsc --noEmit`; curl `/api/ingest/status` on the dev server and confirm fields populate across two ticks.

### U7. UI: full-fidelity session detail with virtualization and collapse/expand

- **Goal:** `SessionDetail.tsx` renders full-fidelity rows for 5000+-message sessions smoothly: virtualized list, windowed fetch against the U5 pagination API, big tool results collapsed by default with expand-on-click pulling the raw record.
- **Requirements:** R10
- **Dependencies:** U5 — U5 provides `GET /api/sessions/:id/messages` (windowed) and `GET /api/sessions/:id/records/:uuid` (expand source).
- **Files:** modify `web/components/SessionDetail.tsx`, `web/sessionFormat.tsx` (only if row rendering needs new message-type handling), `package.json` (`bun add @tanstack/react-virtual`); test: this repo has no frontend test rig — verification is manual + build/tsc (state this honestly in the PR)
- **Approach:**
  - `@tanstack/react-virtual` with `measureElement` dynamic sizing (D11). Windowed fetch feeding the virtualizer; scroll-driven page loads.
  - Collapse/expand gating by STRING LENGTH, not DOM measurement — follow `web/traceFormat.ts:31-36`'s `isLong()` precedent. Collapsed tool results show the projection content (≤4000 chars, already redacted); "expand" fetches `records/:uuid` lazily and renders the full original.
  - CRITICAL: `REMARK_PLUGINS` in `web/sessionFormat.tsx:13-20` stays module-scope; any new react-markdown usage follows the same pattern. Virtualization further limits blast radius (only visible rows parse markdown) but is not an excuse to regress the memoization.
  - Existing in-page features that assume all messages are in the DOM (in-page search/jump, if any — audit `SessionDetail.tsx`'s 1507 lines during implementation) must be re-pointed at server search or the loaded window; list what's found in the PR description.
- **Test scenarios (manual QA script, since no frontend rig):**
  - Happy path: open the worst-case session (6.7k messages) — first paint under a second, smooth scroll, no long-task jank; expand a big tool result → full content appears; collapse works.
  - Edge cases: short session (< one page) renders identically to before; session ingested pre-migration (no record_uuid) — expand control hidden or disabled, not broken; images/markdown in messages render as before.
  - Error: records endpoint 404 → inline error state, not a crash.
- **Verification:** `bunx tsc --noEmit`; `bun run build`; manual QA script above against the dev server; screenshot comparison on one representative session before/after.

### U8. Force-reingest + cleanup

- **Goal:** all ~3,300 sessions re-ingested through the unified path (disk + archive-only sweep); dead code deleted; the two-parser era is over.
- **Requirements:** R3, R4, R13
- **Dependencies:** U4 — provides the unified ingest + archive fallback the force run exercises. U5 — endpoints no longer read files, so reingest output is what users see. U6 — health surface monitors the run. U7 — UI renders the new rows the run produces.
- **Files:** modify `server/ingest.ts` (force-mode archive sweep per D13), delete `server/strip.ts` + `server/strip.test.ts`, modify `server/canary.ts` (comment re-anchor), `server/index.ts` (remove transitional `cleanXmlNoise` if row content is clean; remove any dead imports), `server/trace/index.ts` (delete now-unused resolution paths only if truly unused — `buildTrace`'s DB/glob/archive resolution is still used by ingest's archive fallback and tests; verify before deleting anything)
- **Approach:**
  - Pre-flight: back up `data/sessions.db` (simple file copy while server stopped, or `sqlite3 .backup`); confirm `bun test server/`, `bunx tsc --noEmit`, `bun run build` all green.
  - Force run: stop the launchd service (or rely on the `ingestProgress.running` guard and run via API — recommended: CLI `bun run server/ingest.ts --force` with the server stopped, to avoid tick contention and WAL churn). Expect hours-scale runtime (14 GB × O(n) parse + chunk build); it is resumable in the sense that a re-run skips already-reingested files only if force is per-batch — simplest is one uninterrupted run; log progress per workspace (existing console output).
  - Archive-only sweep (D13): after the disk walk, enumerate DB sessions whose `source_path` is gone but archive exists → reingest each from archive. Sessions with neither keep old lossy rows (log a count).
  - Post-run checks: session count unchanged (~3,293); total DB size in the 3–5 GB envelope (investigate if > 6 GB); spot-check N sessions across eras (old pruned/archived, mid, active) in detail + trace views; FTS sanity (`MATCH` a known error string that previously fell victim to 500-char truncation — should now hit); summaries still present on previously-summarized sessions (preserve/restore proof); `bun run restart` to bring launchd back.
  - Cleanup: delete `strip.ts` (its surviving logic already ported to `projection.ts` in U3); re-anchor `canary.ts` comments to the vendored parser as the parse step of record; tree logic now exists only in `server/trace/active-path.ts`; grep for dangling `stripSession` imports.
- **Execution note:** cleanup commits land only AFTER the force run verifies clean — the old code is the rollback path while the run is unproven.
- **Test scenarios:**
  - Happy path: (covered by U4 unit tests) — this unit's "tests" are the post-run checks above, executed and recorded in the PR/plan notes.
  - Edge cases: archive-only session reingested successfully; neither-file-nor-archive session untouched with old rows intact.
  - Error: force run interrupted midway → per-session transactionality means every completed session is consistent and the run can simply be restarted (force reingests them again — idempotent, just slower).
- **Verification:** full gate: `bun test server/`, `bunx tsc --noEmit`, `bun run build`, post-run checklist above, service healthy via `/api/ingest/status` after `bun run restart`.

## Risks

| Risk | Mitigation |
|---|---|
| **Preserve/restore regression** (summaries/insights silently wiped for 3,293 sessions during force-reingest) | U4 characterization tests written against the CURRENT code before the rewrite; both `isSummaryStale` branches covered; U8 post-run check explicitly verifies summaries survived. DB backup before the force run. |
| **DB grows past the 3–5 GB estimate** | `raw_records` dedup (D2) is the main lever already applied; U8 measures and investigates > 6 GB. Worst case is disk cost, not correctness — raw source + archive still exist for re-projection with tighter rules. |
| **FTS drop+recreate or force-reingest corrupts search** | SQLite ≥ 3.46 startup assertion (D12) guards the known `SQLITE_CORRUPT_VTAB` bug; `runOnce` guard prevents double-migration; U1 tests the delete-trigger path explicitly post-recreate. |
| **Ingest tick cost balloons** (ChunkBuilder now runs per changed session every 30s for active sessions) | Same O(n) work the trace endpoint previously paid per page view — moved earlier, paid once per file change instead of per request. Only changed files reingest (size+mtime gate). If an active 47 MB session makes ticks overlap, the existing `ingestProgress.running` guard already serializes; U6 makes any backlog visible. |
| **Force run takes many hours / interrupted** | Per-session transactions make interruption safe; run via CLI with server stopped; restart is idempotent. Schedule overnight. |
| **Subagent zero-steps regression** (isSidechain re-flag) | Called out in U4 approach with a dedicated test scenario; the fix lives in shaping code U4 must not touch. |
| **Chat/Ask SQL agent silently blind to new schema** | U5 explicitly edits the hand-written prompt in `chat.ts` — it is a named deliverable, not a hope. |
| **Frontend perf regression on 5000+-message sessions** | Virtualization (U7) + module-scope `REMARK_PLUGINS` + string-length collapse gating; manual QA script against the worst-case session is U7's verification. |
| **Uncommitted-tree baseline** | Prerequisite step (commit current tree) stated at the top; every unit lands on top of that commit. |
| **Sequence vs timestamp ordering bugs resurface in new queries** | Every new ORDER BY in U5 uses `timestamp ASC, sequence ASC` per the project CLAUDE.md rule; called out in U5 approach. |

## Sources

- `plans/2026-08-10-unified-parser-architecture.md` — authoritative requirements/target doc (agreed direction; decisions not re-litigated here)
- `plans/2026-08-09-arch-review-and-parser-panel.md` — prior program this builds on
- Repo files inspected 2026-08-10: `server/db.ts`, `server/ingest.ts`, `server/strip.ts`, `server/canary.ts`, `server/archive.ts`, `server/chat.ts`, `server/config.ts`, `server/index.ts` (endpoints/prepared statements), `server/trace/index.ts`, `server/trace/active-path.ts`, `server/trace/VENDORED.md`, `server/trace/vendor/main/types/messages.ts`, `web/components/TraceView.tsx`, `web/components/SessionDetail.tsx`, `web/traceTypes.ts`, `web/sessionFormat.tsx`, `web/traceFormat.ts`
- Empirical verification (this machine, 2026-08-10): bun 1.3.14 / SQLite 3.51.0 — external-content FTS5 with porter tokenizer + faceted same-named columns + delete-trigger round trip (scratch test, /tmp)
- SQLite FTS5 official docs (https://www.sqlite.org/fts5.html) — tokenizer fixed at creation, column-filter syntax, token limits
- oven-sh/bun#31247 — bundled SQLite 3.43.2 FTS5 external-content corruption risk
- cass (`Dicklesworthstone/coding_agent_session_search`) changelog 0.1.35→0.6.23 — secret redaction (v0.2.2), mtime trigger (v0.5.2), overlong-term hotfix + truthful health (v0.6.23); design validation (996k msgs / 5.4 GB)
- Secret-detection patterns: gitleaks/detect-secrets architecture writeups; Shannon-entropy detection references (see research digest in task context)
- `@tanstack/react-virtual` vs `react-window` 2026 comparisons (npm-compare, TanStack discussion #459)
