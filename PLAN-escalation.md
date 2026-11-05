# Plan: escalate on disagreement, and runner fixes found in the first run

Status: draft for owner review, 2026-11-04. Companion to `PLAN.md`. Source of the findings: the first live run on epic `bd-43aa7` (terra).

## Principle

The epic encodes the rules. The worker follows them. The worker comes to the owner only when it disagrees with a rule, and then it brings the whole case: what the owner said, why this case differs, and what it proposes instead. The owner never gets a menu of options with no background.

The best-practice docs in the target repo are the single source for the rules. The brief points to them and never copies them.

## What went wrong in the first run

| Event | Cause | Cost |
|---|---|---|
| Bead `.8` asked "pick route 1, 2 or 3" for one file | The epic text said "route 2 needs the owner". The rule forced a question per file. | One owner question per file, with no background. |
| The owner skipped a question. The worker wrote `failed`. The runner halted the whole epic. | `worker.ts:141` parks the bead and `runner.ts:285` halts on any failed bead. A skip is not a failure. | The epic stopped on a decision the owner had deferred. |
| The herdr server died. Two failed ticks halted the runner (`runner.ts:47`). | The server ran outside pm2 and did not survive the session. | About 12 hours of idle time before anyone noticed. |
| Halt notices had no action block. | Fixed in `53f49b5`. | About 1 hour with no human action. |
| The worker's questions lacked background. | `brief.ts` item 6 asks for a recommendation but not for context. | The owner had to ask again before deciding. |

## Changes

### E1. Decide the rules before the epic starts
- The epic author (or the planning step) lists the owner decisions the beads will need. They go in one Inbox message with full context, before the first worker starts. The answers go in `decisions.md` before any bead runs.
- A bead that needs a decision not in `decisions.md` is a planning gap. The runner reports the gap and does not start that bead.
- First use: decisions D1 to D5 of `terra/plans/2026-11-04-001-process-state-rule-redesign-part-b.md`.

### E2. Escalation template in the worker brief (`src/brief.ts`)
Replace item 6 and 7 of the bead brief. A worker may ask only when it disagrees with a recorded rule or a bead instruction. The question has four parts, in this order:
1. **The rule.** Quote the instruction or the `decisions.md` entry, with its date.
2. **What I found.** The facts, with `file:line`.
3. **Why this case differs.** One short paragraph. Say what the rule assumed that is not true here.
4. **My proposal.** What I would do instead, what it costs, and what I will do if you do not answer (the default).

The brief names the target repo's doc by path. It does not restate the rule. Evidence is required: "I feel it is right" is not a reason. A question that is only a menu is rejected by the brief's own wording.

### E3. A skipped question is not a failure (`worker.ts`, `runner.ts`)
- Add a status line `deferred: <what is waiting>`. The worker writes it when a question is closed unanswered. The brief says so.
- A deferred bead parks that bead only. The runner continues independent beads. Dependents wait. The runner does not halt unless no bead can run.
- The runner re-sends the question once when the owner next answers any thread, and it lists deferred beads in its halt and status notices.

### E4. Recover from a dead herdr server (`herdr.ts`, `runner.ts`)
- On `server_not_running`, try to start the server (`herdr --session <name> server`, headless; it needs no terminal). Re-attach the worker panes. Halt only if the restart fails.
- Document that `herdr session attach` needs a terminal and cannot run from an agent shell.

### E5. Keep the herdr server alive across reboots
- Run `herdr --session epic server` under launchd or pm2. Check herdr issue #966 (Keychain access under launchd) first. The fallback is to start it once from a GUI terminal.

### E6. Early waves stop at the PR
- Epic policy for the first live runs: `onPass: stop_at_pr` for every wave. Move a wave to `merge` only after one verified live fix round of the review gate. The review gate (`585c9b0`) has only been tested against fakes.

## Order and verification

1. E3 first. It caused the second halt and is the smallest. Test with the fake world: a deferred bead parks, an independent bead runs, the epic does not halt.
2. E2. Test by a brief snapshot test. Then try it live on one real bead.
3. E4, then E5.
4. E1 is a process change. First use is Part B.
5. E6 is a policy file change.

Verify with `bun test` and `bunx tsc --noEmit -p tsconfig.json` in this repo. Then one live run with a small epic.

## Open questions

- Should a deferred question be re-sent by the runner on a timer, or only when the owner is active? Lean: only when the owner is active. A timer produces noise.
- Where should the "target repo doc" pointer live? Lean: a field in the epic policy file (`docsRef`), so the brief stays generic.
- Does E1 belong in the runner or in the planning skill? Lean: the planning skill, with the runner enforcing the gap check.
