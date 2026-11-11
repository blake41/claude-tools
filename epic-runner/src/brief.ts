import type { Finding } from './types.ts'

export type BriefParams = {
  beadId: string
  epicId: string
  branch: string
  repoRoot: string
  worktree: string
  statusFile: string
  inboxThread: string
  beadText: string
  epicText: string
}

function protocol(p: Pick<BriefParams, 'statusFile' | 'inboxThread' | 'repoRoot'>): string {
  return `## Status protocol

Append exactly one line per event to \`${p.statusFile}\` (create it if missing; never commit it):

- \`working: <one line>\` when you start a major step (optional).
- \`needs-decision thread=${p.inboxThread}: <question in one line>\` after you send a needs-user question to the Plannotator Inbox. Then end your turn.
- \`rotate baton=<path>\` after \`/baton drop\` when the runner asks you to rotate. Then end your turn.
- \`done sha=<commit sha>\` when the work is committed and \`git status\` is clean. Then end your turn.
- \`deferred: <what is waiting>\` when the owner closed your question unanswered. Then end your turn.
- \`failed: <reason>\` when you cannot finish. Then end your turn.

The runner reads only this file, git and exit codes. It does not read your prose. Ending a turn with no new status line is a protocol violation.

## Limits

- Your sandbox lets you write only inside this worktree. Do not push, open PRs, run no-mistakes or merge: the runner does that.
- Questions go to the Plannotator Inbox with \`thread: "${p.inboxThread}"\` and \`project_path: "${p.repoRoot}"\`. Never ask in the terminal.
`
}

export function beadBrief(p: BriefParams): string {
  const decisions = p.statusFile.replace(/status$/, 'decisions.md')
  return `# Bead ${p.beadId} (epic ${p.epicId})

You work on the epic branch \`${p.branch}\` in the worktree \`${p.worktree}\`. One bead, start to finish.

1. Read the bead and the epic below, and any baton in \`.baton/\`. The runner read them with \`br\`; do not run \`br\` yourself (the sandbox blocks its write lock in the main checkout).
2. Implement with tests (implementer method: RED then GREEN where testable).
3. Run the scope gates from CLAUDE.md for touched paths. Run \`bun run lint:suppressions:prune\` when a baselined site is fixed.
4. Commit on \`${p.branch}\`. One bead = one commit (or a few).
5. Write \`done sha=<sha>\`. End the turn.
6. The rules are already recorded. They live in this bead, this epic, \`${decisions}\` (owner decisions earlier beads of this epic got; it may not exist yet) and the target repo docs that the epic text names by path, plus \`CLAUDE.md\` in the worktree. Read them before you decide anything. Follow them. Apply a recorded decision only when the owner's own words in it cover your case; an approval for one file never covers another file. When nothing recorded covers a choice, decide it yourself and log it under \`REVIEW-THESE\` in the commit body. Do not ask.
7. Ask only when you disagree with a recorded rule or a bead instruction, and only with evidence. "I feel it is right" is not a reason. Send the question to the Plannotator Inbox with \`thread: "${p.inboxThread}"\` and \`project_path: "${p.repoRoot}"\`, write \`needs-decision\`, end the turn. The question has exactly these four parts, in this order:
   1. **The rule.** Quote the instruction or the \`decisions.md\` entry, with its date. Quote it; do not paraphrase it.
   2. **What I found.** The facts, each with \`file:line\`.
   3. **Why this case differs.** One short paragraph. Say what the rule assumed that is not true here.
   4. **My proposal.** What you would do instead, what it costs, and what you will do if the owner does not answer (the default).
   A question that is only a menu ("pick option 1, 2 or 3") is rejected: do not send it. Do not restate the rule's content from the target repo docs; name the doc by path and quote only the line you disagree with. When the owner's answer arrives, append one entry to the decisions file before you continue: the date, this bead, the question in one line, and the answer with exactly the scope the owner gave (never wider). If the owner closes your question unanswered, write \`deferred: <what is waiting>\` and end the turn. Do not write \`failed\`. A skipped question is not a failure.
8. Never restructure code only so a lint rule stops matching it (a wrapper class, a renamed variable, moving a write into a sync helper). That is lint evasion. If you think a site is truly exempt, that is a disagreement with a rule: ask with the four parts above.
${protocol(p)}

## Bead ${p.beadId}

${p.beadText.trim()}

## Epic ${p.epicId}

${p.epicText.trim()}
`
}

export function fixBrief(p: Omit<BriefParams, 'beadText' | 'epicText'> & { pr: number; round: number; findings: Finding[] }): string {
  const list = p.findings.map((f) => `- [${f.severity}] ${f.file}:${f.line} ${f.summary}`).join('\n')
  return `# Review fixes for PR #${p.pr}, round ${p.round} (epic ${p.epicId})

The merge-gate review failed on the epic branch \`${p.branch}\` in \`${p.worktree}\`. Fix every finding at major or above; fix lower ones when cheap.

${list}

1. Read each finding against the code. If a finding is wrong, say why in the commit body under \`REVIEW-THESE\`.
2. Fix with tests where testable. Run the scope gates from CLAUDE.md for touched paths.
3. Commit on \`${p.branch}\` on top of the existing commits. Never rewrite or drop earlier commits.
4. Write \`done sha=<sha>\`. End the turn.
5. Never restructure code only so a lint rule stops matching it. That is lint evasion. For a finding that needs an owner decision (an exemption, keeping a site baselined), ask in the Plannotator Inbox and write \`needs-decision\`.

${protocol(p)}`
}

export const RESTART_PROMPT = (statusFile: string, brief: string) =>
  `You were restarted by epic-runner. Re-read ${statusFile}, run git status and git log, then continue the brief at ${brief}.`

export const PROTOCOL_NUDGE = (statusFile: string) =>
  `epic-runner: you ended your turn without a status line. Append one line to ${statusFile}: done sha=<sha>, needs-decision thread=<thread>: <question> (after sending it via the Plannotator Inbox), or failed: <reason>. Then end your turn.`

export const ROTATE_DROP_PROMPT = (statusFile: string) =>
  `epic-runner: your context is over the rotation limit. Stop the current step. Commit WIP on the epic branch, run /baton drop, append \`rotate baton=<path>\` to ${statusFile}, and end your turn.`

export const DONE_REJECTED_PROMPT = (statusFile: string, reason: string) =>
  `epic-runner rejected your done line: ${reason}. Fix it (commit on the epic branch, leave the tree clean), then append a new status line to ${statusFile}.`

export const grabPrompt = (brief: string, fromSession?: string) =>
  `/baton grab${fromSession ? ` ${fromSession}` : ''}\n\nAfter grabbing, follow the brief at ${brief}.`
