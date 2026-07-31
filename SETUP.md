# Claude Code Workflow — Setup Guide
How the workflow layers together: from the Claude binary to the skills that teach it how to use your tools.

* * *
## The Chain
```
~/.claude/CLAUDE.md          ← what Claude reads first (discipline, routing, tool registry)
~/.claude/rules/             ← rule files CLAUDE.md delegates to
~/.claude/settings.json      ← hooks, plugins, model config
~/.claude/hooks/             ← shell scripts that run at lifecycle events

~/Documents/Development/tools/   ← tool source repos (git)
~/.local/bin/                    ← symlinks → tools (gets them in PATH)

~/.claude/skills/            ← skill SKILL.md files that teach Claude how to invoke tools
~/.claude/agents/            ← agent persona files (haiku-worker, implementer, reviewers)
```

Each layer depends on the one above it. CLAUDE.md tells Claude _what tools exist_. Skills teach it _how to use them_. The tools themselves live in `~/Documents/Development/tools/` and are exposed via symlinks in `~/.local/bin/`.

* * *
## Layer 1 — CLAUDE.md (The Entry Point)
**What it is:** The global instruction file Claude reads at the start of every session.

**Location:** `~/.claude/CLAUDE.md`

**What it does:**

- Sets behavioral rules (never use npm, stop on permission errors, etc.)
  
- Registers the CLI tools Claude knows about (via `rules/cli-tools.md`)
  
- Defines implementation routing (`main thread → /implement → /ship-lite → /ship`)
  
- Points to deeper rule files in `~/.claude/rules/`
  

**For coworkers:** Share your CLAUDE.md, but trim company-specific project aliases and paths before handing it over. The behavioral rules (bun, permissions, cost routing) are universal.

* * *
## Layer 2 — Rules (Discipline Files)
**What they are:** Focused markdown files that CLAUDE.md delegates to. Claude reads them all.

**Location:** `~/.claude/rules/`

| File | What it enforces | Share? |
| --- | --- | --- |
| `permissions.md` | Stop on permission errors — never work around them | Yes |
| `bun.md` | Always bun, never npm/npx | Yes |
| `cli-tools.md` | Registry of all CLI tools and how to invoke them | Customize per person |
| `plan-mode.md` | Structured review process (BIG/SMALL toggle) | Yes |
| `cost-aware-routing.md` | Delegate lookups to haiku-worker subagent | Yes |
| `post-pipeline-review.md` | After /ship: conformance gate + adversarial review | Yes |
| `render-safe.md` | Render.com deployment safety rules | Only if they use Render |
| `worktrees.md` | Git worktree naming and safety rules | Yes |

**Most important to customize:** `cli-tools.md` — it lists every tool by name and tells Claude how to invoke it. Only list tools the coworker has actually installed.

* * *
## Layer 3 — Hooks (Automated Behavior)
**What they are:** Shell scripts that execute at Claude Code lifecycle events. The harness runs these automatically — Claude doesn't.

**Location:** `~/.claude/hooks/` (scripts), wired up in `~/.claude/settings.json`

| Hook | Event | What it does | Share? |
|------|-------|-------------|--------|
| `npm-guard` | PreToolUse (Bash) | Blocks `npm`/`npx`, points to bun | Yes |
| `dcg` | PreToolUse (Bash) | Database safety guard | Yes |
| `render-guard` | PreToolUse (Bash) | Prevents destructive Render ops | If they use Render |
| `ab-session-guard` | PreToolUse (Bash) | Browser automation safety | Only with `ab` |
| `bash-logger` | PostToolUse | Logs bash command usage | Yes |
| `delegation-logger` | PostToolUse | Tracks subagent delegation | Yes |
| `claude-exit-logger` | Stop | Session exit logging | Yes |
| `cmux-rename-on-session.sh` | SessionStart / Stop | Terminal window naming | **Vestigial** — cmux v0.64+ handles session auto-resume natively; this hook predates that and may do nothing useful |

* * *
## Layer 4 — CLI Tools (The Actual Executables)
**What they are:** Shell scripts or binaries that perform actions. These are what Claude invokes when it uses a tool.

**Source repos:** `~/Documents/Development/tools/<name>/`

**In PATH via:** `~/.local/bin/<name>` → symlinks → tool source

