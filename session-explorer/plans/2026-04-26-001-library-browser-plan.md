---
title: Library Browser
date: 2026-04-26
origin: plans/brainstorms/skills-browser-requirements.md
status: draft
---

# Library Browser

## Overview

Adds a "Library" section to session-explorer that browses all of the user's `~/.claude/` prompt assets — own + plugin-installed + project-scoped — for skills, agents, commands, rules, and global CLAUDE.md, with a usage panel that cross-references session-explorer's existing `messages` table.

## Problem Frame

The user has ~85 skills, 11 agents, 89 commands, plus rules, project-scoped overrides, and 5 installed plugins shipping their own. There's no consolidated view to (a) discover what exists before authoring duplicates, (b) tell which assets are actually used vs dead weight, (c) filter by namespace, scope, or inspiration source. Session-explorer already has the per-session tool-call data needed to answer the usage question, so the cross-reference is essentially free if the browser lives in the same app.

## Requirements Trace

| Req | Unit |
|---|---|
| R1 own skills | U1 |
| R2 own agents | U1 |
| R3 own commands (with namespace inference) | U1 |
| R4 rules | U1 |
| R5 global CLAUDE.md | U1 |
| R6 plugin-shipped assets | U1, U5 |
| R7 project-scoped assets | U1, U5 |
| R8 hooks (stretch) | U5 |
| R9 type field | U1 |
| R10 scope badge | U1 |
| R11 namespace prefix | U1 |
| R12 created date | U1 |
| R13 inspiration | U1 |
| R14 filter facets | U2, U3 |
| R15 sortable columns | U2, U3 |
| R16 free-text search | U2, U3 |
| R17 default sort = last-used | U2, U3 |
| R18 detail view (frontmatter table + body) | U4 |
| R19 open in editor | U4 |
| R20 show in Finder | U4 |
| R21 usage panel | U2, U4 |
| R22 usage timeline | U2, U4 |
| R23 skill invocation detection | U2 |
| R24 agent invocation detection | U2 |
| R25 command invocation detection | U2 |
| R26 always-on (rules/CLAUDE.md/hooks) | U4 |
| R27 top-level nav | U3 |
| R28 routes | U3, U4 |
| R29 API routes | U2 |
| R30 startup scan + manual re-scan | U1, U2 |
| R31 usage on-the-fly | U2 |

## Scope Boundaries

**In scope:** read-only browser, ~185+ markdown artifacts, plugin items (hidden by default), project-scoped artifacts, usage stats, sparkline timeline.

**Out of scope:** editing, creating, deleting, executing skills, syncing, watching the filesystem, non-markdown configs (settings.json), memory files, plans/, paste-cache, debug logs.

## Context

### Repo: `/Users/blake/Documents/Development/tools/session-explorer/`

Stack: Express + React 18 + SQLite (better-sqlite3) + TanStack Router + Tailwind 4 + Vite, on Bun. Production runs under launchd (`com.blake.session-explorer`); dev is `bun run dev` (server :5198, web :5199).

### Key existing patterns to follow

- **Server routes** — `server/index.ts` registers `app.get("/api/...")` handlers; pattern is: extract filters from `req.query`, validate, run a prepared SQLite statement from `server/db.ts`, return `{ ... }` JSON. Example: `app.get("/api/files/search", ...)` (server/index.ts:1214).
- **Tool-call schema** — `messages` table columns: `id, session_id, role, content, timestamp, sequence, message_type, source, tool_use_id, tool_name, tool_input` (server/db.ts:43–50). `message_type='tool_use'` filters tool calls. `tool_input` is a JSON string — parseable in app code or via SQLite's `json_extract`.
- **Slash commands** — Stored as `messages` rows with `role='user'`, `message_type='text'`, `content` starting with `/`. No dedicated column.
- **Frontend routes** — `web/router.ts` defines flat `createRoute({ getParentRoute, path, validateSearch })`. Add new routes there; export them; register in `web/main.tsx` route tree.
- **List/detail pattern** — `web/components/SessionList.tsx` (line ~112) fetches `/api/sessions?...`, renders date-grouped list with client-side filter chips. `web/components/SessionDetail.tsx` shows the message stream. Library should mirror: list → detail.
- **Markdown rendering** — Custom regex-based renderer in `web/sessionFormat.tsx` exports `renderMarkdown(text: string): string`. Reuse for the body. (No external markdown library — keep parity.)
- **Frontmatter parsing** — Not installed. Add `gray-matter` (~150 KB).
- **Nav** — `web/components/Sidebar.tsx` (around lines 307–330) has the bottom nav block with `/insights` and `/meta` links. Add Library here.
- **Workspaces** — Table `workspaces (id, path, dir_name, display_name, session_count, last_activity)`. `path` is the absolute project root, usable to scan `<path>/.claude/`.
- **Plugin manifest** — `~/.claude/plugins/installed_plugins.json` lists installed plugins with `installPath`. Walk those instead of globbing `cache/`.
- **Visualization** — No chart library. Use native HTML divs with Tailwind percentage widths (pattern from `web/components/ScoreTrends.tsx`).

