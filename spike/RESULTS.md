# Spike results

| id | result | evidence |
|---|---|---|
| S1 | PASS | herdr 0.9.5 server under pm2 (`pm2 start herdr --name herdr-epic -- --session epic server`). `herdr agent start s1 --kind claude` returned `agent_started` idle; prompt answered `S1-OK 96a276fa4` (matches worktree HEAD) in 11.5s. No login screen. Worker inherits pm2's environment: statusline shows `no sandbox`, `auto mode on`. Fresh terra session base context ~61k tokens (cache read 60.8k on first turn), not the 30k the plan assumed. |
| S2 blocked | PASS | Worker with `--permission-mode default` ran a non-allowlisted `touch`; `agent get` → `blocked` within 15s; pane shows the Bash approval dialog. Esc cancels → `idle`. |
| S2 stall | PASS (with our own check) | 150s foreground `bun -e 'await Bun.sleep(150000)'`: herdr `working` throughout; pane hash changes every read (spinner/timer), so pane-hash staleness is useless; transcript mtime age grew 26→116s and is the usable stall signal. |
| S2 kill | PASS | `kill -9` on the claude pid: within 3s pane shows `agent:null, agent_status:unknown`, agent name gone (`agent_not_found`). herdr keeps the Claude session id on the pane record (`agent_session.value`) until then. |
| S3 resume (lite) | PASS | `herdr agent start s2p --kind claude --pane w1:p2 -- --resume <id>` → idle with same session id; worker recalled the pre-crash command. |

## Findings that change the design

1. **Startup card swallows the first prompt.** In a folder with a prior session, Claude shows a "Last session in this folder · Continue from it / Dismiss" card. `agent prompt` typed the text but Enter did not submit; herdr returned `agent_prompt_stalled`. Fix: runner sends `esc` after `agent start`, and treats `agent_prompt_stalled` as "send esc, then enter" once before failing.
2. **A worker can end its turn with a question in the pane and no status line.** The foreground-sleep guard blocked a command; the worker asked "Tell me which one" and went `idle`. To the runner that is idle with no `done`/`needs-decision`. Fix: `idle` with no new status line = protocol violation → runner sends one nudge ("write a status line: done, needs-decision via Inbox, or failed") then escalates to a judgment call.
3. **Workers inherit pm2's unsandboxed environment** (statusline `no sandbox`) and the user's default `auto` permission mode. D2 must decide whether that is acceptable.
4. **Base context of a fresh terra session is ~61k tokens**, not 30k. Rotation at 300k still pays off, but cold start cost per bead is ~2x the plan's figure.
5. **Liveness signal = transcript mtime**, not pane hash. herdr state is still right for blocked / dead.
| S7 | PASS | `claude -p --model opus --output-format json --json-schema <findings schema> "/p:thermonuclear-code-quality-review <commit>"` exit 0 in 40s, 7 turns. `skill_loaded: true`; 4 schema-valid findings (1 minor, 3 nit) on b7afc7b12. Cost $0.54 (cache read 369k, cache write 81k, output 3.2k). The slash form works headless, so no skill-text inlining needed. |
| S8 | PASS | `--settings` with a `PostToolUse` (matcher Bash) hook printing `hookSpecificOutput.additionalContext`; haiku worker answered with the injected `ROTATE-ACK` after one tool call. The rotation trigger works mid-turn. |
| S4 | PASS | Two interactive workers (s1 sonnet, s2p haiku) each sent an Inbox question with `thread: epic-spike/s4-{a,b}` and `project_path: <terra root>`. Both threads landed under project terra, not the worktree. The owner answered b only. The reply woke s2p alone (it arrived as a new turn and the worker acted on it); s1 stayed idle and never wrote its file. Note: s2p then hit a Bash approval because it had been resumed without `--permission-mode auto`; the runner must pass the same flags on every resume. |
| D2 sandbox | PASS | Owner chose auto + sandbox. Worker started with `--permission-mode auto --settings '{"sandbox":{"enabled":true}}'`: `touch` inside the worktree rc=0, `git status` rc=0; `touch ~/x` rc=1 and `touch /tmp/x` rc=1. Consequence: push, no-mistakes, `gh pr merge` stay in the runner process (unsandboxed under pm2); workers only edit, test and commit. Unverified yet: whether terra's test suites and `bun run check` pass inside the sandbox (first W1 bead will show). |

## Run 1 setup findings (2026-11-03)

6. **no-mistakes run worktrees have tracked files only** (no `node_modules`). Its `commands.prepare/lint/test` come only from a `.no-mistakes.yaml` on the trusted default branch (terra master); machine-local `repository_overrides.commands` can add lint/test checks but cannot add `prepare`. Decision: no-mistakes runs `--skip test,review,document,lint`, so it owns rebase, push, PR and CI repair only. The worker runs lint, typecheck and tests with real dependencies; the thermonuclear gate is the review.
7. **Runner worktree must come from `worktree-add-cow`** (first attempt used plain `git worktree add`: no deps). Fixed in 72620b3.
8. `no-mistakes init --skip-user-skill` in terra added remote `no-mistakes` → `~/.no-mistakes/repos/96219379d134.git`. Undo: `no-mistakes eject`.