**The install pattern:**

```bash
# 1. Clone or copy the tool directory
# 2. Symlink the executable to ~/.local/bin/
ln -s ~/Documents/Development/tools/db-safe/db-safe ~/.local/bin/db-safe
```
### Credentials pattern
Most tools store credentials in `~/.config/<tool>/` — not in shell env vars or `.env` files. The tool checks the config file at runtime.

| Tool | Credential file | How to get the key |
|------|----------------|-------------------|
| `linear-cli` | `~/.config/linear/api-key` | Linear → Settings → Security & access → API keys |
| `notion-cc` | `~/.config/notion/api_token` | Notion → Settings → Integrations → New integration |
| `render-*` | `~/.config/render/api_key` | Render dashboard → Account → API keys |
| `cf-*` (cloudflare) | `~/.config/cloudflare/token` | Cloudflare dashboard → My Profile → API Tokens |
| `infisical-api` | `~/.config/infisical/credentials` | Infisical → Project → Machine Identities → Universal auth |
| `lsmith` | `~/.config/langsmith/` | smith.langchain.com → Settings → API keys |
| `c7` | `~/.config/c7/config` | context7.com/dashboard (free tier) |
| `db-safe` | Per-project `.db-safe.json` | Connection strings from Render / Infisical |

After writing a credential file, the tool works without any env var exports.
### Tools in this repo
Easy — credentials only, no code changes needed

| Tool | Binary | What it does |
|------|--------|-------------|
| `api-probe` | `~/.local/bin/api-probe` | API endpoint discovery, GraphQL introspection |
| `beam` | `~/.local/bin/beam` | Breadboard-to-TLDraw diagram export |
| `c7` | `~/.local/bin/c7` | Context7 documentation lookup |
| `cloudflare/cf-*` | `~/.local/bin/cf-*` | Cloudflare Workers + logs |
| `codex-ask` | `~/.local/bin/codex-ask` | OpenAI Codex API wrapper |
| `db-safe` | `~/.local/bin/db-safe` | Safe database CLI — read/write with guardrails |
| `drawbridge` | `~/.local/bin/drawbridge` | Real-time diagram server |
| `git-prune-merged` | `~/.local/bin/git-prune-merged` | Rebase-aware branch cleanup |
| `github/` | `~/.local/bin/finish-pr`, `pr-ship` | GitHub PR wrappers (uses `gh` CLI auth) |
| `infisical/` | `~/.local/bin/infisical-api` | Secrets management |
| `langsmith/` | `~/.local/bin/lsmith` | LangSmith trace inspection |
| `linear/` | `~/.local/bin/linear-cli` | Linear issue CLI |
| `mermaid-render` | local only | Mermaid diagram renderer |
| `notion/` | `~/.local/bin/notion-cc` | Notion kanban board CLI |
| `render/` | `~/.local/bin/render-*` | Render.com deployment + log viewing |
| `skill-gen` | `~/.local/bin/skill-gen` | Skill file generator |
| `tmux/` | `~/.local/bin/tmux-monitor` | Tmux session monitoring |
| `sandbox/` | `~/.local/bin/sandbox` | Seatbelt/bwrap sandbox wrapper |

Medium — minor path/config fixes needed

| Tool | Issue | Fix |
|------|-------|-----|
| `session-explorer` | Hardcoded `/Users/blake/` in source; launchd plist name has `blake` in it | Replace with `$HOME`; rename plist to `com.<user>.session-explorer` |
| `tab-out` | `install.sh` uses hardcoded path | Update to use `$HOME` |

Hard / significant setup required

| Tool | Why | What's needed |
|------|-----|--------------|
| `agent-browser` | **Rust binary** forked from `vercel-labs/agent-browser` (public) with two custom commits on top: `actionability transaction for click` (catches intercepted/offscreen elements) and `click-js verb + video recording + active-page semantics`. The public binary from Vercel Labs is missing these. Coworkers need **this fork** built from source. Requires: Rust toolchain + `cargo build --release` from the fork. | Share the fork or distribute a pre-built binary (ARM64 + x86). |
| `ab` | Wraps `agent-browser` (blocked by above). Hardcoded defaults: `blake.johnson@clay.com` and Slack user ID `U08M03CDY73`. Clay-specific `dev-login` flow via internal Clerk instance. | Fix `agent-browser` first. Then externalize email + Slack ID to `~/.config/ab/config`. |
| `watch-deploy` | Entire tool is Clay-specific: hardcoded `clay-run/Terra` and `clay-run/keystone` repo+service ID mappings. | Fine for Clay coworkers who work on Terra/Keystone. Anyone else needs the `case` statement rewritten as a config file. |
| `salesforce` | Hardcoded Clay org aliases (`vscodeOrg`, `MySandbox`). | Fine for Clay coworkers on the same Salesforce orgs. Otherwise update aliases. |

