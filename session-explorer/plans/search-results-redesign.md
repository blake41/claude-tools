# Search Results Information Architecture Redesign

## Context

The search results in session-explorer are functionally useless for finding the right session. The user's core question is: **"Which session was the one where I was doing X?"** The current UI dumps matches without helping answer that question.

Key problems:
- The "title" (first user message) is often a slash command or rambling instruction — not informative
- Files changed are the #1 signal for what a session produced, but they're squeezed into a narrow right column
- The AI-generated summary exists but is formatted as a dense inline string
- Match snippets dominate the card despite being the least useful for identifying the right session
- No grouping by branch (the strongest memory anchor alongside date)

The user chose **Option 10** from the design exploration: **Group by Branch + Sort Within Groups**, inspired by Stripe's pattern. The idea is that branches represent projects/features, so grouping by branch clusters related sessions together.

## Current State

Some changes are already in place from the first pass:
- **Server**: `sort` query param works (date/date_asc/relevance/matches) in `server/index.ts`
- **Frontend**: `SortDropdown` component, `DateGroupHeader`, `getDateGroup()` all exist
- **Card**: Half-redesigned — has `FilePills` component (horizontal file chips) and summary bullets, but the layout isn't substantially different from before. Old CSS grid layout was removed, now using flex column with cards.

## Plan

### 0. Structured message types — richer data model

The JSONL has rich structure we're currently flattening. Each conversation turn contains typed blocks: `text`, `tool_use`, `tool_result`, `thinking`. Currently we only store `text` blocks in `messages` and put tool calls in a separate `tool_calls` table with summaries. Tool results (file contents, bash output, errors) are discarded entirely.

**Schema change**: Add `message_type TEXT DEFAULT 'text'` column to `messages`:

| message_type | role | content (FTS-indexed) |
|---|---|---|
| `text` | user | "fix the login bug" |
| `text` | assistant | "Let me check the auth module" |
| `tool_use` | assistant | "Read: /path/to/auth.ts" |
| `tool_result` | user | [truncated output — first 500 chars] |

Everything stays in one table, one FTS index. The `message_type` column enables filtering.

**Parsing tool_use content** — reuse existing `summarizeToolInput()` from `strip.ts`, prefix with tool name:
- `Read: /path/to/auth.ts`
- `Write: /path/to/new-file.ts`
- `Bash: bun run build`
- `Grep: "pattern" in /path`
- `Agent: "Research search UI patterns"`

**Parsing tool_result content** — truncate to first 500 chars after stripping line-number prefixes and excessive whitespace. This captures error messages, success confirmations, and the start of file/bash output without bloating the index.

**Drop `tool_calls` table** — nothing in the frontend uses it. The only consumer is `chat.ts` which references it in a system prompt; update that to query `messages WHERE message_type = 'tool_use'` instead.

**Files to modify:**
- `server/db.ts` — add `message_type` column migration, drop `tool_calls` table + indexes
- `server/strip.ts` — emit tool_use and tool_result as StrippedMessage entries with `messageType` field
- `server/ingest.ts` — pass `message_type` when inserting messages, remove `insertToolCall` and `deleteSessionToolCalls`
- `server/chat.ts` — update schema description to use `messages.message_type` instead of `tool_calls` table
- `server/index.ts` — add `m.message_type` to search query SELECT, return in API response
- `web/types.ts` — add `message_type` to SearchMatch type

**Migration**: `ALTER TABLE messages ADD COLUMN message_type TEXT DEFAULT 'text'` + `DROP TABLE IF EXISTS tool_calls`. Existing message rows get `'text'` which is correct. Re-ingest to populate tool_use/tool_result rows. FTS rebuild happens on startup.

### 0b. Search filters — all client-side

**All filters are client-side** — the API already returns every matching session with enough metadata (`workspace_id`, `git_branch`, `started_at`, `role` on each match, `files_changed`) to filter in the browser without re-fetching. For a local SQLite DB this is fine.

**Filter bar** (horizontal chips below tabs/sort):