### Asset layout on disk (verified)

Own (user-authored):
- `~/.claude/skills/<name>/SKILL.md` — most own skills are folder-based
- `~/.claude/skills/<namespace>/<name>.md` or `~/.claude/skills/<namespace>/<name>/SKILL.md` — namespaced (qa:, arch-viz:, codex:, prompts:, spike:, v4:, twitter:, design:, etc.) — flat-file vs folder is mixed
- `~/.claude/agents/<name>.md` and `~/.claude/agents/<subdir>/<name>.md` (review/, codex/)
- `~/.claude/commands/<name>.md` and `~/.claude/commands/<namespace>/<name>.md` (qa/, v4/, codex/, etc.)
- `~/.claude/rules/<name>.md`
- `~/.claude/CLAUDE.md`

Plugin-installed (manifest at `~/.claude/plugins/installed_plugins.json`):
- `<installPath>/skills/<name>/SKILL.md`
- `<installPath>/commands/<name>.md`
- `<installPath>/agents/<name>.md`

Project-scoped (per workspace):
- `<workspace.path>/.claude/skills/<name>/SKILL.md`
- `<workspace.path>/.claude/commands/<...>.md`
- `<workspace.path>/.claude/agents/<...>.md`

## Key Technical Decisions

- **TD1: In-memory cache populated at startup.** Build a `Map<id, LibraryArtifact>` once, refresh via `POST /api/library/rescan`. Total ~185–250 markdown files; the walk + parse is sub-second. No filesystem watcher in v1.
- **TD2: Stable artifact ID = `${type}:${scope}:${name}`.** `type` ∈ `skill | agent | command | rule | claude-md | hook`. `scope` ∈ `global | plugin:<plugin-name> | project:<workspace-path>` . `name` is the namespaced display name (`qa:debug`). The same name can exist in multiple scopes — they remain distinct artifacts (DQ7).
- **TD3: Add `gray-matter` as a runtime dependency.** Existing `yaml` is not present; gray-matter handles both YAML and JSON frontmatter, ships as ~150 KB, MIT-licensed. No good reason to roll our own.
- **TD4: Use `installed_plugins.json` as plugin manifest.** Walk `installPath` for each entry rather than globbing `cache/` — cache may contain stale SHA-pinned copies (verified for `playground` plugin).
- **TD5: Plugin items hidden by default in list view.** Filter `?include_plugins=0` is the default. UI exposes a toggle. (Per brainstorm D8.)
- **TD6: Project-scoped scanning iterates the `workspaces` table.** Walk `<row.path>/.claude/(skills|agents|commands)` for every workspace row at scan time. If a workspace path no longer exists (deleted dir), skip silently.
- **TD7: Usage detection via three SQL queries**, on demand per artifact:
  - **Skills:** `SELECT ... FROM messages WHERE tool_name = 'Skill' AND json_extract(tool_input, '$.skill') = ?` .
  - **Agents:** `SELECT ... FROM messages WHERE tool_name = 'Agent' AND json_extract(tool_input, '$.subagent_type') = ?` .
  - **Slash commands:** `SELECT ... FROM messages WHERE role='user' AND message_type='text' AND (content = '/<name>' OR content LIKE '/<name> %')` .
  Aggregate as: total count, last_used (max timestamp), top-5 sessions by count, daily-bucketed counts for sparkline (last 90 days).
