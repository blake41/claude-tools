# `active-path.ts` — rule provenance and divergences

`active-path.ts` is a standalone pre-filter: raw Claude Code JSONL transcript
lines in, active-path JSONL lines out (`filterActivePath(lines: string[]):
string[]`). It is meant to run in FRONT of the vendored claude-devtools
pipeline (`server/trace/index.ts`), which parses records in raw file order
and has no branch/DAG semantics of its own.

Source of truth studied: `daaain/claude-code-log`, specifically
`claude_code_log/dag.py` (1146 lines — the module handling `parentUuid`
trees), plus its test suite (`test/test_dag.py`, `test/test_dag_integration.py`,
`test/test_silent_skip.py`) and `claude_code_log/converter.py` /
`claude_code_log/models.py` for the `leafUuid` / `last-prompt` field
semantics. Cloned at `/tmp/claude-code-log` (depth-1, HEAD as of 2026-08-09).

This document maps each ported rule to its upstream source and to this
module's implementation, and calls out — with file:line — every place this
module's actual behavior differs from the task brief's initial hypothesis or
from upstream's own behavior, per "port rules, not code style; where upstream
differs, upstream wins, document it."

## Rule-by-rule mapping

### Rule #1 — real parentUuid DAG construction with cycle breaking

**Upstream:** `dag.py:189-282` (`build_dag`). Step 1 clears dangling
`parentUuid`s (`dag.py:206-238`); Step 2 breaks cycles before any children
are populated, using a memoized `acyclic` set so the whole pass is amortized
O(n) instead of O(n·depth) (`dag.py:240-267`, comment explicitly calls out
"minutes on 30k-entry sessions" as the cost of the naive approach); Step 3
builds `children_uuids` from the now-acyclic parent pointers
(`dag.py:269-282`).

**This module:** `buildNodes` (`active-path.ts:120-145`) clears dangling
parents (mirrors `dag.py:206-238`). `breakCycles` (`active-path.ts:156-178`)
is a direct structural port of the memoized cycle-breaking walk — same
`acyclic` memoization, same "clear the parentUuid of the first revisited
node" strategy. `buildChildrenMap` (`active-path.ts:180-189`) mirrors Step 3.

**Defense in depth beyond the port:** `walkAncestors`
(`active-path.ts:227-235`) and `collectSubtree` (`active-path.ts:246-253`)
each carry their OWN `visited`/`seen` guard, independent of `breakCycles`.
Discovered during mutation testing (see Evidence below): even with
`breakCycles` fully disabled, the "never hangs" test still passed, because
these two walks are self-guarding. `breakCycles` still matters — without it,
`isPlumbingSubtree` and the diagnostics' `cyclesBroken` count are affected —
but termination itself has two independent guards, not one.

### Rule #2 — leaf preference order

**Task brief hypothesis:** "an explicit `leafUuid` / `last-prompt` record
when present → that leaf; else the leaf of the LAST record in file order;
depth/timestamp only as final fallback."

**Investigation result: the `leafUuid` half of this hypothesis is wrong, and
upstream's own code proves it.** `leafUuid` is a field on
`SummaryTranscriptEntry` (`models.py:286-291`, `type: "summary"`) — a
compaction-summary record. Its `leafUuid` points at the tail of the segment
the summary just SUMMARIZED — i.e. content being compacted OUT of live
context, not the current active tip. Confirmed two ways:

1. `dag.py:119-127` (`build_message_index`) explicitly **excludes**
   `SummaryTranscriptEntry` from the DAG entirely ("Summary has no uuid, so
   it can't be in nodes" — `test_dag.py:513-529`,
   `TestSummaryEntriesSkipped`). Upstream never uses `leafUuid` to pick a
   walk target.
2. Conversation resumption after a compaction starts a **fresh DAG root**
   via a `compact_boundary` system entry
   (`dag.py:423-427`, `_EXPECTED_ROOT_SYSTEM_SUBTYPES`) — deliberately NOT
   chained from the summarized leaf. Walking backward from a `leafUuid`
   target would land in stale, already-summarized pre-compaction context,
   not the live tail.

