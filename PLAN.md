# Epic runner: plan, spike and first test epic
Status: draft for review (2026-11-03). Owner: Blake.
## 1. Problem
Long beads epics are mostly mechanical once planned. Today an agent session runs them, and the owner babysits.

Evidence from 2026-06-01 to 2026-10-28 (cass + raw transcripts):

- 138 sessions ran `/ship` or `/ship-lite`. Sample sessions took 36 to 117 owner messages.
  
- 45 owner nudges ("are you stuck?", "did it finish?", "keep going") in 39 sessions.
  
- 339 API-error events (226 in main threads, 113 in subagents): network, 500, 529, stalls.
  
- The big mechanical epics took weeks: `bd-ozirv` 27 children / 17 days, `bd-0c3.8` 17 / 15 days, `bd-etpy` 21 / 14 days.
  

Root cause: subagents and Workflow runs live inside one session. A transient API failure kills the subagent, `agent()` returns null, and the main thread waits. A long-lived LLM supervisor also pays a full uncached context read on every wake after the 5-minute cache window.
## 2. Goal and success criteria
Hand an epic id to a runner. It drives the epic to merged code (or to "PR ready", per policy) with no owner message except real one-way-door decisions.

| #   | Criterion | Measured how |
| --- | --- | --- |
| G1  | Zero owner nudges on the test epic | Count of owner messages that are not answers to Inbox questions |
| G2  | Every transient worker failure (kill, stall, 529) recovered with no owner action | Runner event log: failure event followed by recovery event |
| G3  | Supervisor spends 0 LLM tokens while idle | Runner has no LLM in its loop; judgment calls are logged with token counts |
| G4  | No PR merges unless every gate in the epic policy passed at the PR's head commit | Gate ledger: each gate verdict carries the SHA it judged |
| G5  | Owner gets every real question in the Plannotator Inbox, one thread per bead, and the reply wakes the right worker | Spike S4 plus test-epic log |
| G6  | Cost per bead is known | tokens per bead from transcripts + `no-mistakes stats` |
## 3. Non-goals
- Parallel beads in one wave. v1 runs beads one at a time on the epic branch (same rationale as `~/.claude/workflows/ship/DESIGN.md`: disjointness is not provable up front). Parallel waves come later, using `~/.claude/workflows/docs/parallel-builds-design.md`.
  
- Planning. The epic and its beads exist before the runner starts. Planning stays with `/ce-plan`, `/ship` phase 1, or the owner.
  
- Replacing ship-lite for unplanned work.
  
- Agent mail, ntm, firstmate, treehouse, tasks-axi (evaluated, skipped; reasons in section 10).
  
## 4. Architecture
```
pm2: epic-runner <epic-id>            bun, no LLM, state on disk
 ├─ schedule   br ready --parent <epic>, topo order, one bead at a time
 ├─ quota      quota-axi: do not dispatch into an exhausted window
 ├─ worker     herdr workspace (cwd = epic worktree) → claude (interactive) → bead brief
 │              status line protocol + Plannotator Inbox for questions
 ├─ liveness   herdr events + own checks (output hash, transcript mtime, error text)
 ├─ rotate     context > threshold → /baton drop → fresh session /baton grab
 ├─ wave gate  no-mistakes axi run (rebase, review?, lint, push, PR, CI repair)
 ├─ merge gate epic policy gates, SHA-bound verdicts, downgrade rules
 └─ judgment   fresh short `claude -p` (opus/fable) with a small bundle, only when rules cannot decide
```
### 4.1 Data shapes
The runner is a state machine over beads, persisted after every transition. Idempotent: a restart re-reads state and resumes.

