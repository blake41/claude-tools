# Plan: Migrate All CLIs to Agent-First JSON Envelope

## Summary

Create a shared `cli-envelope.sh` bash helper, migrate all 10 bash CLI tools to return JSON envelopes with HATEOAS `next_actions`, and update the `cli-design` skill to reflect the bash-native approach.

**Skipping:** browser-ctl (Node.js, separate effort), streaming commands (cf-logs tail, notion-cc wait-for-comment), interactive commands (setup wizards).

---

## Phase 0: Create `cli-envelope.sh`

**New file:** `tools/cli-envelope.sh`
**Symlink:** `~/.local/bin/cli-envelope.sh`

Functions:
- `json_ok <command> <result_json> [next_actions_json]` — success envelope
- `json_error <command> <message> <code> <fix> [next_actions_json]` — error envelope (calls `exit 1`)
- `next_action <command> <description>` — returns one `{command, description}` JSON object
- `next_actions "$(...)" "$(...)"` — combines multiple into a JSON array
- `json_truncate <array_json> <max_items>` — returns `{items, total, shown, truncated}`
- `cmd_tree <tool_name> <description> <commands_json>` — root self-documenting response
- `safe_api_call <command_name> <curl_args...>` — curl wrapper that emits `json_error` on HTTP errors

All JSON built with `jq` (never string concatenation). File starts with a `jq` availability guard.

---

## Phase 1: Migrate Tools (simplest to most complex)

### 1. render-services (45 lines, 2 subcmds)
**File:** `tools/render/render-services`
- Source `cli-envelope.sh`
- `list`: replace `echo` + `column -t` with `json_ok` wrapping the services array
- `get`: wrap raw API response in `json_ok`
- Root: `cmd_tree` with list/get commands
- `next_actions`: list -> `get <id>`, `render-logs <id>`; get -> `render-logs <id>`

### 2. render-workspace (74 lines, 4 subcmds)
**File:** `tools/render/render-workspace`
- `list/select/select-local/current`: wrap each in `json_ok`
- select -> next: `current`, `render-services list`

### 3. render-logs (103 lines, options-based)
**File:** `tools/render/render-logs`
- Wrap log entries in `json_ok` with truncation (default 50 lines)
- Each entry as `{timestamp, level, message}` objects
- next_actions: `--lines 100` for more, `render-services get <id>`

### 4. sf-query (116 lines, 2 subcmds)
**File:** `tools/salesforce/sf-query`
- Remove emoji
- `query`: wrap sf CLI JSON output in envelope, truncate at 50 records
- `describe`: wrap field list in envelope
- Errors: `UNKNOWN_ENV`, `INVALID_QUERY`, `MISSING_DEP`

### 5. cf-workers (95 lines, 3 subcmds)
**File:** `tools/cloudflare/cf-workers`
- `list`: replace `column -t` with JSON array in envelope
- `info/deployments`: wrap raw API JSON in envelope
- next_actions: list -> `info <name>`, `cf-logs <name>`

### 6. cf-logs (114 lines, streaming -- PARTIAL)
**File:** `tools/cloudflare/cf-logs`
- Root/errors only: `cmd_tree`, `json_error` for missing args/deps
- Emit a JSON preamble before streaming starts: `{"ok":true,"streaming":true,...}`
- Streaming output itself stays as wrangler tail raw output

### 7. exa-search (195 lines, 1 cmd with options)
**File:** `tools/exa/exa-search`
- Remove `--raw` flag (JSON is always the format)
- Remove formatted markdown output (the `---`, `#`, `URL:` display)
- Return results as `{results: [{title, url, published_date, author, highlights, text}]}`
- Truncate text content for context safety

### 8. c7 (264 lines, 4 subcmds)
**File:** `tools/c7/c7` (or wherever it lives)
- `search`: wrap results in envelope, dynamic next_action for top result's `docs` call
- `docs`: wrap content in envelope with token count, truncate large docs
- `setup`: return `json_error` with `INTERACTIVE_REQUIRED`
- Handle 429 (`RATE_LIMITED`), 202 (`INDEXING`), 301 (`REDIRECTED`)

### 9. linear-cli (347 lines, 9 subcmds)
**File:** `tools/linear/linear-cli`
- Remove all emoji
- Wrap every GraphQL response in envelope
- `issues`: truncate at 50, next_action -> `issue <first-id>`
- `create/comment`: return created resource in envelope
- Catch GraphQL errors -> `json_error` with `API_ERROR`

### 10. notion-cc (574 lines, 14 subcmds)
**File:** `tools/notion/notion-cc`
- Remove all ANSI colors from notion-cc and notion-cc-common.sh
- Remove `pretty_json` function
- `wait-for-comment`: return `json_error` with `STREAMING` code, suggest `comments` instead
- `setup`: return `json_error` with `INTERACTIVE_REQUIRED`
- All other commands: wrap in envelope with contextual next_actions

