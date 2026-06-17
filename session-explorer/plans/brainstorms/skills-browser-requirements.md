---
date: 2026-04-26
topic: skills-browser
---

# Skills Browser

A new section of session-explorer for browsing the user's `~/.claude/` prompt assets — skills, agents, commands, rules, and the global CLAUDE.md — with cross-references to actual usage data already captured in session-explorer's database.

## Problem Frame

The user has accumulated ~85 skills, 11 agents, 89 commands, plus rules, hooks, and CLAUDE.md across global and project-scoped locations, plus more from installed plugins. There's no good way to:

- See everything in one place with consistent metadata (when created, what inspired it, which scope it lives in).
- Discover existing assets before creating duplicates.
- Tell which assets are actually used vs which are dead weight.
- Filter by namespace (`qa:*`, `arch-viz:*`, `codex:*`, `prompts:*`), source (own vs plugin), or scope (global vs project).

Session-explorer already has the per-session tool-call data needed to answer the usage question, so the cross-reference is essentially free. Putting the browser there (vs a standalone HTML or CLI) reuses that data and the existing nav, search, and theming.

## Requirements

### Entity Coverage

- **R1:** Browse own global skills under `~/.claude/skills/**/SKILL.md`.
- **R2:** Browse own global agents under `~/.claude/agents/**/*.md` (including subdirectories like `agents/review/`, `agents/codex/`).
- **R3:** Browse own global commands under `~/.claude/commands/**/*.md` (preserving namespace from directory structure: `commands/qa/test.md` → `qa:test`).
- **R4:** Browse global rules under `~/.claude/rules/*.md`.
- **R5:** Browse the global `~/.claude/CLAUDE.md`.
- **R6:** Browse plugin-shipped skills, agents, and commands under `~/.claude/plugins/repos/**` (or wherever installed plugins land — verify path during planning).
- **R7:** Browse project-scoped versions of the above by scanning known project roots — at minimum the active workspace (use session-explorer's existing `workspaces` table). Show terra's `knip-cleanup` skill, `arch-explorer`, `clone-env`, `v4/*` commands, etc.
- **R8 (stretch):** Browse hooks under `~/.claude/hooks/**`. Different shape (executable scripts, not markdown), so list them but use a simpler detail view that just shows the file content.

### Categorization & Filtering

- **R9:** Each artifact has a **type** (skill / agent / command / rule / hook / claude-md).
- **R10:** Each artifact has a **scope** badge: `global` | `project:<workspace-name>` | `plugin:<plugin-name>`.
- **R11:** Each artifact has a **namespace** derived from the colon-prefix in its name (e.g. `qa:test` → namespace `qa`; un-prefixed names get namespace `_root`).
- **R12:** Each artifact's **created date** comes from frontmatter `created:` if present, else from filesystem mtime of the earliest version (best-effort: file ctime is acceptable for v1).
- **R13:** Each artifact's **inspiration** comes from frontmatter `inspiration:` if present (string or array form, both supported). Items without inspiration are filterable as "no source attributed."
- **R14:** Filterable facets in the list view (sidebar or chips): type, scope, namespace, inspiration source, has-usage (boolean: ever invoked).
- **R15:** Sortable columns in the list view: name, created date, last used, total invocations.

### Search

- **R16:** Free-text search matches against name, description, and body (full text). Reuses the SQLite full-text-search pattern session-explorer already uses for sessions if reasonable.
- **R17:** Default sort when not searching: most-recently used (descending). Falls back to created date for never-used items.

### Detail View

- **R18:** Detail view shows: name, type badge, scope badge, frontmatter rendered as a key/value table, full markdown body rendered (using session-explorer's existing markdown renderer if it has one).
- **R19:** Detail view has an **"Open in editor"** action that opens the source file in the user's default editor (e.g. `cursor:` URL or `vscode:` URL — pick whichever Blake's machine handles; verify during planning).
- **R20:** Detail view has a **"Show in Finder"** action for the source file path.
- **R21:** Detail view shows a **usage panel**: total invocations, last used date, top 5 sessions where it was invoked (linking into existing session-explorer session pages).
- **R22:** Detail view shows a **usage timeline**: a sparkline or daily-bucketed bar chart of invocations over the last N days (e.g. 90), in keeping with session-explorer's existing visualization style.

### Usage Detection

- **R23:** A "use" of a **skill** is detected from session-explorer's existing tool-call records where the tool name is `Skill` and the `skill` argument matches the artifact's name. Plus user messages starting with `/<name>` (slash command form). Confirm exact data shape during planning.
- **R24:** A "use" of an **agent** is detected from `Agent` tool-calls where `subagent_type` matches the artifact's name.
- **R25:** A "use" of a **command** is detected the same way as a skill (slash invocation).
- **R26:** Rules, CLAUDE.md, hooks have no direct invocation metric — show "always-on" instead of usage stats.

### Navigation Integration

- **R27:** Add a top-level nav link for "Skills" (or "Library") next to Sessions / Workspaces / Insights / Meta in session-explorer's existing nav.
- **R28:** New routes follow the existing TanStack Router pattern: `/skills` (list), `/skills/$type/$name` (detail). Route params should round-trip to/from URL so deep-linking works.
- **R29:** New API routes follow the existing Express pattern: `GET /api/skills` (list with filter query params), `GET /api/skills/:type/:name` (detail), `GET /api/skills/usage/:type/:name` (usage breakdown).

### Performance & Freshness

- **R30:** Filesystem walk + frontmatter parsing happens at server startup and is cached in memory. A re-scan endpoint can be triggered manually; auto re-scan is **not** required for v1 (stretch goal).
- **R31:** Usage data is computed by joining against session-explorer's existing `messages` / `tool_calls` (or whatever the relevant table is named — verify during planning) on the fly. If too slow, materialize into a `skill_usage` table during ingest.

## Success Criteria

- **SC1:** Open `localhost:5198/skills` and see a single list with all skills, agents, commands, and rules from `~/.claude/`, ~185+ items.
- **SC2:** Filter to "namespace = qa" and see only the QA-prefixed skills/commands.
- **SC3:** Click on `qa:debug` and see its full body, frontmatter (including `inspiration`), and usage stats showing every session where I invoked it.
- **SC4:** From the detail view, click "Open in editor" and the SKILL.md opens in Cursor.
- **SC5:** Sort the list by "last used" and immediately see which skills are dead weight (no usage ever).
- **SC6:** When I add a new skill in `~/.claude/skills/foo/` and trigger re-scan, it appears in the list.

## Scope Boundaries

**In scope:**
- Read-only browser. No editing, no creation, no deletion.
- Markdown-shaped artifacts as primary citizens; hooks as a stretch goal with a simpler view.
- Plugin-shipped artifacts visible alongside own.
- Project-scoped artifacts visible with a `project:<name>` badge.

**Out of scope:**
- Editing artifacts in the browser.
- Creating new skills/agents/commands.
- Skill execution or "try this skill" runtime.
- Cross-machine sync or sharing.
- Memory files, plans/, paste-cache, debug logs, session-env — these are not user-authored prompt assets and are explicitly excluded.
- Non-markdown configuration files (settings.json, etc.).

## Key Decisions

- **D1: Live in session-explorer, not standalone.** Reuses session DB for usage cross-reference, existing nav, theming, deploy. The unique-value of being inside session-explorer is the usage data — without it, a static HTML would be just as good.
- **D2: Include skills + agents + commands + rules + CLAUDE.md as first-class.** Uniform markdown shape. Hooks are stretch (different shape).
- **D3: Read-only with "open in editor" links.** No write paths means no validation / save state / conflict handling. Editing happens in the user's editor where they already do it.
- **D4: Aggregate usage stats + timeline** (rather than just counts, or deferring usage entirely). The timeline is the visualization that justifies putting this in session-explorer.
- **D5: Filesystem walk at startup, in-memory cache, manual re-scan.** No need for auto-watching for v1; restart is cheap.
- **D6: New top-level nav entry.** Not buried under existing pages.
- **D7: Nav label is "Library."** More accurate than "Skills" since the page covers agents/commands/rules/CLAUDE.md too.
- **D8: Plugin-shipped artifacts hidden by default.** Default view shows only the user's own artifacts. A filter toggle reveals plugin items. Keeps the list focused on what was authored locally.

## Outstanding Questions

### Resolve Before Planning

_All resolved during brainstorming — see Key Decisions D7 and D8 below._

### Deferred to Planning

- **DQ1:** Where exactly do plugin-installed skills/agents/commands live on disk? Verify by listing `~/.claude/plugins/repos/` and tracing how Claude Code discovers them.
- **DQ2:** Exact session-explorer schema for tool-call data — confirm table/column names, whether `Skill` and `Agent` calls are recorded as their own rows or live inside a JSON blob.
- **DQ3:** Editor-open URL scheme — `cursor://file/...`, `vscode://file/...`, or `open -a` shell-out? Pick what works on Blake's setup.
- **DQ4:** Project-scoped scan strategy — walk all `workspaces` from session-explorer's DB, scan each `<workspace_path>/.claude/`, or limit to the active/selected workspace? Cost vs completeness.
- **DQ5:** UI layout — list-with-side-filters, master-detail like Sessions, or grid of cards? Defer to /plan; should match session-explorer's existing aesthetic.
- **DQ6:** Whether to materialize a `skill_usage` table or compute on the fly. Probably on-the-fly first; materialize if slow.
- **DQ7:** How to handle artifacts that exist in multiple locations (e.g. a skill present both globally and project-scoped). Show as separate entries or merge?

## Next Steps

1. Resolve Q1 and Q2 (two product questions, ~30 seconds).
2. Hand off to `/ce:plan` with this requirements doc to produce the implementation plan.