```ts
type EpicPolicy = {
  epicId: string
  repo: string                       // absolute path of main checkout
  branch: string                     // epic branch, e.g. epic/bd-xxxx
  prUnit: 'bead' | 'wave' | 'epic'
  waves: string[][]                  // bead ids per PR; derived from beads if absent
  gates: Gate[]
  onPass: 'merge' | 'stop_at_pr'
  downgradeToStopIf: Downgrade[]
  rotateAtTokens: number             // default 300_000
  workerModel: 'sonnet' | 'opus'
}

type Gate =
  | { kind: 'ci_green_at_head' }
  | { kind: 'linear_on_base' }
  | { kind: 'review'; skill: string; model: 'opus' | 'fable' | 'sonnet';
      passWhen: { maxSeverity: 'minor' | 'major' }; fixLoop?: { model: string; maxRounds: number } }

type Downgrade =
  | { kind: 'touches'; globs: string[] }
  | { kind: 'diffLinesOver'; n: number }
  | { kind: 'filesOutsideBeadScope' }
  | { kind: 'fixRoundsExhausted' }

type BeadState =
  | { s: 'queued' }
  | { s: 'working'; sessionId: string; pane: string; startedAt: number; restarts: number }
  | { s: 'needs_decision'; sessionId: string; inboxThread: string; since: number }
  | { s: 'rotating'; fromSession: string; baton: string }
  | { s: 'committed'; sha: string }
  | { s: 'parked'; reason: string }   // owner must act; dependents park too
  | { s: 'failed'; reason: string }

type WaveState =
  | { s: 'building' }
  | { s: 'validating'; nmRun: string }          // no-mistakes run id
  | { s: 'pr_open'; pr: number; head: string }
  | { s: 'gating'; pr: number; head: string; verdicts: GateVerdict[] }
  | { s: 'merge_ready'; pr: number; head: string }
  | { s: 'stopped_at_pr'; pr: number; why: string }
  | { s: 'merged'; pr: number; sha: string }

type GateVerdict = { gate: Gate['kind']; head: string; pass: boolean; findings?: Finding[]; at: number }
type Finding = { severity: 'nit' | 'minor' | 'major' | 'blocker'; file: string; line: number; summary: string }
```

A verdict whose `head` differs from the PR's current head is void. Any push re-runs the gates.
### 4.2 Worker status protocol
Each worker appends lines to `<worktree>/.epic-runner/status` (git-ignored):

```
working: <one line>
needs-decision thread=<inbox thread id>: <question in one line>
rotate baton=<path>
done sha=<commit sha>
failed: <reason>
deferred: <what is waiting>
```

The runner trusts files, exit codes and git, not prose. `done` is checked: the sha must exist on the epic branch and `git status` must be clean.
### 4.3 Worker brief (one bead)
1. `br show <bead>`. Read the bead, the epic, and any baton in `.baton/`.
  
2. Implement with tests (implementer method: RED then GREEN where testable).
  
3. Run the scope gates from CLAUDE.md for touched paths. Run `bun run lint:suppressions:prune` when a baselined site is fixed.
  
4. Commit on the epic branch. One bead = one commit (or a few).
  
5. Write `done sha=<sha>`. End the turn.
  
6. A question is allowed only for a one-way door. First classify it (reversible / default / needs-user, the `open-question-resolver` rules). Reversible or default: decide, and log under `REVIEW-THESE` in the commit body. Needs-user: send it to the Plannotator Inbox with `thread: "<epic>/<bead>"` and `project_path: <main repo root>`, write `needs-decision`, end the turn.
  
### 4.4 Liveness and recovery ladder
| Signal | Action |
| --- | --- |
| Pane process gone | `claude --resume <sessionId>` in a new pane, note "you were restarted, re-read status and git" |
| `working` but no output change and no transcript write for 8 min | read pane; if API error text, wait with backoff then send "continue"; else interrupt (Esc) then "continue" |
| herdr `blocked` (permission/dialog) | never type into it; park bead, Inbox message to owner with the pane text |
| 3 restarts on one bead | park bead, Inbox message, continue independent beads |
| Restart after a death with no baton | new session with `/baton grab <deadSessionId>` |
| quota-axi says window exhausted | sleep until `resetsAt` |

Dead herdr server: `herdr session attach` needs a terminal, so the runner cannot use it. `herdr --session <name> server` runs headless and exits with `error: herdr server is already running` if one is up. On `server_not_running` the runner starts that command detached, waits up to 15 s for `herdr --session <name> status server` to report `running`, logs `herdr_server_restarted`, and retries the call once (at most one restart per tick). The old panes are gone, so the worker takes the "pane process gone" row above. A failed restart counts as a failed tick; the halt notice names the command to run by hand.
### 4.5 Context rotation
- Runner starts each worker with `--session-id <uuid>`, so the transcript path is known.
  
- Context size = `input + cache_read + cache_creation` on the last assistant message of the transcript.
  