### 11. infisical-api (680 lines, 13 subcmds)
**File:** `tools/infisical/infisical-api`
- Remove ANSI colors from infisical-api-common.sh
- Remove `pretty_json` function
- `secrets list`: replace `column -t` with JSON array in envelope
- `secrets export -f env`: wrap as `{format: "env", content: "KEY=VAL\n..."}`
- `debug compare`: structured `{only_in_infisical, only_in_render, matching}` instead of colored diff
- `syncs force`: wrap multi-step result as `{steps: [...], sync_triggered: bool}`
- `setup`: `json_error` with `INTERACTIVE_REQUIRED`
- `syncs remove-secrets`: add `--yes` flag, otherwise `json_error` with `CONFIRMATION_REQUIRED`

---

## Phase 2: Update Shared Helpers

For each family's common helper:
- **render-common.sh**: Already clean -- no changes needed (errors go to stderr, tools catch and envelope them)
- **cf-common.sh**: Same -- minimal changes
- **notion-cc-common.sh**: Remove `RED/GREEN/YELLOW/BLUE/NC` color vars, remove `pretty_json`, silence stderr messages in `load_credentials` (let caller envelope errors)
- **infisical-api-common.sh**: Remove color vars, remove `pretty_json`, silence stderr messages

---

## Phase 3: Update `cli-design` Skill

**File:** `joelclaw/.agents/skills/cli-design/SKILL.md`

Changes:
1. **Remove** all @effect/cli and Bun references (the "Framework" and "Binary distribution" sections)
2. **Replace** implementation section with bash + `cli-envelope.sh` approach
3. **Add** a complete bash template for creating a new CLI tool
4. **Update** reference implementations: render-services (simple), linear-cli (medium), infisical-api (complex)
5. **Add** standardized error code table (AUTH_MISSING, AUTH_FAILED, MISSING_ARG, MISSING_DEP, NOT_FOUND, INVALID_*, HTTP_*, API_ERROR, RATE_LIMITED, INTERACTIVE_REQUIRED, CONFIRMATION_REQUIRED, STREAMING)
6. **Update** checklist for new tools: create in `tools/<service>/`, source helpers, implement commands, symlink to `~/.local/bin/`
7. **Add** a "Bash Template" section with a copy-paste starter

---

## Phase 4: Verification

Create `tools/test-envelope.sh` that checks each migrated tool:

```bash
# For each tool:
# 1. Root returns valid envelope with commands
<tool> | jq -e '.ok == true and (.result.commands | length > 0)'

# 2. Each subcommand returns envelope with next_actions
<tool> <subcmd> [args] | jq -e '.ok != null and (.next_actions | length > 0)'

# 3. No ANSI codes in any output
<tool> <subcmd> [args] | grep -P '\x1b\[' && FAIL

# 4. Error cases return error envelope (not plain text)
# 5. Exit code 0 for success, non-zero for error
```

Accept `--tool <name>` to test one tool at a time during development.

---

## Execution Order

1. `cli-envelope.sh` (foundation -- everything depends on this)
2. `render-services` (first migration, validates pattern end-to-end)
3. `render-workspace`, `render-logs` (complete the render family)
4. `sf-query` (standalone, simple)
5. `cf-workers`, `cf-logs` (cloudflare family)
6. `exa-search` (standalone)
7. `c7` (standalone)
8. `linear-cli` (medium complexity)
9. `notion-cc` + `notion-cc-common.sh` (complex)
10. `infisical-api` + `infisical-api-common.sh` (most complex)
11. `test-envelope.sh` (verification)
12. Update `cli-design/SKILL.md` (codify the pattern)

---

## Files Modified

| File | Action |
|------|--------|
| `tools/cli-envelope.sh` | **CREATE** -- shared JSON envelope helper |
| `~/.local/bin/cli-envelope.sh` | **CREATE** -- symlink |
| `tools/render/render-services` | EDIT -- migrate to envelope |
| `tools/render/render-workspace` | EDIT -- migrate to envelope |
| `tools/render/render-logs` | EDIT -- migrate to envelope |
| `tools/salesforce/sf-query` | EDIT -- migrate to envelope |
| `tools/cloudflare/cf-workers` | EDIT -- migrate to envelope |
| `tools/cloudflare/cf-logs` | EDIT -- partial (errors + preamble only) |
| `tools/exa/exa-search` | EDIT -- migrate to envelope |
| `tools/c7` (or wherever it lives) | EDIT -- migrate to envelope |
| `tools/linear/linear-cli` | EDIT -- migrate to envelope |
| `tools/notion/notion-cc` | EDIT -- migrate to envelope |
| `tools/notion/notion-cc-common.sh` | EDIT -- remove colors, pretty_json |
| `tools/infisical/infisical-api` | EDIT -- migrate to envelope |
| `tools/infisical/infisical-api-common.sh` | EDIT -- remove colors, pretty_json |
| `tools/test-envelope.sh` | **CREATE** -- verification script |
| `joelclaw/.agents/skills/cli-design/SKILL.md` | EDIT -- replace Effect with bash approach |