Retired — do not install

| Tool | Why |
| --- | --- |
| `cmux/` | Custom session persistence for cmux — retired when cmux v0.64.0 shipped native agent session auto-resume. Directory is empty. |

* * *
## Layer 5 — Skills (Teaching Claude to Use the Tools)
**What they are:** Markdown files in `~/.claude/skills/<name>/SKILL.md`. Claude reads these when a matching slash command is invoked or when a trigger phrase appears.

**Location:** `~/.claude/skills/`

**The relationship to tools:** Each tool in `~/.local/bin/` typically has a matching skill that tells Claude:

- When to use the tool
  
- What arguments to pass
  
- How to interpret the output
  
- What not to do
  

**Example:** `~/.claude/skills/cli:render/SKILL.md` teaches Claude when to run `render-services` and `render-logs`, how to format queries, and what the output means.

**Two invocation modes:**

- **Model auto-invoke:** Claude triggers automatically on matching situations (e.g., "check the deploy logs" → fires `cli:render`)
  
- **Slash-only:** Only runs when you explicitly type `/cli:linear` or similar
  

**For coworkers:** Skills are the most valuable part to share. Install only the skills for tools the coworker has set up. Each skill is a single SKILL.md file — copy the directory into `~/.claude/skills/`.

* * *
## Layer 6 — Agents (Subagent Personas)
**What they are:** Markdown files in `~/.claude/agents/<name>.md` that define specialized subagent personas.

**Location:** `~/.claude/agents/`

**Key agents:**

- `haiku-worker` — Cheap lookup/grep/classification. Routes to Haiku, not Sonnet.
  
- `implementer` — Opinionated code implementation. Follows TDD methodology.
  
- `verification-runner` — Runs tests/lint/typecheck. Mechanical only — no interpretation.
  
- `adversarial-reviewer` / `correctness-reviewer` / `testing-reviewer` — Review personas.
  
- `fable` / `opus` — High-capability reasoning (expensive, use sparingly).
  

**For coworkers:** Share all of these — they're fully generic, no configuration needed.

* * *
## session-explorer (The `/recall` Command)
**What it is:** A local web app that indexes all Claude Code sessions from `~/.claude/projects/` into SQLite with FTS5 full-text search. Runs as a launchd daemon on `http://localhost:5198`.

**Why it needs its own section:** Unlike the other tools, this one runs continuously in the background and calls the Anthropic API on its own (auto-summarizes new sessions with Haiku, extracts insights with Sonnet).

**Setup for a new machine:**

```bash
# 1. Clone the repo
git clone <tools-repo> ~/Documents/Development/tools
# 2. Install dependencies
cd ~/Documents/Development/tools/session-explorer && bun install
# 3. Create the launchd plist
# Edit com.blake.session-explorer.plist — change:
#   - WorkingDirectory to your clone path
#   - ANTHROPIC_API_KEY value
#   - ProgramArguments bun path (run `which bun`)
#   - Rename the plist Label to com.<yourname>.session-explorer
# 4. Load the service
launchctl load ~/Library/LaunchAgents/com.<yourname>.session-explorer.plist
# 5. Verify
curl -s http://localhost:5198/api/ingest/status | jq .
```

**Cost note:** Auto-summarization uses Haiku (~~$0.001/session). Insight extraction uses Sonnet (~~$0.01/session). On a busy day it runs quietly in the background. Each person needs their own `ANTHROPIC_API_KEY`.

* * *
## CCO Sandbox
**What it is:** Claude Code's sandbox mode. `cco` restricts which directories Claude can write to. The allowlist lives at `~/.config/cco/dirs`.

