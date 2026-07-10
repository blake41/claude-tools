# ab — Session Isolation & Parallelism
_How_ `ab` _lets multiple callers drive a pool of shared Chrome instances without stepping on each other. Written 2026-07-02, updated 2026-07-10 (chrome-pool-plan Unit 3). Source of truth:_ `src/cli.ts`_,_ `src/chrome-supervisor.ts`_._
## TL;DR
There are **two independent axes**. Keep them separate — conflating them is the source of every "wait, is parallelism broken?" confusion.

| Axis | What it isolates | Mechanism | Status |
| --- | --- | --- | --- |
| **1. Session** | Which Chrome **tab** you drive (page, DOM, viewport, recording) | pid → `ab-<pid>` session → own `Target.createTarget` tab, on a sticky-assigned pool shard | ✅ works cross-session and cross-subagent (hook announcement restored 2026-07-02) |
| **2. Auth identity** | **Who** you're logged in as | one cookie jar **per pool shard** — same global identity in every jar | per-shard by design (chrome-pool-plan Unit 3) — still never per-session |

Most QA only needs Axis 1 as the same user (blake), and that works perfectly.
## Axis 1 — Session isolation (the machinery we built)
### The pid primitive
Everything keys off a **pid**, resolved once per `ab` invocation (`cli.ts`):

```
pid := AB_SESSION_PID ?? CCO_SESSION_ID ?? "default"     // resolvePid()
file := /tmp/.ab-session-<pid>                            // existence = initialized
session := ab-<pid>                                       // agent-browser --session identity
```

- `ab` sessions share a **pool of N headless Chrome instances** (managed by ab-server, default N=3, `AB_HEADLESS_POOL_SIZE`) instead of a single one. Each session's pid gets **stickily assigned** to one shard — least-loaded at first use, persisted in that session's marker file (`shard=<i>`, second line) — and every subsequent command from that pid reuses the same shard. This is what removed the single-Chrome concurrency ceiling that used to stall CDP under 10-15 concurrent sessions.
  
- Each distinct session name gets its **own tab** via `Target.createTarget`, on whichever shard it's pinned to.
  
- So "current page / DOM / viewport / recording" is fully per-pid. No cross-talk on navigation or DOM state between two different pids, whether they land on the same shard or different ones.
  

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
## Axis 2 — Auth identity (shared per shard, by design)
- **Per-shard Chrome profiles, not one global profile.** Each headless pool shard gets its own `--user-data-dir`: `~/.agent-browser/profile` (shard 0, the pre-pool profile — zero-migration back-compat) / `profile-<i>` (shard ≥1). Headed stays single, as before: `profile-headed` — `chrome-supervisor.ts`.
  
- One profile per shard = **one cookie jar per shard**. Sessions pinned to the same shard (Axis 1's sticky mapping) share that shard's cookie jar; sessions on *different* shards do **not** share cookies, even though they're the same hardcoded identity.
  
- `ab reauth` performs a dev-login as blake (hardcoded `DEFAULT_AUTH_EMAIL` / `DEFAULT_SLACK_USER_ID`, `cli.ts`) and writes the session cookie into **the calling session's assigned shard's profile** — shard-correct for free, since `reauth` is one of the commands that resolves the session's sticky shard and ensures that shard's Chrome before running, so `cmdReauth` always receives that shard's real CDP port, never a hardcoded constant. Headed reauth (`--headed`) is unaffected — it always targets the single headed Chrome (port 9444), independent of headless shard assignment.
  
- Therefore **who you're logged in as is global across shards** — every reauth call uses the same hardcoded identity — but each shard's cookie jar is a separate, independently-populated copy of that identity. A shard nobody has reauth'd yet starts out logged out. Any Chrome-needing command prints a one-line stderr hint (`fresh profile for this shard — run 'ab reauth' if you need auth`) the first time a session lands on such a shard, so this isn't a silent surprise.
  
### What this does and doesn't allow
- ✅ Any number of concurrent tabs/pids **as the same user** (blake), spread across shards. This covers essentially all QA — reauth is a one-time cost per shard's lifetime (until that shard's Chrome restarts), not per session.
  
- ❌ Two agents logged in as **different** users at the same time *on the same shard*. Sessions sharing a shard share that shard's cookie jar; the last `reauth` on that shard wins for everyone pinned to it. Terra impersonation (`?impersonate=…`) is likewise **server-side account-global delegation on blake's account**, not per-tab state — so no tab/profile trick isolates it within a shard.
  

**Rule:** never run two concurrent browser agents on the *same shard* that need different effective users. If you need different-user QA, either accept that different sessions may land on different shards anyway (no guarantee, since assignment is load-based not identity-based) or run the different-user work **serially** (reauth/impersonate, do the work, reset). True concurrent different-user QA would require per-*session* auth identity — cookies scoped to a tab, not a whole shard's profile — which is a materially different (and larger) change than the per-shard profile pool this plan built. **Scoping note:** an earlier version of this doc called per-session Chrome profiles "explicitly out of scope today"; chrome-pool-plan (2026-07-10) deliberately crossed that boundary at the *shard* granularity (N profiles, load-balanced, not identity-routed). Per-*session* identity — a distinct cookie jar per pid rather than per shard — remains out of scope.
## Quick reference
```bash
ab new-session            # initialize the session file for the current pid (idempotent)
ab ps                     # list live pids/wrappers (owner + age)
ab close                  # tear down THIS session's tab + reap its /tmp markers (no-op if Chrome is down; never boots Chrome)
ab gc                     # reap wrapper/session files older than 24h
ab heal                   # kill Chrome, restart fresh — closes EVERY session's tabs
```

- **Targeted teardown:** `ab close` closes only the calling session's tab and removes its `/tmp` markers, so `ab ps` reflects it immediately. This is the clean "I'm done" path — a backgrounded agent should call it on a terminal verdict (but **not** while it may still be resumed).
- **Nuclear:** `ab heal` kills Chrome entirely and closes **every** session's tabs. Do **not** `ab heal` while another CC session is live on the shared Chrome.
- **Passive:** `ab gc` reaps `/tmp` wrapper/session *files* older than 24h; it does not touch Chrome tabs.
