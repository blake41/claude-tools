# Developer Tools

Central location for reusable CLI tools and documentation.

## Structure

```
tools/
├── cli-over-mcp.md       # Pattern: replacing MCP with CLI scripts
├── render-config.md      # Render CLI setup docs
├── sandbox/              # Seatbelt/bwrap sandbox for Claude Code
├── browser/              # Browser debugging via Chrome DevTools Protocol
├── render/               # Render CLI scripts (reference copy)
├── cloudflare/           # Cloudflare CLI scripts (reference copy)
├── github/               # GitHub Actions CLI scripts
├── infisical/            # Infisical API scripts
├── salesforce/           # Salesforce SOQL query scripts
├── linear/               # Linear issue tracking CLI
├── notion/               # Notion task board CLI
└── tmux/                 # Tmux session monitoring for AI agents
```

## Installed Locations

| Component | Location |
|-----------|----------|
| Sandbox | `~/.local/bin/claude-sandbox` (symlink) |
| Sandbox request | `~/.local/bin/sandbox-request` (symlink) |
| Sandbox config | `tools/sandbox/dirs` (write allowlist, self-protected via `:ro`) |
| Sandbox fish fn | `tools/sandbox/cco-permissions.fish` (sourced from `config.fish`) |
| Sandbox statusline | `~/.claude/statusline.sh` (symlink) |
| Browser scripts | `~/.local/bin/browser-*` |
| Browser config | No config needed (uses Chrome profile) |
| Render scripts | `~/.local/bin/render-*` |
| Render config | `~/.config/render/` |
| Cloudflare scripts | `~/.local/bin/cf-*` |
| Cloudflare config | `~/.config/cloudflare/` |
| GitHub scripts | `~/.local/bin/gh-actions`, `~/.local/bin/pr-ship` |
| GitHub config | Uses `gh` CLI auth |
| Infisical API | `~/.local/bin/infisical-api` |
| Infisical config | `~/.config/infisical/` or `.env` |
| Salesforce scripts | `~/.local/bin/sf-query` |
| Salesforce config | Uses `sf` CLI auth |
| Linear scripts | `~/.local/bin/linear-cli` |
| Linear config | `~/.config/linear/api-key` |
| Notion scripts | `~/.local/bin/notion-cc` |
| Notion config | `~/.config/notion/api_token` or `.env` |
| iMessage | `~/.local/bin/imsg` (via go install) |
| tmux-monitor | `~/.local/bin/tmux-monitor` |
| tmux-monitor deps | tmux, tmuxwatch, jq |
| Docs | This folder |

## Quick Reference

### Sandbox (Seatbelt)

```bash
# Launch Claude Code in sandbox
cco-permissions                           # Start new sandboxed session
cco-permissions --resume <session-id>     # Resume existing session

# Inside the sandbox, if you hit "Operation not permitted":
sandbox-request ~/.some-path              # Queue expansion request
sandbox-request ~/.some-path --ro         # Read-only access
# Then type /exit — the wrapper prompts: y=permanent, s=session, n=deny

# Debug the Seatbelt policy
CCO_DEBUG=1 cco-permissions               # Keeps policy file for inspection
```

Setup: `source ~/Documents/Development/tools/sandbox/cco-permissions.fish` in `~/.config/fish/config.fish`

Symlinks needed:
- `ln -sf ~/Documents/Development/tools/sandbox/claude-sandbox ~/.local/bin/claude-sandbox`
- `ln -sf ~/Documents/Development/tools/sandbox/sandbox-request ~/.local/bin/sandbox-request`
- `ln -sf ~/Documents/Development/tools/sandbox/statusline.sh ~/.claude/statusline.sh`

### Browser Control (Playwright + CDP)

```bash
# Launch Chrome with debugging enabled
browser-open                              # Opens localhost:5173
browser-open http://localhost:3000        # Custom URL
browser-open --force                      # Restart Chrome with debugging

# Full browser control
browser-ctl screenshot                    # Screenshot current page
browser-ctl screenshot --full             # Full page screenshot
browser-ctl screenshot ".element"         # Screenshot element
browser-ctl logs                          # Show last 50 log entries (instant)
browser-ctl logs --level error            # Only errors
browser-ctl logs -n 100 --json            # Last 100 entries as JSON
browser-ctl logs --follow                 # Tail logs live (Ctrl+C to stop)
browser-ctl logs --clear                  # Clear log history
browser-ctl click "button.submit"         # Click element
browser-ctl type "#input" "hello"         # Type into input
browser-ctl goto /accounts                # Navigate (relative URL)
browser-ctl eval "document.title"         # Run JavaScript
browser-ctl html ".content"               # Get element HTML
browser-ctl snapshot                      # Accessibility tree (JSON)
browser-ctl wait ".loaded"                # Wait for element
browser-ctl tabs                          # List open tabs
browser-ctl tab 1                         # Switch to tab
browser-ctl url                           # Print current URL
browser-ctl title                         # Print page title
browser-ctl reload                        # Reload page
```

Screenshots saved to `/tmp/browser-ctl/`. Uses `~/.cursor-chrome-profile` (preserves auth).

### GitHub Actions CLI

```bash
gh-actions runs                          # List recent workflow runs
gh-actions runs --status failure         # Filter by status
gh-actions runs --branch main            # Filter by branch
gh-actions logs <run-id>                 # Get full logs for a run
gh-actions logs <run-id> --failed        # Only failed steps
gh-actions failures                      # Recent failures with summaries
gh-actions failures --since 7d           # Last week's failures
gh-actions rerun <run-id>                # Re-run a workflow
gh-actions rerun <run-id> --failed       # Re-run only failed jobs
```

### PR Workflow (pr-ship)