**Critical rule:** Never edit `~/.config/cco/dirs` without explicit user permission — it controls the security boundary.

**For coworkers:** They configure this per-machine by adding their project paths. Don't share this file — it's personal to each machine.

* * *
## What to Share vs What to Keep Personal
| Component | Share? | Notes |
|-----------|--------|-------|
| `CLAUDE.md` | Yes, customized | Remove company-specific project aliases |
| `rules/bun.md`, `permissions.md`, `plan-mode.md` | Yes | Universal |
| `rules/cli-tools.md` | Customize | Only list installed tools |
| `rules/render-safe.md` | If they use Render | |
| `settings.json` hooks | Selectively | Skip `cmux-rename-on-session.sh` |
| Tool source repos (this repo) | Yes | They clone + symlink per tool |
| Skill `SKILL.md` files | Per tool installed | |
| Agent persona files | Yes | Generic, no config |
| `~/.config/<tool>/` credential files | **Never** | Personal API keys |
| `~/.config/cco/dirs` | **Never** | Personal sandbox config |
| `agent-browser` binary | **No** | Build from source or distribute pre-built |

* * *
## Minimum Viable Install for a Clay Coworker
This gets a new Clay engineer running with the core tools. Assumes they have: Homebrew, Bun, `gh` CLI authenticated, Fish shell.

```bash
# 1. Clone tools
git clone git@github.com:clay-run/tools.git ~/Documents/Development/tools
# 2. Create config dirs
mkdir -p ~/.claude/rules ~/.claude/skills ~/.claude/hooks ~/.claude/agents
# 3. Copy universal files
cp /path/to/shared/CLAUDE.md ~/.claude/CLAUDE.md
cp /path/to/shared/rules/{bun,permissions,plan-mode,cost-aware-routing,post-pipeline-review,worktrees}.md ~/.claude/rules/
# 4. Symlink the easy tools
for tool in db-safe git-prune-merged api-probe lsmith; do
  ln -s ~/Documents/Development/tools/$tool/$tool ~/.local/bin/$tool
done
ln -s ~/Documents/Development/tools/render/render-services ~/.local/bin/render-services
ln -s ~/Documents/Development/tools/render/render-logs ~/.local/bin/render-logs
ln -s ~/Documents/Development/tools/linear/linear-cli ~/.local/bin/linear-cli
ln -s ~/Documents/Development/tools/notion/notion-cc ~/.local/bin/notion-cc
# 5. Set up credentials (each person does this themselves)
mkdir -p ~/.config/{render,linear,notion,infisical,langsmith}
echo "YOUR_RENDER_KEY" > ~/.config/render/api_key
echo "YOUR_LINEAR_KEY" > ~/.config/linear/api-key
echo "YOUR_NOTION_TOKEN" > ~/.config/notion/api_token
# etc.
# 6. Copy a cli-tools.md that only lists what's installed
cp /path/to/shared/rules/cli-tools-minimal.md ~/.claude/rules/cli-tools.md
# 7. Copy skills for installed tools
for skill in cli:render cli:linear cli:notion session-explorer; do
  cp -r /path/to/shared/skills/$skill ~/.claude/skills/
done
# 8. Copy agent personas
cp /path/to/shared/agents/*.md ~/.claude/agents/
# 9. Configure settings.json (hooks, model)
cp /path/to/shared/settings-minimal.json ~/.claude/settings.json
```

**What's deferred:** `ab`/`agent-browser` (needs Rust build from private repo + Clay auth config), `session-explorer` daemon (needs launchd plist + Anthropic API key).

* * *
## Key Files Reference
```
~/.claude/CLAUDE.md                  Main instructions
~/.claude/settings.json              Hooks, plugins, model, status line
~/.claude/rules/cli-tools.md         CLI tool registry (keep in sync with what's installed)
~/.claude/skills/<name>/SKILL.md     Per-tool skill definitions
~/.claude/hooks/<name>               Lifecycle hook scripts
~/.claude/agents/<name>.md           Subagent persona definitions
~/Documents/Development/tools/       Tool source repos
~/.local/bin/                        Symlinks → tools (must be in $PATH)
~/.config/<tool>/                    Credential files (never share)
~/.config/cco/dirs                   Sandbox allowlist (never share)
```
