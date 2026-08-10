import { describe, expect, test } from "bun:test";
import { parseSummaryOutput } from "./summary-parse";

describe("parseSummaryOutput", () => {
  test("plain conforming output parses fully", () => {
    const { oneLine, bullets } = parseSummaryOutput(
      "ONELINE: Fixed FTS5 search ranking to use NEAR queries\n- Fixed ranking\n- Added tests",
    );
    expect(oneLine).toBe("Fixed FTS5 search ranking to use NEAR queries");
    expect(bullets).toBe("- Fixed ranking\n- Added tests");
  });

  test("markdown-decorated ONELINE is still recognized", () => {
    // Models decorate keywords despite "no markdown" instructions. The old
    // anchored regex missed these, producing a partial parse that reset the
    // backoff state — the exact cost-leak loop the backoff exists to stop.
    for (const raw of [
      "**ONELINE:** Fixed the thing\n- Did work",
      "**ONELINE**: Fixed the thing\n- Did work",
      "# ONELINE: Fixed the thing\n- Did work",
      "> ONELINE: Fixed the thing\n- Did work",
      "`ONELINE`: Fixed the thing\n- Did work",
    ]) {
      const { oneLine, bullets } = parseSummaryOutput(raw);
      expect(oneLine).toBe("Fixed the thing");
      expect(bullets).toBe("- Did work");
    }
  });

  test("trailing decoration is stripped from the headline", () => {
    const { oneLine } = parseSummaryOutput("**ONELINE: Fixed the thing**\n- Did work");
    expect(oneLine).toBe("Fixed the thing");
  });

  test("bullets without headline is a partial parse", () => {
    const { oneLine, bullets } = parseSummaryOutput("- Fixed ranking\n- Added tests");
    expect(oneLine).toBe("");
    expect(bullets).toBe("- Fixed ranking\n- Added tests");
  });

  test("headline without bullets is a partial parse", () => {
    const { oneLine, bullets } = parseSummaryOutput("ONELINE: Fixed the thing");
    expect(oneLine).toBe("Fixed the thing");
    expect(bullets).toBe("");
  });

  test("empty / garbage output yields nothing", () => {
    expect(parseSummaryOutput("")).toEqual({ oneLine: "", bullets: "" });
    expect(parseSummaryOutput("Sure! Here's a summary.")).toEqual({ oneLine: "", bullets: "" });
  });

  test("only the first ONELINE wins", () => {
    const { oneLine } = parseSummaryOutput("ONELINE: First\nONELINE: Second\n- b");
    expect(oneLine).toBe("First");
  });
});