- **Message type**: "Conversation" (default, text only) / "All" (include tool calls & results) / "Tools only" — powered by the new `message_type` field. Default excludes tool noise; "All" searches everything; "Tools only" finds specific commands/file operations
- **Role**: "All" / "Your messages" / "Claude's" — hides snippets from the other role. If a session has zero visible snippets after filtering, hide the session. Most useful: "I know *I* said something about QA"
- **Min matches**: "1+" (default) / "3+" / "5+" — hide incidental mentions. A session with 11 matches is *about* QA; a session with 1 probably isn't.
- **Has files**: toggle — only show sessions that produced artifacts
- **Branch**: dropdown populated from distinct branches in current results — "I know it was on the v4 branch"
- **Date range**: "All time" (default) / "Last 7 days" / "Last 30 days" — quick temporal scoping

**Implementation**: Filter chips in a bar between sort controls and results. Active filters show as highlighted pills. All filtering happens in `renderMessageResults()` before grouping/rendering.

**File**: `web/components/Search.tsx` — add filter state, filter logic, filter chips UI

### 1. Option 10 — exact reference HTML and CSS to match

The implementation must match this design exactly. These are the styles and markup from the chosen design option.

#### CSS (relevant classes from design options HTML)

```css
/* Result card */
.result-card {
  background: var(--bg-primary); border: 1px solid var(--border); border-radius: 8px;
  padding: 14px 16px; margin-bottom: 8px; cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease;
}
.result-card:hover { border-color: var(--accent-blue); background: #161b2299; }

/* Result card content */
.result-title { font-size: 13px; font-weight: 600; color: var(--text-primary); margin-bottom: 4px; display: flex; align-items: center; gap: 8px; }
.result-date { font-size: 11px; color: var(--text-dim); font-family: var(--font-mono); }
.result-branch {
  font-size: 10px; font-family: var(--font-mono); padding: 1px 7px; border-radius: 99px;
  background: rgba(188,140,255,0.12); color: var(--accent-purple);
}
.result-match-count {
  font-size: 10px; padding: 1px 7px; border-radius: 99px;
  background: rgba(88,166,255,0.12); color: var(--accent-blue); font-weight: 600;
}
.result-summary { font-size: 12px; color: var(--text-secondary); margin-top: 6px; line-height: 1.5; }
.result-summary mark { background: rgba(210,153,34,0.25); color: var(--accent-orange); border-radius: 2px; padding: 0 2px; }
.result-stats { font-size: 10px; color: var(--text-dim); margin-top: 6px; display: flex; gap: 12px; }

/* Match snippets */
.result-snippet { font-size: 11px; color: var(--text-secondary); padding: 8px 10px; background: rgba(13,17,23,0.5); border-radius: 6px; margin-top: 8px; border-left: 2px solid var(--border); }
.result-snippet .role { font-size: 10px; font-weight: 600; text-transform: uppercase; margin-bottom: 2px; }
.result-snippet .role.you { color: var(--accent-blue); }
.result-snippet .role.claude { color: var(--claude-text); }

/* View toggle (Group by: None | Branch | Date) */
.view-toggle { display: flex; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
.view-toggle button {
  font-size: 11px; padding: 4px 10px; background: none; border: none; color: var(--text-dim);
  cursor: pointer; font-family: var(--font-ui); transition: all 0.15s;
}
.view-toggle button:not(:last-child) { border-right: 1px solid var(--border); }
.view-toggle button.active { background: rgba(88,166,255,0.1); color: var(--accent-blue); }
.view-toggle button:hover:not(.active) { color: var(--text-secondary); }

/* Sort dropdown */
.sort-btn {
  font-size: 11px; font-family: var(--font-ui); padding: 4px 10px; border-radius: 6px;
  border: 1px solid var(--border); background: transparent; color: var(--text-secondary);
  cursor: pointer; transition: all 0.15s ease; display: flex; align-items: center; gap: 4px;
}
.sort-btn:hover { border-color: var(--text-secondary); color: var(--text-primary); }
.sort-dropdown-menu {
  display: none; position: absolute; top: 100%; left: 0; margin-top: 4px;
  background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px;
  padding: 4px; min-width: 180px; z-index: 50; box-shadow: 0 8px 24px rgba(0,0,0,0.4);
}
.sort-dropdown-item {
  display: flex; align-items: center; justify-content: space-between;
  font-size: 12px; padding: 7px 10px; border-radius: 5px; cursor: pointer;
  color: var(--text-secondary); transition: background 0.1s;
}
.sort-dropdown-item:hover { background: rgba(88,166,255,0.08); color: var(--text-primary); }
.sort-dropdown-item.active { color: var(--accent-blue); }
```