- **TD8: Open-in-editor uses `cursor://file/<absolute-path>` by default.** Configurable via `LIBRARY_EDITOR_SCHEME=cursor|vscode` env var (default `cursor`). Detail page renders an `<a href="...">` — the browser hands off to LaunchServices.
- **TD9: Show-in-Finder via a small backend endpoint** that runs `open -R <path>` on macOS. Avoids browser sandbox issues with `file://` URLs and the parent-directory dance.
- **TD10: Sparkline = native HTML.** Daily buckets, max-normalized, render `<div style={{width: pct}}>` divs in a flex row. Color: a single Tailwind class. ~30 lines of JSX, no dependency.
- **TD11: Frontmatter parsing is best-effort.** If frontmatter is missing, malformed, or non-YAML, fall back to `created = file ctime`, `description = first H1 or first paragraph`, `inspiration = null`. Never throw; record `parse_error: string` in the artifact for surfaced in the detail view.
- **TD12: Routes:**
  - Frontend: `/library` (list, with `?type=&scope=&ns=&q=&sort=&include_plugins=`), `/library/$id` (detail; `id` = url-safe encoding of `${type}:${scope}:${name}`)
  - API: `GET /api/library`, `GET /api/library/:id`, `GET /api/library/:id/usage`, `POST /api/library/rescan`, `POST /api/library/show-in-finder` (body: `{path}`)

## Open Questions

### Resolved During Planning

- **DQ1 plugin paths** — Plugins listed in `~/.claude/plugins/installed_plugins.json`; walk each `installPath/(skills|agents|commands)`.
- **DQ2 schema** — `messages.tool_name` + `messages.tool_input`; slash commands via `content` LIKE pattern.
- **DQ3 editor scheme** — `cursor://` default, configurable via env.
- **DQ4 project scan** — Walk every row in `workspaces` table.
- **DQ5 UI layout** — Master-detail mirroring SessionList → SessionDetail.
- **DQ6 materialize vs on-the-fly** — On-the-fly. ~250 artifacts × ~15k messages → fast enough.
- **DQ7 multi-location dedup** — Don't dedup; show each scope as its own row with a scope badge.

### Deferred to Implementation

- **IQ1:** Whether to display fenced code blocks in the markdown body with syntax highlighting. The existing `renderMarkdown` handles fences without highlighting. Acceptable for v1; revisit if the body looks ugly.
- **IQ2:** Exact icon for the Library nav entry. Try Lucide's `library` or `book-open` and pick whichever reads.
- **IQ3:** Whether to include the `~/.claude/CLAUDE.md` body as one artifact or split out the rules sections it includes-by-reference. Default: keep as one.
- **IQ4:** Sparkline bucket size — daily for 90 days vs weekly for 365. Pick daily; switch if it looks too sparse for low-usage skills.

## Implementation Units

### Unit 1: Library data layer (server)

- [x] **Goal:** Walk every relevant `.claude/` location, parse frontmatter, build an in-memory `Map<string, LibraryArtifact>` keyed by artifact ID. Expose `loadLibrary()` and `getArtifact(id)`.
- **Requirements:** R1–R7, R9–R13, R30 (startup scan)
- **Dependencies:** none
- **Files:**
  - create `server/library/types.ts` — `LibraryArtifact`, `LibraryScope`, `LibraryType` types
  - create `server/library/scan.ts` — filesystem walking + frontmatter parsing
  - create `server/library/cache.ts` — in-memory store + `loadLibrary()` + `getArtifact()`
  - modify `server/index.ts` — call `loadLibrary()` at startup
  - modify `package.json` — add `gray-matter` dependency
  - test `server/library/__tests__/scan.test.ts`
- **Approach:**
  1. Add `gray-matter` via `bun add gray-matter`.
  2. `LibraryArtifact` shape: `{ id, type, scope, name, namespace, displayName, sourcePath, description, created, inspiration, frontmatter (raw obj), body (markdown string), parseError? }` .
  3. Scanner enumerates four sources, each producing artifacts:
     - **Globals:** glob `~/.claude/{skills,agents,commands,rules}/**/*.md` + `~/.claude/CLAUDE.md` (single file).
     - **Plugins:** read `~/.claude/plugins/installed_plugins.json`; for each plugin, walk `installPath/(skills|agents|commands)`.
     - **Projects:** SELECT `path` FROM `workspaces`; for each, walk `<path>/.claude/(skills|agents|commands)` if dir exists.
  4. Type inference: directory of file (skills/agents/commands/rules); CLAUDE.md is its own type.
  5. Name inference for namespaced files: relative path under `<type>/` with `/` → `:` and `.md`/`SKILL.md` stripped. Examples:
     - `~/.claude/commands/qa/test.md` → `qa:test`
     - `~/.claude/skills/arch-viz/waterfall.md` → `arch-viz:waterfall`
     - `~/.claude/skills/qa/contract/tests/SKILL.md` → `qa:contract:tests`
  6. Frontmatter parsed via gray-matter; on failure record `parseError`, fall back to filesystem mtime for `created`.
  7. `description` defaults to `frontmatter.description` ?? first H1 of body ?? first paragraph (truncated to 200 chars).
  8. Cache is a `Map<string, LibraryArtifact>`, populated synchronously at startup. Provide `rescan()` for the API.