```bash
pr-ship                    # Create PR → wait for green → rebase merge → cleanup
pr-ship --no-merge         # Create PR, check status, don't merge  
pr-ship --no-create        # Merge existing PR on current branch
pr-ship --wait 600         # Wait up to 10 min for checks
```

Workflow: Creates PR with `--fill`, polls for CI green, rebases & merges, then runs `finish-pr`.

### Infisical API CLI

For managing secrets and syncs via the Infisical API:

```bash
# Setup (one-time)
infisical-api setup

# List projects and secrets
infisical-api projects list
infisical-api secrets list -p <project-id> -e staging
infisical-api secrets export -p <project-id> -e production

# Render syncs
infisical-api syncs list <project-id>
infisical-api syncs force <sync-id>              # Force sync via temp secret

# Raw API access
infisical-api api /v1/some/endpoint
```

**Note:** Use canonical environment names: `staging` and `production`. If your Infisical project uses different slugs (e.g., `prod`), update them in the Infisical dashboard for consistency.

### Render CLI

```bash
render-services list
render-logs srv-xxxxx --level error --lines 50
render-workspace current
```

### Cloudflare CLI

```bash
cf-workers list                     # List workers
cf-workers deployments <name>       # Recent deployments
cf-logs <worker-name>               # Stream real-time logs (Ctrl+C to stop)
cf-logs <worker-name> --status 500  # Filter by HTTP status
```

Note: Cloudflare logs are real-time streaming only. Historical logs require Logpush (paid).

### Salesforce CLI

```bash
sf-query prod "SELECT Id, Name FROM Account LIMIT 10"
sf-query prod "SELECT Id, Name, StageName, Amount FROM Opportunity WHERE IsClosed = false"
sf-query prod "SELECT COUNT() FROM Contact"
sf-query prod describe Account              # Show object fields
sf-query sandbox "SELECT Id FROM Lead"      # Query sandbox
```

Note: SOQL is read-only by design. This tool cannot modify any Salesforce data.

### Linear CLI

```bash
# Read
linear-cli issues --mine --limit 10        # My issues
linear-cli issues --status "In Progress"   # Filter by status
linear-cli issue GTM-3424                  # Get specific issue
linear-cli search "authentication bug"     # Search issues
linear-cli teams                           # List all teams
linear-cli projects                        # List all projects

# Create (auto-assigned to you)
linear-cli create GTM "Fix login bug"
linear-cli create GTM "Add feature" --description "Details" --priority 2
```

### Notion CLI

For task boards and agent work tracking:

```bash
# Setup
notion-cc setup                            # Configure integration token

# Page commands
notion-cc get <url>                        # Get page details
notion-cc update-status <url> "Working on tests"  # Update status property
notion-cc set-blocked <url> [true|false]   # Set blocked checkbox
notion-cc move <url> "Done"                # Move to status (e.g., Done, In Progress)

# Comment commands
notion-cc comments <url>                   # List all comments
notion-cc comment <url> "Need clarification"  # Add a comment
notion-cc wait-for-comment <url>           # BLOCK until new comment (polls every 5s)

# Generic property update
notion-cc update-property <url> "Priority" "High" select
```

**Agent workflow pattern**:
1. Update status as you work: `notion-cc update-status <url> "Implementing feature X"`
2. If blocked: `notion-cc set-blocked <url> true && notion-cc comment <url> "Question here"`
3. Wait for response: `notion-cc wait-for-comment <url>` (blocks until user comments)
4. Continue work: `notion-cc set-blocked <url> false`
5. When done: `notion-cc move <url> "Done"`

### iMessage CLI

```bash
imsg chats --limit 10                    # List recent conversations
imsg history --chat-id 138 --limit 20    # View message history
imsg history --chat-id 138 --json        # JSON output for parsing
imsg send --to "+14155551212" --text "Hello!"  # Send a message
```

Requires Full Disk Access for terminal. From [github.com/steipete/imsg](https://github.com/steipete/imsg)

### Tmux Monitor (AI Agent Process Monitoring)

Monitor long-running processes in tmux sessions. Designed for AI agents that need to:
- Run tests/builds and wait for completion
- Check if background processes have failed
- Get structured JSON output about process state

```bash
# Quick status check - are any processes running/failed?
tmux-monitor status

# List all sessions with recent output
tmux-monitor list

# Run a command and wait for completion (blocking)
tmux-monitor run my-tests "npm test" --wait --timeout 300

# Start a long-running process (non-blocking)
tmux-monitor run dev-server "npm run dev"

# Wait for a specific session to complete
tmux-monitor wait my-tests --timeout 60

# Get full output from a session
tmux-monitor output dev-server --lines 200

# Kill a session
tmux-monitor kill dev-server
```

All commands output JSON by default. Add `--plain` for human-readable output.

**Status values:** `running`, `completed` (exit 0), `failed` (exit non-zero)

**Dependencies:** `brew install tmux steipete/tap/tmuxwatch jq`

From [github.com/steipete/tmuxwatch](https://github.com/steipete/tmuxwatch)

### Per-Project Override

Add to `.env`:
```bash
# Render
RENDER_WORKSPACE=tea-xxxxx
RENDER_API_KEY=rnd_xxxxx

# Cloudflare
CLOUDFLARE_ACCOUNT_ID=xxxxx
CLOUDFLARE_API_TOKEN=xxxxx

# Notion
NOTION_API_TOKEN=secret_xxxxx

# GitHub - uses gh CLI auth (run `gh auth login` if needed)
```

## Documentation

- [cli-over-mcp.md](./cli-over-mcp.md) - Why and how to replace MCP with CLI scripts
- [render-config.md](./render-config.md) - Render CLI configuration
