# QA Checklist: Search Results Redesign

## Setup
- Dev server should already be running. If not: `cd /Users/blake/Documents/Development/tools/session-explorer && bun run dev`
- Open `http://localhost:5199` in the browser

## 1. Basic Search
- [ ] Click the search icon to open search UI
- [ ] Type "qa" in the search box
- [ ] Results should appear after a brief debounce (~300ms)
- [ ] Screenshot the results page

## 2. Card Layout (per card, check these elements in order)
- [ ] **File pills** are the first thing in each card — colored chips like `[+file.md] [~Component.tsx]`
- [ ] **Summary bullets** below files — `·`-prefixed, max 3 lines, each line-clamped to 1 line
- [ ] **Date + time + duration + match count** — e.g. "Mar 15 · 11:43 AM – 10:07 PM · 10h 24m" with a blue "11 matches" pill
- [ ] **Tertiary meta** — "433 messages · 63 from you" in dim text
- [ ] **Match snippets** — colored left borders (blue = You, orange/claude = Claude), role labels, 2-line clamp
- [ ] **No title row** — the old first-user-message title should NOT appear

## 3. Branch Grouping (default mode)
- [ ] Results are grouped under branch headers like `v4-dual-write-bridge | 2 sessions · 13 matches | Latest: Mar 16`
- [ ] Branch badge is purple pill in the group header
- [ ] Individual cards do NOT show branch badge (it's in the header)
- [ ] Groups sorted by most recent session date (newest group first)
- [ ] Sessions with no branch go in an "Other" group at the bottom

## 4. Group Toggle
- [ ] Toolbar shows "Group by:" with a segmented control: None | Branch | Date
- [ ] Default is "Branch"
- [ ] Switch to "None" — cards render flat, each card shows its branch badge inline
- [ ] Switch to "Date" — cards group under headers like "Today", "Yesterday", "This Week", "This Month", "Older"

## 5. Sort Dropdown
- [ ] Sort dropdown is in the toolbar next to the group toggle
- [ ] Options: Newest first, Oldest first, Most relevant, Most matches
- [ ] Switching to "Most matches" reorders results within groups
- [ ] Switching to "Most relevant" keeps FTS5 rank order

## 6. Filter Bar
- [ ] Filter chips appear below the toolbar: "All roles" / "Your messages" / "Claude's" | "1+ matches" / "3+ matches" / "5+ matches" | "Has files" | branch dropdown
- [ ] **Role filter**: Click "Your messages" — only snippets from user role show. Sessions with zero user snippets disappear entirely.
- [ ] **Role filter**: Click "Claude's" — same but for assistant role
- [ ] **Min matches**: Click "3+ matches" — sessions with <3 matches disappear. File-only matches (0 text matches) also disappear.
- [ ] **Min matches**: Click "5+ matches" — even fewer results
- [ ] **Has files**: Toggle on — sessions without files_changed disappear
- [ ] **Branch dropdown**: Select a specific branch — only that branch's sessions show
- [ ] Active filter chips should be highlighted (blue border/text)
- [ ] Combining filters works (e.g. "Your messages" + "3+ matches" + "Has files")
- [ ] When all results are filtered out, show "No results match current filters"

## 7. Cross-Search (File Path Matching)
- [ ] Search for a filename that was edited but never mentioned in conversation (try "vite.config" or "tsconfig" or a specific component name)
- [ ] Sessions where that file was edited should appear even without text matches
- [ ] Those cards show "Matched by files changed" in italic dim text instead of snippets
- [ ] Those cards have no match count pill (match_count is 0)

## 8. Navigation
- [ ] Click a card — navigates to `/session/<id>`
- [ ] Click a snippet — navigates to `/session/<id>?msg=<sequence>` (specific message)

## 9. Toolbar Stats
- [ ] Toolbar shows: "X sessions · Y matches · Z branches"
- [ ] Numbers update as you type different queries

## 10. Files Tab
- [ ] Switch to "Files" tab — file search still works as before (unchanged)
- [ ] Results grouped by category (Docs, Viz, Code) with colored badges