`last-prompt` fares no better: `converter.py:97-118` (`SILENT_SKIP_TYPES`)
documents it as "Trailing marker written as the last line of a .jsonl" with
**zero DAG fields** — no `uuid`, no leaf pointer of any kind. It is
unconditionally dropped (`test_silent_skip.py:33-35`) and cannot serve as a
leaf marker.

**Divergence:** this module does not consult `leafUuid` or `last-prompt` for
leaf selection at all. `pickLeafUuid` (`active-path.ts:212-220`) uses only
"the last uuid-bearing record in file order" — Claude Code appends to the
transcript in write order, so whatever was written last is definitionally
the current tip, regardless of tree depth. This is also the fix for the
task's stated (and upstream-independent, but correct) complaint that
"deepest leaf is wrong — abandoned pre-rewind branches are often deeper":
this repo's own `strip.ts` `canonicalBranch` (lines 94-120) picks the leaf
by max-timestamp-then-depth, which is exactly the heuristic that mis-ranks a
deep abandoned branch above a shallow live one. `active-path.ts` never
compares depth as a positive signal for leaf selection.

A regression test proves the divergence is intentional, not an oversight:
`active-path.test.ts` — "a trailing compaction summary's leafUuid points at
stale pre-compaction content; the real later leaf still wins" constructs a
summary record whose `leafUuid` targets an early node, with real
post-compaction content written after it, and asserts the filter reaches the
later content rather than stopping at the `leafUuid` target.

