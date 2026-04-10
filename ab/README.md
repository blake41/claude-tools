# ab — Browser Automation for Claude Code Agents

`ab` is a daemon-backed CLI that provides safe, parallel browser automation for AI agents running in Claude Code sessions.

## Architecture

```
┌──────────────────────────────────────────────────────┐
│  ab-server daemon (Bun, managed by launchd)          │
│  ~/.agent-browser/ab-server.sock                     │
│                                                      │
│  Chrome Supervisor          Auth (dev-login)          │
│  ├─ headless (9333)         POST /auth/dev-login      │
│  │   always-on              → mint Clerk token        │
│  │   auto-restart           → exchange in browser     │
│  └─ headed (9444)           → real Clerk session      │
│      on-demand                                        │
│      10min idle timeout                               │
└──────────────────────────────────────────────────────┘
        │ Unix socket
        ▼
┌──────────────────────────────────────────────────────┐
│  ab CLI (thin TypeScript client)                     │
│  Lifecycle → RPC to daemon                           │
│  Automation → exec agent-browser directly            │
└──────────────────────────────────────────────────────┘
        │ Bun.spawn
        ▼
┌──────────────────────────────────────────────────────┐
│  agent-browser daemons (one per session)             │
│  ab-walker-005 ──► Chrome tab (headless)             │
│  ab-walker-008 ──► Chrome tab (headless)             │
│  ab-qa-headed  ──► Chrome tab (headed)               │
│  Each: 10min idle → self-destruct                    │
└──────────────────────────────────────────────────────┘
```

## Session Isolation

Each agent gets its own session — separate agent-browser daemon, separate Chrome tab, no interference. All sessions share one Chrome process (managed by ab-server) but each gets a dedicated tab via CDP `Target.createTarget`.

```
SESSION NAME = ab-{CCO_SESSION_ID:0:8}-{AB_SUBAGENT_SESSION_ID}

cco session A, main:      ab-a1b2c3d4-main     → daemon + tab
cco session A, subagent:  ab-a1b2c3d4-f7e8d9   → daemon + tab
cco session B, main:      ab-c3d4e5f6-main     → daemon + tab
```

Isolation works at two levels:
- **Within one Claude session:** Subagents get different `AB_SUBAGENT_SESSION_ID` → different tabs
- **Across Claude sessions:** Different `CCO_SESSION_ID` → different daemon names even with the same session name

Auth cookies are shared across tabs (same browser context), so `ab reauth` once and all sessions are authenticated.

## Quick Start

```bash
# Session ID is set automatically by the subagent hook.
# For manual use:
export AB_SUBAGENT_SESSION_ID=$(ab new-session)

# Navigate
ab open http://localhost:5173

# Interact
ab snapshot -i          # discover elements
ab click @e5            # click by ref
ab find text "X" click  # click by text
ab fill @e2 "query"     # type in input
ab screenshot           # capture page

# Record video
ab record start /tmp/demo.webm
# ... interact ...
ab record stop

# Auth (automatic on first open, or manual)
ab reauth               # authenticate via dev-login
ab heal                  # kill all sessions, restart Chrome
ab status               # daemon health + Chrome state
```

## Auth

Agents authenticate via **dev-login** — a Clerk sign-in token is minted by the backend and exchanged in the browser for a real session. No Google OAuth, no cookie stealing.

See **[docs/dev-login-auth.md](docs/dev-login-auth.md)** for the full flow, configuration, and troubleshooting.

## Daemon Management

The daemon runs via launchd and auto-starts on login.

```bash
ab status                               # Show daemon state
launchctl start com.clay.ab-server      # Start manually
launchctl stop com.clay.ab-server       # Stop
launchctl restart com.clay.ab-server    # Restart
tail -f /tmp/ab-server-error.log        # Daemon logs (structured JSON)
```

Chrome is supervised with health checks every 5s and auto-restart with exponential backoff (1s → 30s cap). Agent-browser sessions self-destruct after 10 minutes of inactivity.

## Install / Uninstall

```bash
cd ~/Documents/Development/tools/ab
bun run install.ts           # Install daemon + CLI
bun run install.ts --uninstall  # Uninstall, restore old ab
```

## Files

| Path | Purpose |
|------|---------|
| `src/daemon.ts` | Daemon entry point |
| `src/chrome-supervisor.ts` | Chrome lifecycle (launch, health, restart) |
| `src/server.ts` | Unix socket HTTP server |
| `src/auth.ts` | Dev-login auth flow |
| `src/cli.ts` | CLI entry point (replaces old bash ab) |
| `src/rpc.ts` | CLI → daemon RPC client |
| `src/state.ts` | Chrome state machine |
| `src/types.ts` | Shared types |
| `src/logger.ts` | Structured JSON logger |
| `com.clay.ab-server.plist` | launchd plist template |
| `install.ts` | Install/uninstall script |
| `console-tail.ts` | Stream browser console via CDP |
| `cdp-click.ts` | JS-based click for virtualized lists |
| `~/.agent-browser/ab-server.sock` | Daemon Unix socket |
| `~/.local/bin/ab` | CLI shim |
| `~/.local/bin/ab.bash.bak` | Old bash ab (rollback) |

## Docs

- **[docs/dev-login-auth.md](docs/dev-login-auth.md)** — Auth flow, configuration, troubleshooting
- **[docs/agent-browser-reference/SKILL.md](docs/agent-browser-reference/SKILL.md)** — Agent-browser command reference