- **Test scenarios:**
  - Happy: scan a fixture dir with one of each type, assert all entities found with correct fields.
  - Edge: malformed YAML frontmatter — artifact still loaded with `parseError` set.
  - Edge: file with no frontmatter — `description` derived from H1.
  - Edge: a namespaced nested skill (e.g. `qa/contract/tests/SKILL.md`) — name = `qa:contract:tests`.
  - Edge: project workspace path doesn't exist — silently skipped, no error.
  - Error: missing `~/.claude` dir — `loadLibrary()` returns empty, doesn't crash.
- **Verification:** Restart server, `curl http://localhost:5198/api/library/rescan` (after Unit 2 ships), spot-check that `~/.claude/skills/ce-brainstorm/SKILL.md` appears with the correct frontmatter and a sensible `created` date.

### Unit 2: Library API (server)

- [x] **Goal:** Four Express endpoints exposing the library cache + usage queries.
- **Requirements:** R14–R17 (filter/sort/search), R21–R25 (usage), R29 (routes), R30–R31 (rescan + on-the-fly)
- **Dependencies:** Unit 1
- **Files:**
  - create `server/library/api.ts` — Express router with `GET /api/library`, `GET /api/library/:id`, `GET /api/library/:id/usage`, `POST /api/library/rescan`, `POST /api/library/show-in-finder`
  - create `server/library/usage.ts` — SQL functions for usage aggregation
  - modify `server/index.ts` — `app.use(libraryRouter)`
  - test `server/library/__tests__/usage.test.ts`
- **Approach:**
  1. `GET /api/library` accepts query params: `type`, `scope`, `ns`, `q`, `sort` (`name|created|last_used|invocations`), `include_plugins` (default `0`), `has_usage` (`0|1`). Filter the cache in memory; for `q`, simple case-insensitive substring on name+description+body. For `sort=last_used` or `sort=invocations`, hydrate usage stats (TD7) before sorting.
  2. `GET /api/library/:id` returns full artifact (including body markdown).
  3. `GET /api/library/:id/usage` runs the three queries from TD7 in parallel via better-sqlite3 prepared statements, then aggregates:
     - `total_invocations: number`
     - `last_used: timestamp | null`
     - `top_sessions: [{ session_id, count, last_used, workspace_path }]` (top 5 by count)
     - `daily_bucket: [{ day: 'YYYY-MM-DD', count }]` for last 90 days
  4. `POST /api/library/rescan` calls `loadLibrary()`, returns count + duration.
  5. `POST /api/library/show-in-finder` runs `Bun.spawnSync(['open', '-R', body.path])`. Validate that `body.path` starts with `/Users/blake/.claude/` or a known workspace path before shelling out.
  6. For "always-on" types (rule, claude-md, hook), the usage endpoint returns `{ kind: 'always-on' }` instead of stats.
- **Test scenarios:**
  - Happy: GET /api/library returns ~80+ items by default (own only).
  - Happy: GET /api/library?include_plugins=1 returns more.
  - Happy: GET /api/library?type=skill&ns=qa returns only `qa:*` skills.
  - Happy: GET /api/library/:id/usage for `qa:debug` returns total + sessions.
  - Edge: GET /api/library/:id with unknown id → 404.
  - Edge: show-in-finder rejects a path outside `~/.claude/` and known workspaces → 400.
  - Edge: artifact whose name has special chars in the URL — confirm encoding round-trips.
- **Verification:** `curl 'http://localhost:5198/api/library?type=skill&sort=last_used' | jq '.[:5]'` returns recently-used skills first; their `last_used` matches what session-explorer's session pages show for the same ids.

### Unit 3: Library list UI

- [x] **Goal:** A `/library` page showing the artifact list with a sidebar of filters and sortable columns. Hooked into the top-level nav.
- **Requirements:** R14, R15, R17, R27, R28
- **Dependencies:** Unit 2
- **Files:**
  - modify `web/router.ts` — add `libraryRoute` (with `validateSearch` for the filter params)
  - modify `web/main.tsx` — register the new route
  - create `web/components/library/LibraryPage.tsx`
  - create `web/components/library/LibraryFilters.tsx`
  - create `web/components/library/LibraryTable.tsx`
  - modify `web/components/Sidebar.tsx` — add Library link near Insights/Meta links (~line 320)
  - test `web/components/library/__tests__/LibraryFilters.test.tsx` (filter URL round-tripping)
