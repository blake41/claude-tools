import { describe, expect, test } from "bun:test";
import { isLocalCommandNoise, isTitleWorthy, pickTitle, stripAnsiCodes } from "./title.js";

describe("isTitleWorthy", () => {
  test("rejects empty/whitespace-only content", () => {
    expect(isTitleWorthy("")).toBe(false);
    expect(isTitleWorthy("   \n  ")).toBe(false);
  });

  test("rejects a bare slash command with no argument text", () => {
    expect(isTitleWorthy("/model")).toBe(false);
    expect(isTitleWorthy("/clear   ")).toBe(false);
  });

  test("accepts a slash command that carries argument text", () => {
    expect(isTitleWorthy("/ship-lite fix the bug")).toBe(true);
  });

  test("accepts ordinary text", () => {
    expect(isTitleWorthy("Fix the login flow")).toBe(true);
  });
});

describe("isLocalCommandNoise", () => {
  test("flags local-command-stdout content", () => {
    expect(
      isLocalCommandNoise("<local-command-stdout>some output</local-command-stdout>")
    ).toBe(true);
  });

  test("flags local-command-caveat content", () => {
    expect(
      isLocalCommandNoise("<local-command-caveat>careful</local-command-caveat>")
    ).toBe(true);
  });

  test("does not flag ordinary text", () => {
    expect(isLocalCommandNoise("Fix the login flow")).toBe(false);
  });
});

describe("stripAnsiCodes", () => {
  test("strips real ESC-prefixed ANSI sequences", () => {
    expect(stripAnsiCodes("\x1b[1mFable 5\x1b[22m")).toBe("Fable 5");
  });

  test("strips bare bracket artifacts left after ESC byte is gone", () => {
    // This is the exact shape reported in the bug: strip.ts (or upstream)
    // already dropped the literal ESC byte, leaving "[1m...[22m" behind.
    expect(stripAnsiCodes("[1mFable 5[22m")).toBe("Fable 5");
  });

  test("leaves ordinary bracketed text alone", () => {
    expect(stripAnsiCodes("See [the docs] for more")).toBe("See [the docs] for more");
  });
});

describe("pickTitle", () => {
  test("picks the first title-worthy text message", () => {
    const title = pickTitle([
      { messageType: "text", content: "/clear" },
      { messageType: "text", content: "Fix the login flow" },
    ]);
    expect(title).toBe("Fix the login flow");
  });

  test("skips local-command-stdout/caveat messages entirely, including as fallback", () => {
    const title = pickTitle([
      {
        messageType: "text",
        content: "<local-command-stdout>…[1mFable 5[22m…</local-command-stdout>",
      },
    ]);
    expect(title).toBe("");
  });

  test("falls back to the first text message when none are title-worthy, and still strips ANSI", () => {
    const title = pickTitle([
      { messageType: "text", content: "[1m[22m" },
    ]);
    expect(title).toBe("");
  });

  test("ignores non-text message types", () => {
    const title = pickTitle([
      { messageType: "tool_use", content: "Fix the login flow" },
      { messageType: "text", content: "Actual user turn" },
    ]);
    expect(title).toBe("Actual user turn");
  });

  test("strips ANSI garbage from a picked title that is otherwise real content", () => {
    const title = pickTitle([
      { messageType: "text", content: "Run tests \x1b[32mgreen\x1b[0m please" },
    ]);
    expect(title).toBe("Run tests green please");
  });

  test("returns empty string when there are no user text messages", () => {
    expect(pickTitle([])).toBe("");
  });
});
