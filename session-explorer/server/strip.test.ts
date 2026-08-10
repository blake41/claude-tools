import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";
import { stripSession } from "./strip";

// Regression coverage for the marker-based isSkillInjection/isSystemContext
// rewrite. The previous heuristic classified purely by length + markdown
// header count (>2000 chars + >5 headers -> skill; >1500 chars + >3 headers
// -> system), which destroyed genuine user-pasted markdown (plans, design
// docs) that happened to be long and well-structured. Classification must
// now require a real harness marker (e.g. "Base directory for this skill:",
// "<system-reminder>") — content without one passes through untouched no
// matter how long or header-heavy it is.

// Fixtures use 2 uuid'd records to exercise canonicalBranch's normal walk,
// matching the shape of real transcripts. (canonicalBranch's early-return
// paths return the input array itself; the [...spread] copy at the call
// site in stripSession decouples it before the caller's
// `msgs.length = 0; msgs.push(...canonical)` reassignment, so single- and
// zero-uuid fixtures also survive.)
function writeFixtureSession(userText: string): string {
  const dir = mkdtempSync(join(tmpdir(), "strip-test-"));
  const path = join(dir, "session.jsonl");
  const lines = [
    {
      type: "user",
      sessionId: "test-session",
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: "/tmp/fixture-project",
      gitBranch: "main",
      uuid: "root-uuid",
      message: { role: "user", content: "hi" },
    },
    {
      type: "user",
      sessionId: "test-session",
      timestamp: "2026-01-01T00:00:01.000Z",
      cwd: "/tmp/fixture-project",
      gitBranch: "main",
      uuid: "leaf-uuid",
      parentUuid: "root-uuid",
      message: { role: "user", content: userText },
    },
  ];
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return path;
}