#### HTML structure — toolbar

```html
<!-- Toolbar: result count + group toggle + sort dropdown -->
<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:8px;">
  <div class="demo-meta" style="margin:0">
    <span class="count">23 sessions</span> · 87 matches · 5 branches
  </div>
  <div style="display:flex;gap:8px;align-items:center;">
    <span style="font-size:11px;color:var(--text-dim)">Group by:</span>
    <div class="view-toggle">
      <button>None</button>
      <button class="active">Branch</button>
      <button>Date</button>
    </div>
    <div class="sort-dropdown" style="margin-left:4px;">
      <button class="sort-btn">Date ↓ <span class="arrow">▼</span></button>
      <div class="sort-dropdown-menu">
        <div class="sort-dropdown-item active">Date: Newest <span class="check">✓</span></div>
        <div class="sort-dropdown-item">Most matches</div>
        <div class="sort-dropdown-item">Relevance</div>
      </div>
    </div>
  </div>
</div>
```

#### HTML structure — branch group header

```html
<div style="display:flex;align-items:center;gap:8px;padding:8px 0 6px;border-bottom:1px solid var(--border);margin-bottom:8px;margin-top:16px;">
  <span class="result-branch" style="font-size:11px;padding:2px 10px;">v4-dual-write-bridge</span>
  <span style="font-size:10px;color:var(--text-dim);">2 sessions · 13 matches</span>
  <span style="font-size:10px;color:var(--text-dim);margin-left:auto;">Latest: Mar 16</span>
</div>
```

#### HTML structure — result card (within a branch group)

```html
<div class="result-card">
  <div class="result-title">
    <span>/resume-session The safe approach...</span>
    <span class="result-match-count">11</span>
  </div>
  <div class="result-date">Mar 15 · 11:43 AM – 10:07 PM · 10h 24m</div>
  <div class="result-stats"><span>433 messages</span><span>63 from you</span></div>
</div>
```

### 2. What to change from the Option 10 prototype

The prototype is a starting point. We enhance it with the information hierarchy we agreed on:

**Inside each result card, the content order is:**