- **Approach:**
  1. Route validates these search params: `type`, `scope`, `ns`, `q`, `sort`, `include_plugins` (boolean). Use nuqs (already a dep) or TanStack's built-in `validateSearch` + `useNavigate`.
  2. Layout: left sidebar of filter chips/checkboxes (type, scope, namespace), main area is a single sortable table. Default sort: `last_used desc`.
  3. Columns: name, type badge, scope badge, namespace, last_used, total invocations, created. Column headers click to re-sort.
  4. Reuse Tailwind tokens from existing pages (`bg-zinc-700/50`, etc., per `ScoreTrends.tsx` patterns).
  5. The table fetches from `/api/library` with `sort=last_used` initially. When the user changes sort to one that doesn't include usage data, omit the `sort` param to skip the join.
  6. Each row links to `/library/<encoded-id>`.
  7. Sidebar nav addition: copy the structure of the `/insights` link block in `Sidebar.tsx`, reuse one of the existing Lucide icon imports (e.g. `BookOpen`).
- **Test scenarios:**
  - Happy: page mounts, list renders, filter chips toggle and update the URL.
  - Edge: deep-link with `?type=command&ns=qa` shows pre-filtered list.
  - Edge: empty result set (e.g. `?ns=does-not-exist`) shows an empty-state message.
  - Edge: include_plugins toggle adds plugin rows with `plugin:<name>` scope badge.
- **Verification:** Open `http://localhost:5199/library` (Vite dev), see ~185+ rows, click "Sort by last_used" header, top items match recently-invoked skills from a session you remember.

### Unit 4: Library detail UI

- [x] **Goal:** Detail page for one artifact: frontmatter, body, "open in editor", "show in Finder", usage panel, sparkline.
- **Requirements:** R18–R22, R26
- **Dependencies:** Unit 2, Unit 3 (for nav)
- **Files:**
  - modify `web/router.ts` — add `libraryDetailRoute` with `path: "/library/$id"`
  - create `web/components/library/LibraryDetail.tsx`
  - create `web/components/library/UsagePanel.tsx`
  - create `web/components/library/UsageSparkline.tsx`
  - test `web/components/library/__tests__/UsageSparkline.test.tsx` (rendering with various data shapes)
- **Approach:**
  1. Detail layout: header (name + type badge + scope badge), action buttons (Open in editor, Show in Finder, Re-scan), frontmatter as a key/value table, then rendered markdown body via existing `renderMarkdown(body)` from `sessionFormat.tsx`, then usage panel at bottom.
  2. "Open in editor" is a plain `<a href={`${scheme}://file/${absPath}`}>` — no JS needed; the click hands off to LaunchServices.
  3. "Show in Finder" is a fetch to `POST /api/library/show-in-finder` with the artifact's `sourcePath`.
  4. UsagePanel: top section shows `total_invocations`, `last_used` (relative time), then a list of top 5 sessions linking to `/session/<id>` (existing route).
  5. UsageSparkline: takes the 90-day bucket array, computes `max`, renders 90 `<div>` bars in a flex row with `width=4px height=24px` and `bg-indigo-500/<opacity>` where opacity scales with `count/max`. Hover tooltip shows the day + count.
  6. For `kind: 'always-on'` artifacts (rules, CLAUDE.md, hooks), the usage panel renders a single line: "Always-on — applied to every session." No sparkline.
- **Test scenarios:**
  - Happy: navigate from list to detail, body renders, usage panel populates.
  - Edge: artifact with `parseError` shows a yellow banner above the body explaining the parse issue.
  - Edge: artifact with zero invocations shows "Never used" instead of an empty sparkline.
  - Edge: artifact body containing `<script>` is rendered safely (existing `renderMarkdown` HTML-escapes).
  - Edge: clicking "Open in editor" with `LIBRARY_EDITOR_SCHEME=vscode` produces a `vscode://file/...` href.
- **Verification:** Click into `qa:debug`, see frontmatter table including `inspiration`, body rendered, last used date matches session-explorer's record, "Open in editor" opens the SKILL.md in Cursor.

### Unit 5: Plugin coverage, hooks, and polish