- A `PostToolUse` hook (in the worker's `--settings`) injects one line past the threshold: finish the current edit, commit WIP, run `/baton drop`, write `rotate baton=<path>`.
  
- At 1.3x threshold the runner interrupts and sends the drop prompt itself.
  
- Fresh session in the same worktree starts with `/baton grab`.
  
### 4.6 Merge policy presets
| Preset | Gates | On pass |
|---|---|---|
| `pr-only` | CI at head, linear | stop at PR |
| `thermo-merge` (default) | CI at head, linear, `p:thermonuclear-code-quality-review` on opus, fix loop sonnet x3, pass when no finding at `major` or above | merge |
| `full` | thermo-merge + seeded adversarial review (post-pipeline-review rule) | merge |

Default downgrades (merge becomes stop-at-PR): touches `prisma/migrations/**`, `render.yaml`, `.github/**`, `Dockerfile*`, `scripts/pre-deploy.sh`; diff over 800 lines; files outside bead scope; fix rounds exhausted.

Reviewers are fresh `claude -p` processes given the diff and bead text only. They return JSON findings. The runner applies `passWhen`.

Merges are serial. Before each merge, rebase the next PR on the new `origin/master` and wait for CI again. Optional: wait for a healthy Render deploy between merges.
## 5. Test epic: burn down `terra/no-hand-rolled-cache`
Picked from the standards post-mortem (`.claude/worktrees/standards-wave-4/.baton/2026-11-02-standards-postmortem.html`). Its "what next" asks for a burn-down plan for baselined errors, starting with the rules agents most often copy.

Why this rule:

- Mid-size. 26 baselined sites in 13 files (origin/master, measured 2026-11-03).
  
- Backend only. No browser QA needed.
  
- Objective done predicate: the rule has zero entries in `oxlint-suppressions.json`, and `bun run check` and `bun run test:backend` pass.
  
- The canonical way exists: `registerInvalidatedCache(model, bust)` (`docs/standards/ttl-caches.md`).
  
- Some sites need judgment (a cache of an external API has no Prisma model to bust on). That exercises the Inbox path and the reversible/default classification.
  
- Two sites are auth (`src/auth/clerk-user-email-cache.ts`, `src/auth/resolve-terra-user.ts`). That exercises the downgrade rule (add `src/auth/**` to the test policy).
  

Sites:

| count | file |
| --- | --- |
| 6   | mini-apps/book-carve/universe.ts |
| 2   | mini-apps/book-carve/access.ts |
| 4   | src/services/copilot-channels.ts |
| 3   | src/auth/clerk-user-email-cache.ts |
| 1   | src/auth/resolve-terra-user.ts |
| 2   | src/services/render-api.ts |
| 2   | src/services/terra-signals/snapshot.ts |
| 1   | src/api/v4/admin-priority-ranking.ts |
| 1   | src/jobs/runtime/in-flight-workflows.ts |
| 1   | src/services/notifications/action-view/admin/open-actions.ts |
| 1   | src/services/pipeline-stage-sync.ts |
| 1   | src/services/salesforce-resolution/on-demand-account.ts |
| 1   | src/services/skills/skill-registry.ts |

Created as epic `bd-43aa7` (counts re-measured on origin/master 2026-11-03, unchanged). `docs/standards/ttl-caches.md` splits the sites three ways, so the waves follow it, not file count:

- W1 (PR 1). `bd-43aa7.1` to `.7`: skill-registry, pipeline-stage-sync, admin-priority-ranking, open-actions, on-demand-account, terra-signals/snapshot, in-flight-workflows. Core `src/` caches a Prisma write can bust.
- W2 (PR 2, stops at PR). `bd-43aa7.8` resolve-terra-user (auth). `bd-43aa7.9` the three outside-API caches (Clerk, Render, Slack): ttl-caches.md says a TTL is legitimate there and the exemption is an owner decision, so this bead must ask through the Inbox.
- W3 (PR 3). `bd-43aa7.10` adds an invalidation helper to the mini-app PrismaClient (none exists). `bd-43aa7.11` and `.12` (book-carve) depend on it.


Each bead touches `oxlint-suppressions.json`. One bead at a time on one branch avoids the baseline-file conflicts the post-mortem names.

Policy for the test epic: `pr-only` during the spike. `thermo-merge` only after the owner reads the W1 PR (section 9, D1).
## 6. Spike experiments
Each runs in isolation before the runner MVP. Each ends in a pass/fail line in `spike/RESULTS.md`.

| id | Question | Method | Pass when |
|---|---|---|---|
| S1 | Does Claude Code log in from a herdr server started by pm2? | upgrade herdr (0.6.8 installed, protocol 12; firstmate needs 14), `pm2 start herdr -- server`, `herdr agent start --kind claude`, send a trivial prompt | prompt answered, no login screen |
| S2 | Does herdr report Claude state correctly? | in one pane force: process kill, a 10-min silent tool (`sleep 600`), a permission prompt (worker with default permission mode runs a non-allowlisted command) | kill → dead/exited event; sleep → `working` and our own output-hash check flags it; prompt → `blocked` |
| S3 | Can the runner recover each S2 case with no owner action? | runner ladder from 4.4 against the S2 cases | bead reaches `done` or `parked` with an Inbox message; never hangs |
| S4 | Does an Inbox reply wake the right worker? | two workers in two worktrees each send a question to their own thread; owner answers one | only that worker wakes; thread lands under the main repo project, not the worktree |
| S5 | Does context rotation hand over cleanly? | lower threshold to 40k on a real bead; let it rotate; also kill a worker before it drops and recover with `/baton grab <id>` | fresh session continues; repeated tool calls on already-done work under 5 |
| S6 | What does no-mistakes cost and do on terra? | `no-mistakes init` in a scratch worktree; one small branch; `axi run --yes --skip test` with `agent_crash_retries: 1`, `ci.rerun_transient: 2`; stop at checks green | PR opened, CI watched; tokens from `no-mistakes stats --agents` recorded |
| S7 | Do skills run under `claude -p` for the review gate? | `claude -p --model opus "/p:thermonuclear-code-quality-review <diff>"` with JSON output | skill loads, findings parse as JSON; else fall back to inlining the skill text |
| S8 | Does the `PostToolUse` hook inject context mid-turn? | hook returns `additionalContext` past a fake threshold | worker acts on it within its next step |
## 7. Phases
| Phase | Work | Exit |
|---|---|---|
| P0 | Install: herdr upgrade, no-mistakes, quota-axi (via bunx). Create `~/Documents/Development/tools/epic-runner` (bun). | tools run `--version` |
| P1 | Spikes S1, S2, S4, S6, S7, S8 (independent; run in parallel where possible) | `spike/RESULTS.md` rows filled |
| P2 | Runner MVP: state machine, status protocol, herdr driver, liveness ladder, rotation, wave gate via no-mistakes, gate ledger. Unit tests with a fake herdr and fake `br`. | `bun test` green; S3, S5 pass against the real runner |
| P3 | Create the test epic in terra beads. Run W1 with `pr-only`. | W1 PR open, CI green, owner reads it |
| P4 | Owner decision D1. Then W2 with `thermo-merge` (if approved), W3 forced stop-at-PR by downgrade. | epic closed or parked with reasons |
| P5 | Report: G1-G6 measured, cost per bead, failures seen and recovered, what to change. | report in Inbox |
## 8. Cost
- Supervisor: 0 tokens.
  
- Worker: one bead's work. Fresh session per bead, so context starts near 30k.
  
- Rotation: a few thousand tokens for the baton, plus one cold start on a small context.
  
- Judgment and review: fresh `claude -p` with a small bundle. A cold cache on 10-20k tokens.
  
- no-mistakes: measured in S6. The Test step is skipped (terra gates and CI cover tests).
  
- Budget for the whole spike plus test epic: to be set after S6. The runner logs tokens per bead from transcripts.
  
## 9. Decisions for the owner
- **D1. Merge authority on terra master.** A merge deploys to production. Recommendation: `pr-only` for W1; `thermo-merge` from W2 only after you read the W1 PR. W3 stops at PR by policy.
  
- **D2. Worker permission mode.** Options: `--permission-mode auto`, or `--dangerously-skip-permissions` inside each worktree. Recommendation: `auto` with the existing hooks (npm-guard, ps-guard) active; S2 tells us how often a prompt blocks a worker.
  

Everything else in this plan is reversible and proceeds without asking.
## 10. Evaluated and not adopted
- **firstmate.** Good ideas, taken here: event-driven watcher, append-only status lines, merge only at a checked head. Not adopted: LLM supervisor whose context grows, about 1 MB of bash, no automatic recovery for hung or rate-limited workers.
  
- **ntm + agent mail.** ntm's LLM controller has the same cost problem. Agent mail solves many agents in one checkout; one worktree per epic avoids that. ntm needs tmux; herdr has a typed socket API and Claude state detection.
  
- **treehouse.** `worktree-add-cow` already does this.
  
- **tasks-axi.** Beads is stronger.
  
- **gh-axi.** Low value; `gh` use is scripted.
  
- **p:swarm / ship-lite as the worker brief.** swarm fans out and reports; it does not deliver. ship-lite is a full plan-to-reflect pipeline inside one session, too heavy for a planned bead and exposed to the same subagent deaths.
  
## 11. Risks
- herdr is pre-1.0. Its state comes from screen detection, with open Claude Code bugs (#4626 spinner read as working; #5261 and #5547 wrong session ids on restore). Mitigation: our own liveness checks; herdr state is a hint.
  
- herdr #966: a server started by launchd or pm2 may lose Keychain access. S1 tests it. Fallback: start the herdr server once from a GUI terminal, and let pm2 run only the runner.
  
- no-mistakes ships pre-release builds near daily. Pin a version.
  
- `oxlint-suppressions.json` is a hotspot. One branch, serial beads.
  
- A review gate that is too noisy (thermo marks most diffs `major`) will stop every PR. Tune `passWhen` after W1.