describe("strip.ts skill/system classification (marker-based, not size-based)", () => {
  test("(a) pasted markdown plan with many headers is preserved verbatim", () => {
    // Real user-authored content from this repo: plans/2026-08-09-arch-review-and-parser-panel.md
    // 10,953 chars, 11 markdown headers — exactly the shape (>2000 chars,
    // >5 headers) that tripped the old isSkillInjection heuristic and got
    // it destructively replaced with "[Skill loaded: ...]". It carries none
    // of the real harness markers (no "Base directory for this skill:", no
    // "<system-reminder>"), so it must pass through untouched.
    const planPath = fileURLToPath(
      new URL("../plans/2026-08-09-arch-review-and-parser-panel.md", import.meta.url),
    );
    const planText = readFileSync(planPath, "utf-8");
    expect(planText.length).toBeGreaterThan(2000);
    expect((planText.match(/^#{1,4}\s/gm) || []).length).toBeGreaterThan(5);

    const sessionPath = writeFixtureSession(planText);
    const { messages } = stripSession(sessionPath);

    expect(messages).toHaveLength(2);
    expect(messages[1].messageType).toBe("text");
    // Exact equality is the strong check here: the plan's own prose (item 8)
    // literally quotes "[Skill loaded: ...]" as an example of the bug it's
    // documenting, so a substring check for that phrase would false-fail —
    // proving byte-for-byte preservation is what actually matters.
    expect(messages[1].content).toBe(planText.trim());
  });

  test("(b) real skill-injection sample is still truncated to '[Skill loaded: ...]'", () => {
    // Real excerpt captured from an actual Claude Code transcript where the
    // `cass` skill was auto-loaded (description-triggered, no <command-name>
    // wrapper):
    // ~/.claude/projects/-Users-blake--claude--claude-worktrees-parallelism-overhaul/158708a4-d832-43cc-ae4a-1ad34dd15bb4.jsonl
    // Verbatim first ~2KB of that 27,567-char user-turn text block.
    const skillSample = `Base directory for this skill: /Users/blake/.claude/skills/cass

# cass Session Search

## Table of Contents

- [The Goldmine Principle](#the-goldmine-principle)
- [THE EXACT PROMPT — Discovery Workflow](#the-exact-prompt--discovery-workflow)
- [Version Pinning Caveat](#version-pinning-caveat)
- [Two-Step Bootstrap (Replaces "ALWAYS first")](#two-step-bootstrap-replaces-always-first)
- [Stuck-Index & Recovery Decision Tree](#stuck-index--recovery-decision-tree)
- [Quick Reference](#quick-reference)
- [When to Use What](#when-to-use-what)
- [Critical Rules](#critical-rules)
- [Agent Harness Exclusion](#agent-harness-exclusion)
- [Search Modes](#search-modes)
- [Cross-Machine Search (Multi-Workstation Corpus)](#cross-machine-search-multi-workstation-corpus)
- [Anti-Patterns (Don't Do These)](#anti-patterns-dont-do-these)
- [Resume a Past Session in Its Native Harness](#resume-a-past-session-in-its-native-harness)
- [The Heuristics](#the-heuristics)
- [jq Essentials](#jq-essentials)
- [Hidden Power: Capabilities the Old Skill Missed](#hidden-power-capabilities-the-old-skill-missed)
- [Token & Cost Analytics (Bonus Use Case)](#token--cost-analytics-bonus-use-case)
- [Recovery Cheat Sheet (No-Permission Moves)](#recovery-cheat-sheet-no-permission-moves)
- [Reference Index](#reference-index)
- [Quick Search (Grep Recipes for References)](#quick-search-grep-recipes-for-references)
- [Scripts](#scripts)
- [Validation](#validation)

> **Core Insight:** Your repeated prompts are your best prompts. If you typed it 10+ times, it works. Mine your history.

## The Goldmine Principle

Your conversation history contains:
- **Refined prompts** — Every rephrase that worked better was captured
- **Working rituals** — Prompts repeated 10+ times ARE your methodology
- **Scope decisions** — "When did we decide NOT to do X?"
- **Recovery moments** — What you searched for after context loss = what mattered

**The insight:** Mining your past beats inventing new approaches.`;

    expect(skillSample).toContain("Base directory for this skill:");
    expect(skillSample.length).toBeGreaterThan(500);

    const sessionPath = writeFixtureSession(skillSample);
    const { messages } = stripSession(sessionPath);

    expect(messages).toHaveLength(2);
    expect(messages[1].messageType).toBe("system");
    expect(messages[1].content).toStartWith("[Skill loaded:");
    expect(messages[1].content.length).toBeLessThan(skillSample.length);
  });

  test("(c) system-reminder-style injected context is still truncated", () => {
    // Real structure observed live in-session and confirmed on disk for the
    // short form (e.g. `~/.claude/projects/.../a4cc76d7-*.jsonl`: a
    // 123-char "<system-reminder>The user named this session ...</system-reminder>").
    // This fixture reproduces the same wrapper/content shape at the size a
    // CLAUDE.md dump reaches in practice (>500 chars), so it exercises the
    // truncation path rather than the short-content passthrough floor.
    const reminderSample = `<system-reminder>
As you answer the user's questions, you can use the following context:
# claudeMd
Codebase and user instructions are shown below. Be sure to adhere to these
instructions. IMPORTANT: These instructions OVERRIDE any default behavior
and you MUST follow them exactly as written.

Contents of /Users/blake/.claude/CLAUDE.md (user's private global instructions for all projects):

# Global Guidelines

Rules are organized in \`~/.claude/rules/\`:

- **permissions.md** — Stop on permissions errors, never work around them
- **bun.md** — Always bun, never npm/npx
- **cli-tools.md** — Skill-based CLI tools
- **plan-mode.md** — Structured review process for plan mode
- **cost-aware-routing.md** — The session router
- **post-pipeline-review.md** — After /ship or /ship-lite completes
- **papercuts.md** — Log small in-the-moment frictions
</system-reminder>`;

    expect(reminderSample).toContain("<system-reminder>");
    expect(reminderSample).toContain("# claudeMd");
    expect(reminderSample.length).toBeGreaterThan(500);

    const sessionPath = writeFixtureSession(reminderSample);
    const { messages } = stripSession(sessionPath);

    expect(messages).toHaveLength(2);
    expect(messages[1].messageType).toBe("system");
    // Truncated to a single short line — not the full multi-hundred-char dump.
    expect(messages[1].content.length).toBeLessThan(100);
    expect(messages[1].content).not.toContain("Global Guidelines");
  });

  test("short marked content (below the truncation-worth-it floor) is dropped as noise, not turned into a visible stub", () => {
    // The 123-char real "session named" reminder, verbatim from
    // ~/.claude/projects/.../a4cc76d7-*.jsonl. Below the truncation-worth-it
    // floor, isSystemContext() is false, so this falls to the plain-text
    // branch where stripXmlNoise's full-block-removal regex deletes the
    // complete "<system-reminder>...</system-reminder>" pair outright —
    // pre-existing, correct behavior (this carries no real conversational
    // content). Confirmed by direct measurement: WITHOUT the floor,
    // isSystemContext would fire, truncateSystemContext would strip the
    // closing tag in the process (only the opening tag survives to become
    // the "first line"), and the orphan-tag pass in stripXmlNoise would
    // then leave a meaningless "[system context truncated]" stub visible
    // instead of correctly dropping the message — a regression the floor
    // exists specifically to prevent.
    const shortReminder = `<system-reminder>\nThe user named this session "osman-sync". This may indicate the session's focus or intent.\n</system-reminder>`;

    const sessionPath = writeFixtureSession(shortReminder);
    const { messages } = stripSession(sessionPath);

    // Only the leading "hi" message survives; the reminder text produced no
    // pushable content and was correctly omitted, not corrupted.
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("hi");
  });

  test("long user prose QUOTING a marker mid-message is preserved verbatim", () => {
    // False-positive boundary: this user routinely discusses Claude Code
    // internals, so genuine messages can contain the literal strings
    // "<system-reminder>" or "# claudeMd" deep in the prose. Harness
    // injections always lead with their marker; classification only looks
    // at the first MARKER_HEAD_WINDOW chars, so a quote past the head must
    // not trigger destructive truncation.
    const filler =
      "Here is my analysis of how the session-explorer strip pipeline handles injected context. ".repeat(8);
    const quotingProse =
      filler +
      "\n\nNotably, the harness wraps reminders in a <system-reminder> tag, " +
      "and CLAUDE.md dumps start with a # claudeMd heading — " +
      "(user's private global instructions for all projects) is the exact " +
      "attribution phrase. We should handle all of these in the parser.\n\n" +
      filler;
    expect(quotingProse.length).toBeGreaterThan(500);
    expect(quotingProse.indexOf("<system-reminder>")).toBeGreaterThan(500);

    const sessionPath = writeFixtureSession(quotingProse);
    const { messages } = stripSession(sessionPath);

    expect(messages).toHaveLength(2);
    expect(messages[1].messageType).toBe("text");
    // The quoted "<system-reminder>" literal itself is removed by
    // stripXmlNoise's orphan-tag pass (pre-existing, acceptable), but the
    // surrounding prose must survive — not be truncated to a one-line stub.
    expect(messages[1].content).toContain("# claudeMd heading");
    expect(messages[1].content).toContain("exact attribution phrase");
    expect(messages[1].content.length).toBeGreaterThan(1000);
    expect(messages[1].content).not.toStartWith("[");
  });
});

// canonicalBranch regression coverage: ported from server/trace/active-path.ts's
// isAbandonedBranch, which fixed the identical bug in the trace pipeline —
// the old "keep only the single leaf's ancestor chain" rule silently dropped
// completed parallel-Task-dispatch content as if it were an abandoned rewind
// branch. A divergent sibling subtree is now dropped ONLY if it contains a
// real human re-prompt; anything else (tool-result plumbing, parallel
// dispatch chains) is kept.
function writeRawFixture(lines: Record<string, unknown>[]): string {
  const dir = mkdtempSync(join(tmpdir(), "strip-canonical-test-"));
  const path = join(dir, "session.jsonl");
  const withDefaults = lines.map((l) => ({
    sessionId: "test-session",
    cwd: "/tmp/fixture-project",
    gitBranch: "main",
    ...l,
  }));
  writeFileSync(path, withDefaults.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return path;
}

describe("strip.ts canonicalBranch (parallel-dispatch + abandoned-rewind handling)", () => {
  test("parallel Task-dispatch sibling is kept, not dropped as an abandoned branch", () => {
    const sessionPath = writeRawFixture([
      {
        type: "user", uuid: "U0", timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: "hi, please do two things in parallel for this fixture test" },
      },
      {
        type: "assistant", uuid: "A1", parentUuid: "U0", timestamp: "2026-01-01T00:00:01.000Z",
        message: { role: "assistant", content: [
          { type: "tool_use", id: "tu1", name: "Task", input: { description: "first dispatch" } },
          { type: "tool_use", id: "tu2", name: "Task", input: { description: "second dispatch" } },
        ] },
      },
      {
        type: "user", uuid: "T1", parentUuid: "A1", timestamp: "2026-01-01T00:00:02.000Z",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "first subagent result" }] },
      },
      {
        type: "user", uuid: "T2", parentUuid: "A1", timestamp: "2026-01-01T00:00:02.000Z",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu2", content: "second subagent result" }] },
      },
      {
        // Leaf: latest timestamp, continues from T1.
        type: "assistant", uuid: "A2", parentUuid: "T1", timestamp: "2026-01-01T00:00:04.000Z",
        message: { role: "assistant", content: "Final response summarizing the first subagent's output, padded well past the one-hundred-character filter floor." },
      },
      {
        // Sibling dead-end off T2 — structurally off the leaf's ancestor
        // chain, but pure machine work (no human re-prompt in its subtree).
        type: "assistant", uuid: "A3", parentUuid: "T2", timestamp: "2026-01-01T00:00:03.000Z",
        message: { role: "assistant", content: "Second subagent also finished, and this is a summary of its own dedicated results for verification purposes." },
      },
    ]);

    const { messages } = stripSession(sessionPath);
    const allText = messages.map((m) => m.content).join("\n");

    expect(allText).toContain("Final response summarizing the first subagent");
    expect(allText).toContain("Second subagent also finished");
    expect(allText).toContain("first subagent result");
    expect(allText).toContain("second subagent result");
  });

  test("a sibling branch containing a genuine human re-prompt is dropped as abandoned", () => {
    const sessionPath = writeRawFixture([
      {
        type: "user", uuid: "U0", timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: "original human prompt for the very first turn in this fixture, needs real content" },
      },
      {
        type: "assistant", uuid: "A1", parentUuid: "U0", timestamp: "2026-01-01T00:00:01.000Z",
        message: { role: "assistant", content: "First assistant reply to the original prompt, padded well past the one-hundred-character filter floor for this fixture." },
      },
      {
        // Abandoned rewind fork: a real human re-prompt off A1.
        type: "user", uuid: "U_OLD", parentUuid: "A1", timestamp: "2026-01-01T00:00:02.000Z",
        message: { role: "user", content: "human decided to rewrite the request and tried an old alternate approach for this test" },
      },
      {
        type: "assistant", uuid: "A_OLD", parentUuid: "U_OLD", timestamp: "2026-01-01T00:00:03.000Z",
        message: { role: "assistant", content: "Assistant reply to the old abandoned rewind branch, should not appear in the final output after filtering." },
      },
      {
        // The branch that actually got carried forward (latest timestamp).
        type: "user", uuid: "U_NEW", parentUuid: "A1", timestamp: "2026-01-01T00:00:04.000Z",
        message: { role: "user", content: "human retried again with a new final request that supersedes the old rewind attempt for real" },
      },
      {
        type: "assistant", uuid: "A_NEW", parentUuid: "U_NEW", timestamp: "2026-01-01T00:00:05.000Z",
        message: { role: "assistant", content: "Assistant reply to the new final request, the one that should survive as the active canonical leaf branch." },
      },
    ]);

    const { messages } = stripSession(sessionPath);
    const allText = messages.map((m) => m.content).join("\n");

    expect(allText).toContain("new final request");
    expect(allText).toContain("should survive as the active canonical leaf");
    expect(allText).not.toContain("old alternate approach");
    expect(allText).not.toContain("abandoned rewind branch");
  });
});
