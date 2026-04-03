# ab — Browser Automation Wrapper for Claude Code

`ab` wraps `agent-browser` to provide safe, parallel browser automation for AI agents running in Claude Code sessions.

## Architecture

```
                    ┌─────────────────────────────────────────┐
                    │        Chrome (CDP port 9333)            │
                    │        One process, shared auth          │
                    │                                          │
                    │  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐   │
                    │  │Tab 0 │ │Tab 1 │ │Tab 2 │ │Tab 3 │   │
                    │  │blank │ │  /   │ │/admin│ │/cfg  │   │
                    │  └──────┘ └──┬───┘ └──┬───┘ └──┬───┘   │
                    │              │        │        │        │
                    └──────────────┼────────┼────────┼────────┘
                                   │        │        │
                              ┌────┴───┐┌───┴───┐┌──┴────┐
                              │daemon A││daemon B││daemon C│
                              │ab-main ││ab-qa1  ││ab-qa2  │
                              │ .sock  ││ .sock  ││ .sock  │
                              └────┬───┘└───┬───┘└───┬───┘
                                   │        │        │
                              main thread  subagent  subagent
```

**Key insight:** Each `AB_SUBAGENT_SESSION_ID` gets its own daemon process (`--session`) and its own Chrome tab (`tab new` on first open). Daemons are independent — no tab switching, no races.

## Session Isolation Model

```
SESSION NAME = ab-{CCO_SESSION_ID:0:8}-{AB_SUBAGENT_SESSION_ID}

cco session A, main:      ab-a1b2c3d4-main     → daemon + tab
cco session A, subagent:  ab-a1b2c3d4-f7e8d9   → daemon + tab
cco session B, main:      ab-c3d4e5f6-main     → daemon + tab

No collisions within a session  (different AB_SUBAGENT_SESSION_ID)
No collisions across sessions   (different CCO_SESSION_ID prefix)
```

## Quick Start

```bash
# Generate a unique session (subagents do this automatically)
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

# Auth
ab reauth               # grab cookies from personal Chrome
ab heal                  # nuclear reset
```

## Safety Layers

| Layer | What | How |
|-------|------|-----|
| `ab` wrapper | Whitelist-based CLI | Only listed commands pass through; unknown logged |
| `ab-guard` hook | PreToolUse enforcement | Blocks bad patterns, injects safety rules |
| `ab new-session` | Session generation | Unique ID per agent, no coordination needed |
| CDP port 9333 | Port isolation | Avoids conflict with default 9222 |
| `ab reauth` | Auth borrowing | Grabs cookies from personal Chrome safely |
| `ab record` | Auth-safe video | Uses `video start/stop` (no new browser context) |

## Files

| Path | Purpose |
|------|---------|
| `~/.local/bin/ab` | Symlink to this script |
| `~/.local/bin/ab-guard` | PreToolUse hook |
| `~/.local/bin/ab-subagent-hook` | SubagentStart hook |
| `~/.agent-browser/profile/` | Chrome profile (shared auth) |
| `~/.agent-browser/terra-auth.json` | Auth backup |
| `~/.agent-browser/ab-*.sock` | Per-session daemon sockets |
| `~/.agent-browser/unknown-commands.log` | Alias candidates |
| `~/.agent-browser/failed-commands.log` | Misuse patterns |
| `/tmp/ab-chrome-9333.pid` | Chrome PID tracking |
