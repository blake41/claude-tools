# Developer Tools

Central location for reusable CLI tools. All scripts live here and symlink to `~/.local/bin/` .

## Structure

```
tools/
├── sandbox/              # Seatbelt sandbox for Claude Code
├── ab/                   # Browser automation wrapper (agent-browser + CDP)
├── cmux/                 # Claude session persistence for cmux
├── db-safe/              # Safe database CLI with guardrails
├── exa/                  # Exa AI web search with content extraction
├── c7/                   # Context7 documentation lookup
├── codex-ask/            # Lightweight Codex API calls
├── render/               # Render.com service management
├── cloudflare/           # Cloudflare Workers management
├── github/               # GitHub Actions CLI
├── infisical/            # Infisical secrets management
├── salesforce/           # Salesforce SOQL queries
├── linear/               # Linear issue tracking
├── notion/               # Notion kanban board
├── api-probe/            # API endpoint discovery
├── session-explorer/     # Claude session history browser (web app)
├── skill-gen/            # Skill file generator
├── beam/                 # Breadboard-to-TLDraw CLI
├── mermaid-render/       # Mermaid diagram renderer
├── git-prune-merged/     # Rebase-aware branch cleanup
├── watch-deploy/         # Render deploy watcher with notifications
├── tmux/                 # Tmux process monitoring for AI agents
├── cli-over-mcp.md       # Pattern: replacing MCP with CLI scripts
├── render-config.md      # Render CLI setup docs
└── MIGRATION.md          # Migration notes
```

## Installed Locations

| Tool | Binary | Config |
|------|--------|--------|
| Sandbox | `~/.local/bin/claude-sandbox` | `tools/sandbox/dirs` |
| Sandbox request | `~/.local/bin/sandbox-request` | — |
| Sandbox fish fn | sourced from `config.fish` | — |
| Sandbox statusline | `~/.claude/statusline.sh` | — |
| Browser (ab) | `~/.local/bin/ab` | `~/.agent-browser/` |
| cmux session persist | `~/.local/bin/cmux-session-persist` | `~/.cmux/` |
| db-safe | `~/.local/bin/db-safe` | `.db-safe.json` per project |
| Exa search | `~/.local/bin/exa-search` | `~/.config/exa/` |
| c7 | `~/.local/bin/c7` | `~/.config/c7/` |
| Codex ask | `~/.local/bin/codex-ask` | uses `OPENAI_API_KEY` |
| Render | `~/.local/bin/render-services`, `render-logs` | `~/.config/render/` |
| Cloudflare | `~/.local/bin/cf-workers`, `cf-logs` | `~/.config/cloudflare/` |
| GitHub | `~/.local/bin/gh-actions`, `pr-ship` | uses `gh` CLI auth |
| Infisical | `~/.local/bin/infisical-api` | `~/.config/infisical/` |
| Salesforce | `~/.local/bin/sf-query` | uses `sf` CLI auth |
| Linear | `~/.local/bin/linear-cli` | `~/.config/linear/api-key` |
| Notion | `~/.local/bin/notion-cc` | `~/.config/notion/api_token` |
| iMessage | `~/.local/bin/imsg` | Full Disk Access required |
| git-prune-merged | `~/.local/bin/git-prune-merged` | — |
| watch-deploy | `~/.local/bin/watch-deploy` | — |

## Quick Reference

### Sandbox (Seatbelt)

```bash
cco-permissions                           # Start new sandboxed session
cco-permissions --resume <session-id>     # Resume existing session

# Inside sandbox, if you hit "Operation not permitted":
sandbox-request ~/.some-path              # Queue expansion (rw)
sandbox-request ~/.some-path --ro         # Queue expansion (ro)
# Then /exit — wrapper prompts: y=permanent, s=session, n=deny

CCO_DEBUG=1 cco-permissions               # Keep Seatbelt policy file for inspection
```

Setup: `source ~/Documents/Development/tools/sandbox/cco-permissions.fish` in `config.fish`

### Browser Automation (ab)

```bash
ab ensure                                 # Start Chrome with CDP (if not running)
ab heal                                   # Kill and restart Chrome + daemons
ab status                                 # Check Chrome/CDP health
ab open <url>                             # Navigate (creates/reuses isolated tab)
ab snapshot -i                            # Accessibility tree with @refs
ab click @ref                             # Click element by ref
ab fill @ref "text"                       # Type into input
ab find text "Submit" click               # Find text and click
ab get text @ref                          # Read element content
ab screenshot                             # Screenshot current page
ab record start / ab record stop          # Video recording
ab reauth                                 # Grab cookies from personal Chrome
```

### Database (db-safe)

```bash
db-safe sql staging "SELECT * FROM accounts LIMIT 10"
db-safe read staging "prisma.account.findMany({ take: 5 })"
db-safe sql:write staging "UPDATE accounts SET ..."   # staging/dev only
db-safe write staging "prisma.account.update({ ... })" # staging/dev only
```

Never write to production — ask the human.

### Web Search (exa-search)

```bash
exa-search "query"                        # Semantic search
exa-search "query" --contents             # Search + extract page content
exa-search "query" --num-results 5        # Limit results
```

### Documentation (c7)

```bash
c7 search react --query "hooks"           # Find a library ID
c7 docs /facebook/react --query "useState useEffect" --tokens 5000
```

### Codex (codex-ask)

```bash
codex-ask "review this code for bugs"     # One-shot Codex API call
echo "prompt" | codex-ask                 # Pipe input
codex-ask --reasoning medium "prompt"     # With reasoning effort
```

### Render

```bash
render-services list
render-logs srv-xxxxx --level error --lines 50
```

### Cloudflare

```bash
cf-workers list
cf-workers deployments <name>
cf-logs <worker-name>                     # Real-time streaming
cf-logs <worker-name> --status 500
```

### GitHub Actions

```bash
gh-actions runs                           # List recent runs
gh-actions runs --status failure          # Filter by status
gh-actions logs <run-id> --failed         # Failed step logs
gh-actions rerun <run-id> --failed        # Re-run failed jobs
pr-ship                                   # Create PR → green → merge → cleanup
```

### Infisical

```bash
infisical-api projects list
infisical-api secrets list -p <id> -e staging
infisical-api syncs force <sync-id>
```

### Salesforce

```bash
sf-query prod "SELECT Id, Name FROM Account LIMIT 10"
sf-query prod describe Account
```

Read-only by design.

### Linear

```bash
linear-cli issues --mine --limit 10
linear-cli issue GTM-3424
linear-cli search "authentication bug"
linear-cli create GTM "Fix login bug" --priority 2
```

### Notion

```bash
notion-cc get <url>
notion-cc move <url> "Done"
notion-cc comment <url> "Note"
notion-cc wait-for-comment <url>          # Blocks until new comment
```

### Git Cleanup

```bash
git-prune-merged                          # Rebase-aware branch + worktree cleanup
```

Uses `git cherry` (patch-id comparison) instead of `--merged` (SHA comparison) — correct for rebase merge workflows.

### Deploy Watcher

```bash
watch-deploy <repo> <env> <branch> <sha> <msg>   # Polls CI + Render, macOS notification
```

### iMessage

```bash
imsg chats --limit 10
imsg history --chat-id 138 --limit 20
imsg send --to "+14155551212" --text "Hello!"
```

## Documentation

- [cli-over-mcp.md](./cli-over-mcp.md) — Pattern: replacing MCP with CLI scripts
- [render-config.md](./render-config.md) — Render CLI configuration
- [MIGRATION.md](./MIGRATION.md) — Migration notes
