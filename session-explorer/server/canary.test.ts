import { describe, expect, test } from "bun:test";
import {
  KNOWN_RECORD_TYPES,
  parseJsonlLines,
  tallyUnknownRecordTypes,
} from "./canary.js";
import { SKIP_RECORD_TYPES } from "./projection";
import { parseJsonlLine } from "./trace/vendor/main/utils/jsonl";

/** Minimal valid raw record for each known type, matching what the vendored
 * parser's `parseChatHistoryEntry` needs to not throw: `user`/`assistant`
 * additionally require a `message` object (it reads `.role`/`.content`
 * before anything else). */
function minimalRecordFor(type: string): Record<string, unknown> {
  const base = { uuid: "11111111-1111-1111-1111-111111111111", type };
  if (type === "user") return { ...base, message: { role: "user", content: "hi" } };
  if (type === "assistant") return { ...base, message: { role: "assistant", content: "hi" } };
  return base;
}

describe("parseJsonlLines", () => {
  test("parses one JSON object per non-blank line", () => {
    const raw = [
      JSON.stringify({ type: "user" }),
      "",
      JSON.stringify({ type: "assistant" }),
    ].join("\n");
    expect(parseJsonlLines(raw)).toEqual([
      { type: "user" },
      { type: "assistant" },
    ]);
  });

  test("silently skips malformed lines, mirroring strip.ts's own behavior", () => {
    const raw = [
      JSON.stringify({ type: "user" }),
      "{not valid json",
      JSON.stringify({ type: "assistant" }),
    ].join("\n");
    expect(parseJsonlLines(raw)).toEqual([
      { type: "user" },
      { type: "assistant" },
    ]);
  });

  test("empty input yields an empty array", () => {
    expect(parseJsonlLines("")).toEqual([]);
    expect(parseJsonlLines("\n\n\n")).toEqual([]);
  });
});

describe("tallyUnknownRecordTypes", () => {
  test("known handled/skipped types produce an empty tally", () => {
    const records = [
      { type: "user" },
      { type: "assistant" },
      { type: "system" },
      { type: "summary" },
      { type: "file-history-snapshot" },
      { type: "queue-operation" },
      { type: "progress" },
    ];
    expect(tallyUnknownRecordTypes(records)).toEqual({});
  });

  test("tallies a single unknown type by count", () => {
    const records = [
      { type: "user" },
      { type: "compact-boundary" },
      { type: "compact-boundary" },
      { type: "compact-boundary" },
    ];
    expect(tallyUnknownRecordTypes(records)).toEqual({ "compact-boundary": 3 });
  });

  test("tallies multiple distinct unknown types independently", () => {
    const records = [
      { type: "compact-boundary" },
      { type: "hook-event" },
      { type: "compact-boundary" },
      { type: "assistant" },
    ];
    expect(tallyUnknownRecordTypes(records)).toEqual({
      "compact-boundary": 2,
      "hook-event": 1,
    });
  });

  test("records with a missing/undefined type are ignored, not tallied as 'undefined'", () => {
    const records = [{}, { type: undefined }, { type: "user" }];
    expect(tallyUnknownRecordTypes(records)).toEqual({});
  });

  // Regression guard, behavioral rather than a hand-copied literal: every
  // KNOWN type except the legacy "progress" must be a type the vendored
  // parser actually recognizes (parseJsonlLine returns non-null), and
  // projection.ts's SKIP_RECORD_TYPES — its own structural-skip vocabulary —
  // must be a subset of KNOWN. This fails loudly the moment the parser's or
  // projection's vocabulary drifts from what canary.ts thinks it's policing,
  // instead of silently pinning whatever the constant happened to say.
  test("every KNOWN type except legacy 'progress' is recognized by the vendored parser", () => {
    for (const type of KNOWN_RECORD_TYPES) {
      if (type === "progress") continue;
      const parsed = parseJsonlLine(JSON.stringify(minimalRecordFor(type)));
      expect(parsed).not.toBeNull();
    }
  });

  test("'progress' (legacy) and an unrecognized type are both dropped by the vendored parser", () => {
    expect(parseJsonlLine(JSON.stringify(minimalRecordFor("progress")))).toBeNull();
    expect(parseJsonlLine(JSON.stringify(minimalRecordFor("compact-boundary")))).toBeNull();
  });

  test("projection.ts's SKIP_RECORD_TYPES is a subset of KNOWN_RECORD_TYPES", () => {
    for (const type of SKIP_RECORD_TYPES) {
      expect(KNOWN_RECORD_TYPES.has(type)).toBe(true);
    }
  });
});
