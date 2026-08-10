import { describe, expect, test } from "bun:test";
import {
  KNOWN_RECORD_TYPES,
  parseJsonlLines,
  tallyUnknownRecordTypes,
} from "./canary.js";

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
      { type: "file-history-snapshot" },
      { type: "progress" },
      { type: "queue-operation" },
      { type: "system" },
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

  test("KNOWN_RECORD_TYPES covers exactly strip.ts's handled + skipped vocabulary", () => {
    // Regression guard: if strip.ts's SKIP_TYPES set changes, this constant
    // must be updated in lockstep or the canary will start false-alarming.
    expect([...KNOWN_RECORD_TYPES].sort()).toEqual(
      [
        "user",
        "assistant",
        "file-history-snapshot",
        "progress",
        "queue-operation",
        "system",
      ].sort()
    );
  });
});
