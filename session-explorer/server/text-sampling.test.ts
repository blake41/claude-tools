import { describe, expect, test } from "bun:test";
import { sampleHeadTail } from "./text-sampling.js";

describe("sampleHeadTail", () => {
  test("returns text unchanged when it already fits the budget", () => {
    const text = "a".repeat(100);
    expect(sampleHeadTail(text, 60, 60)).toBe(text);
  });

  test("keeps the head and tail and drops the middle for long text", () => {
    const head = "H".repeat(10);
    const middle = "M".repeat(1000);
    const tail = "T".repeat(10);
    const text = head + middle + tail;

    const result = sampleHeadTail(text, 10, 10);

    expect(result.startsWith(head)).toBe(true);
    expect(result.endsWith(tail)).toBe(true);
    expect(result).not.toContain("MMMM");
    expect(result).toContain("middle of session omitted");
  });

  test("a long session is summarized by its ending, not just its beginning", () => {
    // Regression guard for the bug: sampling only the first N chars means a
    // long session's final decisions/corrections never reach the model.
    const beginning = "Started debugging the login flow. ".repeat(2000);
    const ending = "FINAL DECISION: switched to JWT refresh tokens.";
    const transcript = beginning + ending;

    const sampled = sampleHeadTail(transcript, 16000, 16000);

    expect(sampled).toContain(ending);
  });
});