1. **File pills** (the #1 signal) — `[+staging-qa-tasks.md] [~PreviewOverlays.tsx] [~ActionTypeEditForm.tsx]` — horizontal wrapping pills using `file-cat-*` color classes. Up to 6 files.
2. **Summary as bullet list** — parsed from `\n`-separated summary. Max 3 bullets, `·`-prefixed, each line-clamped to 1 line. Uses `.result-summary` styles.
3. **Date + duration + match count** — using `.result-date` and `.result-match-count` styles. When grouped by branch, no branch badge per-card (it's in the group header). When not grouped, show branch badge inline.
4. **Tertiary meta** — message count, user message count. Uses `.result-stats` styles.
5. **Match snippets as mini-conversation** — each snippet uses `.result-snippet` styling with colored left border. `border-left: 2px solid var(--accent-blue)` for user, `border-left: 2px solid var(--claude-text)` for Claude. Role label uses `.role.you` / `.role.claude`. 2-line clamp per snippet. Snippets separated by 8px gap. These show what was happening *around* the match.

**No title** — removed entirely. Summary + files tell you everything.

**Branch group header** — exactly as in the prototype HTML above. Sort groups by latest session date (most recent first). Within each group, sessions sorted by the current sort mode. Sessions with no branch go in an "Other" group at the bottom.

**Group by toggle** — "None" | "Branch" | "Date" segmented control using `.view-toggle` styles. Default: "Branch".

**File**: `web/components/Search.tsx` — rewrite `SearchResultCard`, add `BranchGroupHeader`, add `GroupToggle`, update `renderMessageResults()`

### 3. Cross-search: merge file-path matches into search results

The FTS index only covers conversation text. Searching for "SessionCard" misses sessions where `SessionCard.tsx` was *edited* but never mentioned in conversation. The `session_files` table already has this data — we just need to union it into `/api/search` results.

**Server change** — `server/index.ts`, `/api/search` handler:

After the FTS query, run a secondary LIKE query against `session_files`:

```sql
SELECT DISTINCT sf.session_id, sf.file_name, sf.file_path
FROM session_files sf
WHERE (sf.file_name LIKE '%query%' OR sf.file_path LIKE '%query%')
AND sf.file_path NOT LIKE '%.png'
AND sf.file_path NOT LIKE '%.jpg'
LIMIT 100
```

For any `session_id` not already in `matchesBySession` from FTS hits, add it with:
- `match_count: 0` (no text matches)
- `matches: []` (no snippets)
- `match_source: 'files'` flag so the frontend can distinguish

Then enrich through the same `getSession + tags + files_changed` pipeline.

**Sort behavior**: File-only matches sort after FTS matches when using relevance sort. When using date sort, they interleave naturally by `started_at`.

**Frontend change** — `web/components/Search.tsx`:

When a result has `match_source === 'files'` and no snippets, show a subtle indicator instead of snippets: `"Matched by files changed"` in dim text. The file pills already show which files matched.

**API response change** — add `match_source: 'content' | 'files'` to each result. Default `'content'` for FTS hits.

**Files to modify:**
- `server/index.ts` — add file LIKE query, union into results, add `match_source` field
- `web/types.ts` — add `match_source` to `SearchResult` type
- `web/components/Search.tsx` — handle `match_source === 'files'` display

### 4. Cleanup dead code

Remove:
- Old `FileList` component (replaced by `FilePills`)

**Files**: `web/components/Search.tsx`

## Files to modify

1. `server/db.ts` — add `message_type` column migration, drop `tool_calls` table
2. `server/strip.ts` — emit tool_use and tool_result as StrippedMessage entries
3. `server/ingest.ts` — pass `message_type` when inserting, remove tool_calls code
4. `server/chat.ts` — update schema description
5. `server/index.ts` — add `m.message_type` to search queries + file-path cross-search union
6. `web/types.ts` — add `message_type` to SearchMatch type, add `match_source` to SearchResult
7. `web/components/Search.tsx` — card redesign, group toggle, branch grouping, filters, file-match display
8. `web/styles.css` — add Option 10 CSS classes

## Verification

1. Delete the existing DB, re-ingest to populate new message_type column
1b. Verify tool_use and tool_result rows exist: `SELECT message_type, COUNT(*) FROM messages GROUP BY message_type`
1c. `bun run build` — no errors
2. Start dev server, search for "qa"
3. Verify: results sorted by date (newest first) with date group headers
4. Switch to "Group by: Branch" — verify sessions cluster by branch with headers
5. Switch sort to "Most matches" — verify order changes within groups
6. Verify file pills are prominent and colored correctly (green for docs, blue for code, orange for viz)
7. Verify snippets read like a mini-conversation — 2 lines each, clear role labels, colored borders, visual separation between turns
8. Verify clicking a card navigates to the session
9. Verify clicking a snippet navigates to the specific message
10. Toggle "Your messages" filter — verify Claude snippets hide, sessions with 0 visible snippets hide
11. Toggle "3+ matches" — verify single-match sessions disappear
12. Toggle "Has files" — verify sessions without files_changed disappear
13. Search for a filename that was edited but never mentioned in conversation — verify the session appears with "Matched by files changed" indicator
14. Verify file-only matches sort after FTS matches in relevance mode, interleave by date in date mode