The "depth/timestamp as final fallback" clause is preserved narrowly: if
`nodes.size > 0` but somehow no record resolves as a leaf (should not happen
given `pickLeafUuid`'s scan, kept as a defensive branch), `computeActivePath`
(`active-path.ts:373-441`) falls back to keeping every node rather than
guessing — favoring "don't drop real content" over inventing a depth-based
tiebreak upstream doesn't actually use for this purpose either.

### Rule #3 — compaction-replay detection

**Upstream:** `dag.py:837-844`, inside `_walk_session_with_forks`: when
same-session children of a fork point all share the **exact same
timestamp**, it's classified as a compaction replay, not a rewind — as
opposed to `dag.py:846-851`, where different timestamps mean a genuine fork.
Verified directly by `test_dag.py:1264-1287`
(`TestCompactionReplay.test_same_timestamp_children_not_forked`).

**Divergence (deliberate, documented):** upstream's *actual* behavior for a
replay group is to follow only the **first** child (by file order, since
Python's stable sort preserves insertion order for equal timestamps) and
silently drop the rest — `test_same_timestamp_children_not_forked` asserts
`tree.sessions["s1"].uuids == ["a", "sys", "r1"]`, i.e. `r2`/`r3` never
appear anywhere in the rendered output, not even as a separate branch line.

This module does **not** replicate that drop. `expandWithPlumbingAndReplays`
(`active-path.ts:299-352`) keeps **every** member of a same-timestamp
sibling group, plus each member's full subtree
(`active-path.test.ts` — "same-timestamp sibling group under a canonical
node is a replay, not a fork — all kept"). Rationale: this module's job is
narrower than upstream's full multi-branch renderer — "never drop real
content, only drop genuinely abandoned rewind branches" — and a replay is
by definition not abandoned; it's the harness re-emitting prior real
content. Silently dropping look-alike siblings is a much riskier heuristic
for a standalone pre-filter that doesn't have the rest of upstream's
surrounding machinery (multi-session tree, junction points, per-type
root-classification) to catch a misclassification. Mutation testing (see
Evidence) confirms this behavior is real, not accidental: disabling the
keep-all branch makes the test fail exactly as expected (`r1`/`r2` dropped).

### Rule #4 — tool-result-carrier exemption

**Upstream:** `_is_structural_subtree` (`dag.py:384-420`) and
`_stitch_tool_results` (`dag.py:519-612`). A `UserTranscriptEntry` whose
content is a tool_result carrying no independent text is treated as
pipeline plumbing: `_stitch_tool_results` Variant 1
(`dag.py:559-567`) linearizes a dead-end tool_result carrier alongside its
sibling continuation instead of treating it as a competing fork; Variant 2
(`dag.py:569-612`) handles the case where a specific tool_result carrier
continues the chain while its siblings (including other tool_result
carriers) are dead ends. In both variants the dead-end carriers are kept in
the output — never dropped as "abandoned."

**This module:** `isPlumbingSubtree` (`active-path.ts:262-278`) generalizes
the same intent for this module's simpler single-session, order-preserving
model: a sibling subtree consisting ENTIRELY of tool-result carriers
(`classify`, `active-path.ts:82-89`, via `hasOnlyToolResultContent`,
`active-path.ts:74-80`) and/or structural (non-user/non-assistant) entries
is kept whole via `collectSubtree`
(`active-path.ts:246-253`), even though it sits off the leaf's direct
ancestor chain. `expandWithPlumbingAndReplays` (`active-path.ts:299-352`)
applies this check to every off-canonical sibling of a canonical node.

`active-path.test.ts` — "a tool-result-only user record off the ancestor
chain is kept, not dropped as abandoned" is the direct test; its contrast
test ("a genuine (non-tool-result) sibling with real conversation is
dropped as an abandoned branch") proves the exemption is specific to
tool-result carriers, not a blanket "keep every sibling" rule. Mutation
testing confirms both directions (see Evidence).

**Scope note (simplification, not a divergence):** upstream's stitching
logic also *reorders* dead-end siblings to appear immediately before the
continuation (`dag.py:600-612`, `dead_ends + user_with_cont`), because
upstream is assembling a rendered, potentially multi-branch view. This
module never reorders — it only decides KEEP/DROP per line and always
outputs surviving lines in their **original file order**, since the
downstream consumer (the vendored `server/trace/index.ts` pipeline) already
parses in file order and gains nothing from reordering; reordering would in
fact work against its "in file order" assumption. This is a scope
simplification appropriate to the pre-filter's role, not an upstream
disagreement.

### Rule #5 — records without uuid/parentUuid pass through in place

**Upstream:** `converter.py:97-118` (`SILENT_SKIP_TYPES`) enumerates known
internal record types with no DAG fields (`last-prompt`,
`file-history-snapshot`, `permission-mode`, `mode`, `custom-title`,
`agent-name`, `agent-color`, `frame-link`) that are dropped without warning
during rendering — i.e. legacy/non-DAG types are tolerated, not treated as
errors. `dag.py:119-127` (`build_message_index`) independently confirms:
entries without a `uuid` (Summary, AiTitle, QueueOperation types) are
excluded from the DAG index, not fatal.

**This module:** `isRecordWithUuid` (`active-path.ts:70-72`) is the single
gate. `filterActivePath` (`active-path.ts:353-366`) always passes through
any record that fails this check, in its original line position — this
covers every `SILENT_SKIP_TYPES` case above plus any future non-DAG type
Claude Code introduces, since the gate is structural (has a real uuid?) not
an enumerated type allowlist.

**Extension beyond the brief:** malformed JSON lines (fail `JSON.parse`)
are treated the same way — passed through untouched
(`parseLines`, `active-path.ts:103-116`) — rather than dropped. Upstream
doesn't need this case (it operates on already-validated Pydantic models),
but a raw-text pre-filter can't assume every line parses. Dropping an
unparseable line would be a silent, unrecoverable data-loss path with no
upstream precedent either way; passing it through is the conservative
choice. Covered by `active-path.test.ts` — "a line that fails JSON.parse is
kept in place rather than dropped."

## Comparison with this repo's existing `canonicalBranch` (`strip.ts:76-136`)

| Behavior | `canonicalBranch` (existing) | `active-path.ts` (new) |
|---|---|---|
| Leaf selection | Max timestamp, ties broken by **depth** (`strip.ts:114`) | Last uuid-bearing record in **file order**; never uses depth as a signal |
| Cycle safety | Per-leaf-candidate `visited` set during depth scoring (`strip.ts:106-113`) + a second `visited` set on the root walk (`strip.ts:127-131`) — correct, but re-walks the chain for every leaf candidate | Single memoized `acyclic` pass (`breakCycles`) shared across all nodes — avoids the O(n·depth) cost `dag.py`'s own comment calls out |
| Compaction replays | Not distinguished from genuine forks — a same-timestamp replay sibling is just another branch that loses the leaf-selection race and gets dropped | Explicitly detected and unconditionally kept (rule #3) |
| Tool-result carriers off the chosen leaf's ancestry | Dropped like any other non-ancestor node — `canonicalBranch` only ever keeps the single root→leaf path, so a legitimate parallel tool_use's OTHER result (not on that one path) is silently lost | Explicitly exempted and kept (rule #4) |
| No-uuid records | Passed through (`strip.ts:78`, `withIds.length < 2` early return covers the all-legacy case; the final filter `!m.uuid \|\| canonical.has(m.uuid)` covers the mixed case) | Same guarantee (rule #5), plus malformed-JSON tolerance |

**Net effect:** `canonicalBranch` computes a single root→leaf PATH and
drops everything off it — which is correct for a simple linear session, but
silently discards legitimate parallel-tool-call siblings and misranks
replay-vs-abandoned branches by depth. `active-path.ts` computes the same
ancestor path as its baseline, then explicitly ADDS BACK plumbing and
replay siblings that `canonicalBranch` would have dropped. This module does
**not** replace `canonicalBranch` for the search index yet — that's a later
decision, per the task scope — it is a new, independent module.

## Evidence

- `bunx tsc --noEmit` — zero errors.
- `bun test server/` — 94 pass, 0 fail (74 pre-existing baseline + 12 new in
  `active-path.test.ts` + 8 added concurrently to `server/trace/index.test.ts`
  by another agent working on that file in parallel).
- Real-transcript sweep: 30 files from `~/.claude/projects/**/*.jsonl`,
  11,563 input lines → 10,581 output lines (8.5% dropped), zero throws,
  never empty for non-empty input. Logged by the "real transcript sweep"
  test in `active-path.test.ts`.
- Mutation verification (since most of this module was implemented
  holistically rather than one test driving one code change — see honesty
  note below): each of the four non-trivial rules was temporarily disabled
  and its dedicated test re-run to confirm it fails without the rule, then
  restored:
  - Leaf selection → deepest-wins: "rewind fork" test fails
    (expected `["a","b","real-1","real-2"]`, got the 5-deep abandoned
    branch instead).
  - `breakCycles` → no-op: the "cycle never hangs" test still passes
    (see the defense-in-depth note under Rule #1), but the "diagnostics
    record which uuid had its cycle broken" test fails
    (`cyclesBroken.length` 0 instead of >0).
  - Replay keep-all → disabled: "compaction-replay" test fails (`r1`/`r2`
    dropped, only `r3` survives).
  - Plumbing keep → disabled: "tool-result-carrier exemption" test fails
    (`carrierB` missing from output).

## Honesty note on TDD discipline

The very first test ("a fully linear session... passes through") was
written before any implementation existed and drove the initial skeleton
(genuine RED → GREEN: `Cannot find module './active-path'` → pass). Once
that skeleton existed, the remaining rules (cycle-breaking, replay-keep,
plumbing-keep, leaf selection) were implemented together as one coherent
algorithm rather than one test-at-a-time, because the rules are tightly
coupled in a single-pass DAG walk and half-implementing one without the
others produces an incoherent intermediate state. Every subsequent test was
therefore written and passed against an already-substantially-complete
implementation, **not** a genuine chronological RED. To compensate, every
rule with real behavioral bite was independently mutation-tested (disable
the rule, confirm the specific test fails, restore) as recorded above — this
is not a substitute for true TDD RED evidence, but it does prove the tests
are not tautological and each one is load-bearing against the implementation
it targets.
