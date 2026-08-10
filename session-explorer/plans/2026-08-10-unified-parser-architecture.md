# Unified Parser Architecture

Date: 2026-08-10
Status: agreed direction, not yet implemented
Context: follow-up to `plans/2026-08-09-arch-review-and-parser-panel.md` . The trace
parser was built as a separate read-time path; the original intent was for it to
replace the main parse path. This doc captures the agreed target architecture.

## Problems with current architecture

1. **Two parsers over the same input.** `server/strip.ts` (homegrown, lossy) feeds
   SQLite at ingest; the vendored claude-devtools parser (`server/trace/`) re-parses
   raw JSONL per trace request. Branch-selection logic is duplicated (the
   `isAbandonedBranch` port proved the divergence risk is real).
2. **Lossy is a storage decision, but should only be a projection decision.**
   strip.ts truncates tool results at 500 chars, collapses skill/system dumps, and
   drops assistant text under 100 chars — permanently. Session detail shows a
   stripped conversation; search can only find what survived stripping.
3. **Trace view depends on the original file.** `GET /api/sessions/:id/trace`
   re-parses `~/.claude/projects/...jsonl` at request time. When Claude Code prunes
   old sessions, trace breaks — even though `data/archive/` holds a byte-for-byte
   gzip copy that nothing reads.
4. **Assumption "lossy is needed for search speed/size" is empirically wrong.**
   cass indexes 996k messages / 5.4 GB SQLite with FTS5 and is fast. Our 9x
   reduction (14 GB raw → 1.6 GB DB) buys search *relevance* and summarize token
   savings — not speed.

## Target architecture

```
raw JSONL ──ingest (once per file-size change)──► vendored parser (THE parse)
   │                                                    │
   └─► gzip archive (data/archive/)  ◄── parse-source   ▼
        fallback when Claude Code    normalize into SQLite rows (full fidelity)
        prunes the original            │
                                       ├─ content column: clean projection
                                       │  (text verbatim; tool calls/results
                                       │   reduced for search + display lists)
                                       ├─ raw payload column (extra_json-style):
                                       │  full fidelity per message/step
                                       └─ structure: role, type, tool name/input,
                                          timestamps, tree/step ordering
                                       │
                    ┌──────────────────┴───────────────────┐
                    ▼                                      ▼
             FTS5 over content                 ALL UI reads from rows:
             (porter tokenizer,                session detail (full fidelity,
              faceted columns)                 paginated), trace view (no
                                               re-parse), search, Ask/chat SQL
```

Key properties:

- **One parse per file change, at ingest.** No parse at read time, ever. Page
  loads are SQL queries.
- **Store everything, index a projection.** The lossy transform survives only as
  the rule for what goes in the FTS-indexed `content` column and what feeds the
  summarizer. Full payload sits beside it in the same row. Nothing is
  unrecoverable.
- **SQLite is the single serving store.** No JSON blob cache on disk. Rows enable
  pagination/windowing (big sessions fetch first N steps, virtualize the rest),
  SQL over tool usage, and the Ask/chat path extends naturally.
- **Archive becomes load-bearing.** Ingest falls back to `data/archive/*.jsonl.gz`
  when the original is pruned. Trace/detail views survive pruning because they
  read the DB, not the file.
- **strip.ts shrinks to a projection function.** No file reading, no JSON parsing,
  no tree walking — those belong to the vendored parser. `canonicalBranch` /
  `isAbandonedBranch` exist in exactly one place (`server/trace/active-path.ts`).

## Search infra (adopted from cass inspection)

cass (`Dicklesworthstone/coding_agent_session_search`) validates the design: it
stores a clean projection in `content` (tool calls as one-liners, ~221 chars avg
for agent messages), full raw payload in `extra_json`, FTS5 over the projection.
Same SQLite+FTS5 stack we already run — the differences worth adopting:

1. **Porter tokenizer** on the FTS table (`tokenize='porter'`) — stemming, so
   "searching" matches "search". One-line change + reindex.
2. **Faceted FTS columns** — index title/workspace alongside content so queries
   can column-filter in one MATCH expression.
3. **content / raw split per row** — the core store-full/index-projection pattern.
4. **Deliberate difference from cass**: cass does not index tool result bodies at
   all. We keep indexing them (cleaned/truncated in the projection) — "which
   session saw this error string" is a real query pattern and our advantage.
5. **Skip for now**: semantic/vector search (fastembed, ~90 MB model, separate
   index). Revisit only if lexical search proves insufficient.

Additional steals from the cass changelog (0.1.35 → 0.6.23 review, 2026-08-10):

6. **Secret redaction at ingest** (cass v0.2.2) — detect and redact secrets in
   tool-result content before it lands in the DB projection. Also keeps secrets
   out of summarize/insights LLM calls. Do this in the new projection step.
7. **Overlong-FTS-term guard** (cass v0.6.23 hotfix) — indexing full tool results
   means base64 blobs / minified JS produce giant tokens that bloat or break
   FTS5 (they hit failures at terms >1024 bytes). Projection rule: drop or split
   tokens over ~64 chars before they reach the indexed column.
8. **mtime fallback for reingest trigger** (cass v0.5.2) — our trigger is
   file-size-only; add mtime comparison so a same-size rewrite still reingests.
9. **Truthful ingest health** (cass v0.6.23) — expose last-tick time, pending
   count, and recent failures from the auto-ingest loop instead of treating
   "process is running" as healthy.

Already banked: our `messages_fts` is external-content (`content='messages'`),
equivalent to cass's v0.2.5 contentless-mode DB-size win.

## UI consequences

- **Session detail becomes full-fidelity.** Rendered from full rows, not stripped
  ones. Big tool results render collapsed by default with expand-on-click. List
  virtualization required (sessions run 5000+ messages).
- **Trace view reads DB rows** instead of hitting a re-parse endpoint. `?full=1`
  raw-model export remains a separate drill-down path (auth/throttling question
  still open — a full payload hit ~148 MB once).
- **Search hits deep-link into full content** — no more "found it but the
  truncated row cuts off the match".

## Migration sketch

1. **Schema**: extend/replace `messages` with full-fidelity rows — clean `content`
   projection + raw payload column + structural fields. Add FTS5 table with porter
   tokenizer + facet columns.
2. **Ingest**: replace `stripSession()` call with vendored parse → normalize →
   project. Keep archive + canary + derived-data preservation exactly as-is.
3. **Serving**: session detail + trace endpoints read rows (paginated); delete the
   per-request re-parse from the trace endpoint; add archive fallback to ingest.
4. **Reingest**: force-reingest all ~3,300 sessions (parse cost is the same O(n)
   line parse we already pay; expect DB to grow ~1.6 GB → 3–5 GB).
5. **Cleanup**: strip.ts reduced to projection helpers; duplicated tree logic
   deleted; `messages_fts` rebuilt.

## Open questions

- Exact projection rules for tool results in the indexed column (length cap,
  which tools' outputs are search-worthy).
- `?full=1` trace export: auth/throttle or drop it.
- Whether summaries should re-generate from the richer rows (probably not —
  existing summaries stay, rule unchanged).

## Numbers (measured 2026-08-10, this machine)

| Thing | Size |
|---|---|
| Raw JSONL corpus (`~/.claude/projects`) | 14 GB |
| Current lossy DB (3,293 sessions, 1.4 M messages) | 1.6 GB |
| Lean trace payload for worst session (6.7k msgs, 47 MB raw) | 2.7 MB (~17x reduction) |
| cass DB (996k messages, near-full fidelity + FTS) | 5.4 GB |