- [x] **Goal:** Round out the long-tail entity types and edge cases: plugin walking, hooks (stretch), CLAUDE.md, scope-badge polish.
- **Requirements:** R6, R8 (stretch), R26 (always-on labels)
- **Dependencies:** Unit 1, Unit 4
- **Files:**
  - modify `server/library/scan.ts` — add plugin-walk + hooks-walk logic
  - modify `web/components/library/LibraryDetail.tsx` — handle hook artifacts (script body, no frontmatter)
  - test `server/library/__tests__/scan.test.ts` — extended fixtures
- **Approach:**
  1. Plugin walk: parse `~/.claude/plugins/installed_plugins.json`, iterate plugins, for each `installPath` walk `(skills|agents|commands)`. Plugin name comes from the manifest key (e.g. `design-and-refine` from `design-and-refine@design-plugins`). Scope is `plugin:<name>` .
  2. Hooks: enumerate `~/.claude/hooks/*` directories and files. Hooks are scripts (often executable, no frontmatter). Artifact has `type: 'hook'`, body = file contents (truncate at 50KB), `description` = first comment line. Scope is `global` always.
  3. Detail view branch: if `type === 'hook'`, skip frontmatter table, render body inside a `<pre>` block (no markdown rendering). Add a "this is a hook script" notice.
- **Test scenarios:**
  - Happy: scan finds all 5 installed plugins; their items appear with `plugin:` scope.
  - Happy: scan finds hook directories under `~/.claude/hooks/` with type=hook.
  - Edge: hook is a binary or huge — body truncated, banner shown.
  - Edge: a plugin's `installPath` doesn't exist (manifest stale) — skipped silently.
- **Verification:** Toggle "include plugins" filter on the list page; rows for `design-and-refine:design-lab`, `playground:playground`, etc. appear with the right scope badge. Click into `~/.claude/hooks/delegation-logger` — body renders as code, "Open in editor" works.

## Risks

- **R-Risk1: `messages.tool_input` JSON shape across versions.** Verified against the live DB during planning: `Skill` rows are `{"skill":"<name>","args":"..."}` and `Agent` rows are `{"subagent_type":"<name>",...}` — 151 Skill rows and 351 Agent rows present, all conforming. `json_extract($.skill)` and `json_extract($.subagent_type)` are safe. Risk now low; if older JSONL with different shape surfaces, fall back to a `LIKE '%"skill":"<name>"%'` substring match.
- **R-Risk2: Slash-command detection has false positives** — user messages starting with `/` may not all be slash commands (could be paths, regex, etc.). Mitigation: require exact match `content = '/<name>'` or prefix `'/<name> '` (with space) to avoid matching arbitrary text.
- **R-Risk3: `gray-matter` adds ~150 KB and a transitive `js-yaml`.** Acceptable for a personal tool; flagged so a reviewer can object.
- **R-Risk4: `cursor://file/...` URL scheme may not be registered** if the user reinstalls Cursor — would silently fail to open. Mitigation: env var override + a one-line dev note in CLAUDE.md.
- **R-Risk5: Scanning all workspace `.claude/` dirs on every restart could be slow if there are 50+ workspaces with deep trees.** Current count is small (verified). Mitigation: if scan time > 1s, bound the recursion depth to 4 levels and skip `node_modules`, `.git`, `dist`.
- **R-Risk6: Showing every project workspace's artifacts may flood the list** — items with the same name appear multiple times. Mitigation: scope badge makes them distinguishable, and the default sort by `last_used` puts active ones up top. Revisit if it gets noisy.
- **R-Risk7: `POST /api/library/show-in-finder` with arbitrary paths is a small command-injection risk.** Mitigation: the path-prefix allowlist in TD9 + `Bun.spawnSync` argv form (no shell interpolation).

## Sources

- Brainstorm: `plans/brainstorms/skills-browser-requirements.md`
- Codebase recon (verbatim): `server/index.ts` (route patterns, line 1214 example), `server/db.ts:43–50` (messages schema), `web/router.ts` (route definition pattern), `web/components/SessionList.tsx:112` (list-fetch pattern), `web/sessionFormat.tsx:19–59` (renderMarkdown), `web/components/Sidebar.tsx:307–330` (nav pattern), `web/components/ScoreTrends.tsx:159–180` (Tailwind bar pattern)
- Plugin layout: `~/.claude/plugins/installed_plugins.json` (schema verified), `~/.claude/plugins/cache/design-plugins/design-and-refine/0.1.0/skills/design-lab/SKILL.md` (verified)
- Editor schemes: macOS `man open`, LaunchServices `CFBundleURLTypes` registration; both `Cursor.app` and `Visual Studio Code.app` confirmed installed
