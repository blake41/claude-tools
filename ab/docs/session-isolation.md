# ab — Session Isolation & Parallelism
_How_ `ab` _lets multiple callers drive one shared Chrome without stepping on each other. Written 2026-07-02. Source of truth:_ `src/cli.ts`_,_ `src/chrome-supervisor.ts`_._
## TL;DR
There are **two independent axes**. Keep them separate — conflating them is the source of every "wait, is parallelism broken?" confusion.

| Axis | What it isolates | Mechanism | Status |
| --- | --- | --- | --- |
| **1. Session** | Which Chrome **tab** you drive (page, DOM, viewport, recording) | pid → `ab-<pid>` session → own `Target.createTarget` tab | ✅ works cross-session and cross-subagent (hook announcement restored 2026-07-02) |
| **2. Auth identity** | **Who** you're logged in as | shared Chrome profile = one cookie jar | shared by design — always global, never per-session |

Most QA only needs Axis 1 as the same user (blake), and that works perfectly.
## Axis 1 — Session isolation (the machinery we built)
### The pid primitive
Everything keys off a **pid**, resolved once per `ab` invocation (`cli.ts`):

```
pid := AB_SESSION_PID ?? CCO_SESSION_ID ?? "default"     // resolvePid()
file := /tmp/.ab-session-<pid>                            // existence = initialized
session := ab-<pid>                                       // agent-browser --session identity
```

- All `ab` sessions share **one Chrome process** (managed by ab-server).
  
- Each distinct session name gets its **own tab** via `Target.createTarget`.
  
- So "current page / DOM / viewport / recording" is fully per-pid. No cross-talk on navigation or DOM state between two different pids.
  

`--session` / `--session-name` flags are **removed** — passing them throws `RemovedFlagError`. Identity comes from the pid, not a flag.
### Case A — Concurrent CC sessions (✅ works, no hook)
Each Claude Code process exports a distinct `CCO_SESSION_ID`, inherited by the `ab` child process. Different `CCO_SESSION_ID` → different pid → different tab. Nothing else required. This is the "two Claude windows at once" case and it is rock-solid.
### Case B — Concurrent subagents within one CC session
Subagents inherit the **parent's** `CCO_SESSION_ID`, so left alone they'd all resolve to the _same_ pid and collide on one tab. Two ways to give each subagent its own pid:

1. **SubagentStart hook (primary).** The `ab-subagent-hook` mints `AB_SESSION_PID=<CCO_SESSION_ID>-<sha256(agent_id)[:8]>`, writes a wrapper shim to `/tmp/ab-<pid>`, and **announces the wrapper path to the subagent via** `additionalContext`. The announcement is how the subagent learns its path (a hook cannot set env vars on the subagent). This is the intended design: the pid is a deterministic function of `agent_id`, so a subagent's session is **externally referenceable** — the main thread can recompute and enumerate it, not just the agent.

2. **Self-mint (fallback).** If a subagent gets no `[BROWSER INSTANCE]` line, it generates its own random-suffixed pid and runs `AB_SESSION_PID=<unique> ab new-session` before any browser command. No external provisioning, but the random pid is **not** recomputable by the main thread — so this is a resilience fallback, not the equivalent of the hook.

### The 2026-07-02 envelope bug (fixed)
For a period on CC ≈2.1.19x the hook's announcement was **silently dropped**: it emitted top-level `{"decision":"approve","additionalContext":…}`, but CC 2.1.x requires the nested envelope
`{"hookSpecificOutput":{"hookEventName":"SubagentStart","additionalContext":…}}`.
Subagents got no `[BROWSER INSTANCE]` line and either guessed a stranger's wrapper (inheriting stale state) or refused; the hook's only visible effect was one orphan wrapper per dispatch. This was a wrong-envelope bug, **not** a removed feature — `additionalContext` for `SubagentStart` is supported on 2.1.197. Fixing the envelope restored delivery (verified via a probe subagent). Self-mint was the interim workaround while the channel was down.
## Axis 2 — Auth identity (shared, by design)
- One Chrome profile: `--user-data-dir=~/.agent-browser/profile` (headless) / `profile-headed` (headed) — `chrome-supervisor.ts`.
  
- One profile = **one cookie jar** shared across every tab/pid.
  
- `ab reauth` performs a dev-login as blake (hardcoded `DEFAULT_AUTH_EMAIL` / `DEFAULT_SLACK_USER_ID`, `cli.ts`) and writes the session cookie into that shared profile.
  
- Therefore **who you're logged in as is global**. Every tab is blake.
  
### What this does and doesn't allow
- ✅ Any number of concurrent tabs/pids **as the same user** (blake). This covers essentially all QA.
  
- ❌ Two agents logged in as **different** users at the same time. They share the cookie jar; the last `reauth` wins for everyone. Terra impersonation (`?impersonate=…`) is likewise **server-side account-global delegation on blake's account**, not per-tab state — so no tab/profile trick isolates it.
  

**Rule:** never run two concurrent browser agents that need different effective users. If you need different-user QA, run them **serially** (reauth/impersonate, do the work, reset). True concurrent different-user QA would require per-session Chrome profiles/contexts — a much larger change than a CLI flag, and explicitly out of scope today.
## Quick reference
```bash
ab new-session            # initialize the session file for the current pid (idempotent)
ab ps                     # list live pids/wrappers (owner + age)
ab gc                     # reap wrapper/session files older than 24h
ab heal                   # kill Chrome, restart fresh — also the only thing that closes tabs
```

- Wrapper/tab accumulation is reaped by `ab gc` (24h) for files; tabs only close on `ab heal`. Do **not** `ab heal` while another CC session is live on the shared Chrome — it kills that session's tabs too.
