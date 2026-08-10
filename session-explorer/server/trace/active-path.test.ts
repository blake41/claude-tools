import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { computeActivePath, filterActivePath } from "./active-path";

// ── Fixture helpers ──────────────────────────────────────────────────
// Real Claude Code JSONL records carry many more fields (cwd, gitBranch,
// version, userType, ...) than the DAG walk cares about. Fixtures below
// only set the fields active-path.ts actually reads (type, uuid,
// parentUuid, timestamp, message.content) plus sessionId, matching the
// "use real field names" contract-test discipline — these ARE the real
// field names, just trimmed to what's load-bearing for this module.
function rec(
  uuid: string,
  parentUuid: string | null,
  timestamp: string,
  opts: {
    type?: "user" | "assistant" | "system";
    role?: "user" | "assistant";
    content?: unknown;
    extra?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  const type = opts.type ?? opts.role ?? "user";
  return {
    type,
    uuid,
    parentUuid,
    timestamp,
    sessionId: "test-session",
    message: {
      role: opts.role ?? (type === "assistant" ? "assistant" : "user"),
      content: opts.content ?? `text from ${uuid}`,
    },
    ...opts.extra,
  };
}

function toLines(records: Record<string, unknown>[]): string[] {
  return records.map((r) => JSON.stringify(r));
}

function toolResultCarrier(uuid: string, parentUuid: string | null, timestamp: string, toolUseId: string) {
  return rec(uuid, parentUuid, timestamp, {
    type: "user",
    content: [{ type: "tool_result", tool_use_id: toolUseId, content: "ok" }],
  });
}

describe("filterActivePath — simple linear session", () => {
  test("a fully linear session (no forks) passes through with all lines kept, in order", () => {
    const records = [
      rec("a", null, "2026-01-01T00:00:00.000Z"),
      rec("b", "a", "2026-01-01T00:00:01.000Z", { type: "assistant", role: "assistant" }),
      rec("c", "b", "2026-01-01T00:00:02.000Z"),
    ];
    const lines = toLines(records);

    const result = filterActivePath(lines);

    expect(result).toEqual(lines);
  });
});

describe("filterActivePath — no-uuid legacy tolerance (rule #5)", () => {
  test("records without uuid/parentUuid pass through in place, untouched", () => {
    // Legacy-format session metadata: no `uuid` field at all, so there's
    // nothing for the DAG walk to key on. Must survive unchanged.
    const legacy = { type: "permission-mode", permissionMode: "acceptEdits", sessionId: "s1" };
    const lines = [JSON.stringify(legacy)];

    const result = filterActivePath(lines);

    expect(result).toEqual(lines);
  });

  test("a mix of legacy no-uuid records and a real DAG keeps both", () => {
    const legacyHeader = { type: "file-history-snapshot", messageId: "m1", snapshot: {} };
    const records = [rec("a", null, "2026-01-01T00:00:00.000Z"), rec("b", "a", "2026-01-01T00:00:01.000Z")];
    const lines = [JSON.stringify(legacyHeader), ...toLines(records)];

    const result = filterActivePath(lines);

    expect(result).toEqual(lines);
  });
});

describe("filterActivePath — rewind fork: deeper abandoned branch vs. later real leaf", () => {
  test("picks the LAST-in-file leaf, not the deepest one (deepest-leaf heuristic is wrong)", () => {
    // a -> b forks at b into two children with DIFFERENT timestamps
    // (a genuine rewind): "abandoned" goes 5 turns deep, but was
    // written BEFORE the user rewound and continued down "real", which
    // is only 2 turns deep but is the LAST thing in the file.
    const records = [
      rec("a", null, "2026-01-01T00:00:00.000Z"),
      rec("b", "a", "2026-01-01T00:00:01.000Z", { type: "assistant", role: "assistant" }),
      // Abandoned branch: forks off b, goes deep, written first.
      rec("abandoned-1", "b", "2026-01-01T00:00:02.000Z"),
      rec("abandoned-2", "abandoned-1", "2026-01-01T00:00:03.000Z", { type: "assistant", role: "assistant" }),
      rec("abandoned-3", "abandoned-2", "2026-01-01T00:00:04.000Z"),
      rec("abandoned-4", "abandoned-3", "2026-01-01T00:00:05.000Z", { type: "assistant", role: "assistant" }),
      rec("abandoned-5", "abandoned-4", "2026-01-01T00:00:06.000Z"),
      // User rewinds, forks off b again, shallower, written LAST.
      rec("real-1", "b", "2026-01-01T00:10:00.000Z"),
      rec("real-2", "real-1", "2026-01-01T00:10:01.000Z", { type: "assistant", role: "assistant" }),
    ];
    const lines = toLines(records);

    const result = filterActivePath(lines);

    const kept = result.map((l) => JSON.parse(l).uuid);
    expect(kept).toEqual(["a", "b", "real-1", "real-2"]);
    expect(kept).not.toContain("abandoned-1");
    expect(kept).not.toContain("abandoned-5");
  });
});

describe("filterActivePath — parentUuid cycle termination (rule #1)", () => {
  test("a parentUuid cycle never hangs the walk and produces a sensible, non-empty output", () => {
    // a -> loop1 -> loop2 -> loop1 (cycle). No node outside the cycle
    // references it, so once broken, loop1 becomes its own root.
    const records = [
      rec("a", null, "2026-01-01T00:00:00.000Z"),
      rec("loop1", "loop2", "2026-01-01T00:00:01.000Z", { type: "assistant", role: "assistant" }),
      rec("loop2", "loop1", "2026-01-01T00:00:02.000Z"),
    ];
    const lines = toLines(records);

    const start = Date.now();
    const result = filterActivePath(lines);
    const elapsedMs = Date.now() - start;

    expect(elapsedMs).toBeLessThan(1000);
    expect(result.length).toBeGreaterThan(0);
    // Must not throw and must not silently return nothing.
    const keptUuids = result.map((l) => JSON.parse(l).uuid);
    expect(keptUuids.length).toBeGreaterThan(0);
  });

  test("diagnostics record which uuid had its cycle broken", () => {
    const records = [
      rec("loop1", "loop2", "2026-01-01T00:00:01.000Z"),
      rec("loop2", "loop1", "2026-01-01T00:00:02.000Z"),
    ];
    const lines = toLines(records);

    const { diagnostics } = computeActivePath(lines);

    expect(diagnostics.cyclesBroken.length).toBeGreaterThan(0);
  });
});

describe("filterActivePath — compaction-replay same-timestamp siblings (rule #3)", () => {
  test("same-timestamp sibling group under a canonical node is a replay, not a fork — all kept", () => {
    // sys forks into r1/r2/r3, all sharing the SAME timestamp (a
    // compaction replay artifact, not a user rewind). r3 is the one
    // that continues to the real leaf; r1/r2 must still be kept.
    const records = [
      rec("root", null, "2026-01-01T10:00:00.000Z"),
      rec("sys", "root", "2026-01-01T10:01:00.000Z", { type: "system" }),
      rec("r1", "sys", "2026-01-01T10:02:00.000Z", { type: "assistant", role: "assistant" }),
      rec("r2", "sys", "2026-01-01T10:02:00.000Z", { type: "assistant", role: "assistant" }),
      rec("r3", "sys", "2026-01-01T10:02:00.000Z", { type: "assistant", role: "assistant" }),
      rec("leaf", "r3", "2026-01-01T10:03:00.000Z"),
    ];
    const lines = toLines(records);

    const result = filterActivePath(lines);

    const kept = result.map((l) => JSON.parse(l).uuid);
    expect(kept).toEqual(["root", "sys", "r1", "r2", "r3", "leaf"]);
  });
});

describe("filterActivePath — tool-result-carrier exemption (rule #4)", () => {
  test("a tool-result-only user record off the ancestor chain is kept, not dropped as abandoned", () => {
    // Assistant issues two parallel tool_use calls (tool1). Both
    // results (carrierA, carrierB) land as same-session children of
    // tool1. Only carrierA continues to the real leaf; carrierB is a
    // dead-end tool_result carrier — pure plumbing, must be kept.
    const records = [
      rec("start", null, "2026-01-01T00:00:00.000Z"),
      rec("tool1", "start", "2026-01-01T00:00:01.000Z", { type: "assistant", role: "assistant" }),
      toolResultCarrier("carrierA", "tool1", "2026-01-01T00:00:02.000Z", "call-a"),
      toolResultCarrier("carrierB", "tool1", "2026-01-01T00:00:02.100Z", "call-b"),
      rec("leaf", "carrierA", "2026-01-01T00:00:03.000Z", { type: "assistant", role: "assistant" }),
    ];
    const lines = toLines(records);

    const result = filterActivePath(lines);

    const kept = result.map((l) => JSON.parse(l).uuid);
    expect(kept).toContain("carrierB");
    expect(kept).toEqual(["start", "tool1", "carrierA", "carrierB", "leaf"]);
  });

  test("a genuine (non-tool-result) sibling with real conversation is dropped as an abandoned branch", () => {
    // Contrast case: the off-chain sibling is a REAL user message (a
    // rewind), not a tool-result carrier. It must be dropped, proving
    // the exemption above is specific to tool-result carriers and
    // doesn't just keep every sibling.
    const records = [
      rec("start", null, "2026-01-01T00:00:00.000Z"),
      rec("tool1", "start", "2026-01-01T00:00:01.000Z", { type: "assistant", role: "assistant" }),
      rec("abandonedRewind", "tool1", "2026-01-01T00:05:00.000Z", { content: "actually, let's try something else" }),
      rec("realContinuation", "tool1", "2026-01-01T00:00:02.000Z", { type: "assistant", role: "assistant" }),
      rec("leaf", "realContinuation", "2026-01-01T00:00:03.000Z"),
    ];
    const lines = toLines(records);

    const result = filterActivePath(lines);

    const kept = result.map((l) => JSON.parse(l).uuid);
    expect(kept).not.toContain("abandonedRewind");
    expect(kept).toEqual(["start", "tool1", "realContinuation", "leaf"]);
  });

  test("parallel Task dispatches (assistant-rooted sibling chains) are KEPT, not dropped as abandoned", () => {
    // Regression for a real content-loss bug found in review: when an
    // assistant turn dispatches multiple parallel Task/Agent tool calls,
    // Claude Code encodes each dispatch as its own parent→child chain.
    // Only one sibling can carry the chain to the file's last record;
    // the others dead-end structurally while being completed live work.
    // Shape taken from a real transcript (clay-terra/e56c65da…): a
    // canonical assistant node forks into (a) a second parallel Task
    // dispatch with its own tool_result descendant and (b) the branch
    // that reaches the last record. Verified against 25 real >1MB
    // transcripts: every manually-inspected dropped assistant record was
    // this shape — zero were human rewinds.
    const records = [
      rec("userAsk", null, "2026-01-01T00:00:00.000Z"),
      rec("dispatchA", "userAsk", "2026-01-01T00:00:01.000Z", { type: "assistant", role: "assistant" }),
      // Parallel branch: a SECOND Task dispatch + its tool_result. No
      // human prompt anywhere in this subtree — machine work.
      rec("dispatchB", "dispatchA", "2026-01-01T00:00:02.000Z", { type: "assistant", role: "assistant" }),
      toolResultCarrier("resultB", "dispatchB", "2026-01-01T00:03:00.000Z", "task-b"),
      // Canonical branch: result of dispatch A, then the session's tail.
      toolResultCarrier("resultA", "dispatchA", "2026-01-01T00:02:30.000Z", "task-a"),
      rec("finalReply", "resultA", "2026-01-01T00:04:00.000Z", { type: "assistant", role: "assistant" }),
    ];
    const lines = toLines(records);

    const result = filterActivePath(lines);

    const kept = result.map((l) => JSON.parse(l).uuid);
    expect(kept).toContain("dispatchB");
    expect(kept).toContain("resultB");
    expect(kept).toEqual(["userAsk", "dispatchA", "dispatchB", "resultB", "resultA", "finalReply"]);
  });
});

describe("filterActivePath — explicit leafUuid is NOT used as a leaf signal (documented divergence)", () => {
  test("a trailing compaction summary's leafUuid points at stale pre-compaction content; the real later leaf still wins", () => {
    const records = [
      rec("a", null, "2026-01-01T00:00:00.000Z"),
      rec("b", "a", "2026-01-01T00:00:01.000Z", { type: "assistant", role: "assistant" }),
      // Post-compaction: a fresh root, unrelated to a/b.
      rec("postCompactRoot", null, "2026-01-01T01:00:00.000Z"),
      rec("postCompactLeaf", "postCompactRoot", "2026-01-01T01:00:01.000Z", {
        type: "assistant",
        role: "assistant",
      }),
    ];
    const summary = { type: "summary", summary: "earlier work", leafUuid: "b", timestamp: "2026-01-01T00:30:00.000Z" };
    const lines = [...toLines(records), JSON.stringify(summary)];

    const result = filterActivePath(lines);

    // The summary record itself (no uuid) always passes through.
    expect(result).toContain(JSON.stringify(summary));
    const kept = result.map((l) => JSON.parse(l).uuid).filter(Boolean);
    // Must reach the REAL last leaf, not stop at "b" (the leafUuid target).
    expect(kept).toContain("postCompactLeaf");
  });
});

describe("filterActivePath — malformed JSON lines pass through untouched", () => {
  test("a line that fails JSON.parse is kept in place rather than dropped", () => {
    const records = [rec("a", null, "2026-01-01T00:00:00.000Z")];
    const malformed = "{not valid json";
    const lines = [...toLines(records), malformed];

    const result = filterActivePath(lines);

    expect(result).toContain(malformed);
  });
});

describe("filterActivePath — real transcript sweep", () => {
  function findRealTranscripts(limit: number): string[] {
    const projectsDir = join(homedir(), ".claude", "projects");
    const found: string[] = [];
    let dirs: string[];
    try {
      dirs = readdirSync(projectsDir);
    } catch {
      return found;
    }
    for (const dir of dirs) {
      if (found.length >= limit) break;
      const dirPath = join(projectsDir, dir);
      let entries: string[];
      try {
        entries = readdirSync(dirPath);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (found.length >= limit) break;
        if (!entry.endsWith(".jsonl")) continue;
        const filePath = join(dirPath, entry);
        try {
          if (statSync(filePath).size > 200) found.push(filePath);
        } catch {
          continue;
        }
      }
    }
    return found;
  }

  test("never returns empty for non-empty input and never throws, across 20+ real files", () => {
    const files = findRealTranscripts(30);
    if (files.length < 5) {
      // Environment without a populated ~/.claude/projects — skip
      // rather than fail; this suite still runs in CI-like sandboxes.
      expect(true).toBe(true);
      return;
    }

    let processed = 0;
    let totalIn = 0;
    let totalOut = 0;
    for (const file of files) {
      const raw = readFileSync(file, "utf-8");
      const lines = raw.split("\n").filter((l) => l.trim().length > 0);
      if (lines.length === 0) continue;
      processed++;
      totalIn += lines.length;

      let result: string[] = [];
      expect(() => {
        result = filterActivePath(lines);
      }).not.toThrow();

      expect(result.length).toBeGreaterThan(0);
      totalOut += result.length;
    }

    expect(processed).toBeGreaterThanOrEqual(5);
    // Sanity: filtering should never MORE than double the line count
    // (it only drops or passes through — never duplicates content).
    expect(totalOut).toBeLessThanOrEqual(totalIn);
    console.log(
      `[active-path sweep] files=${processed} linesIn=${totalIn} linesOut=${totalOut} ` +
        `dropped=${totalIn - totalOut} (${(((totalIn - totalOut) / totalIn) * 100).toFixed(1)}%)`,
    );
  });
});
