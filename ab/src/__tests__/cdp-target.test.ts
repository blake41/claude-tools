import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { pickTabWs } from "../../cdp-target";
import { sessionTargetEnv } from "../cli";
import { recordSessionTarget, sessionFilePath } from "../session";

const AB_DIR = path.resolve(import.meta.dir, "../..");
const tabs = [
  { id: "AAAA1111", type: "page", webSocketDebuggerUrl: "ws://x/other" },
  { id: "BBBB2222", type: "page", webSocketDebuggerUrl: "ws://x/mine" },
];

describe("pickTabWs", () => {
  test("selects the tab matching the recorded id, not pages[0]", () => {
    expect(pickTabWs(tabs, "BBBB2222")).toBe("ws://x/mine");
  });

  test("errors when no id is recorded instead of using pages[0]", () => {
    expect(() => pickTabWs(tabs, undefined)).toThrow(/No tab recorded/);
    expect(() => pickTabWs(tabs, "")).toThrow(/No tab recorded/);
  });

  test("errors when the recorded tab is gone", () => {
    expect(() => pickTabWs(tabs, "CCCC3333")).toThrow(/no longer exists/);
  });
});

describe("sessionTargetEnv", () => {
  const pid = `cdptarget-test-${process.pid}`;
  afterEach(() => {
    try { fs.unlinkSync(sessionFilePath(pid)); } catch {}
  });

  test("returns the most recently recorded target for the port", () => {
    recordSessionTarget(pid, 9333, "AAAA1111");
    recordSessionTarget(pid, 9444, "DDDD4444");
    recordSessionTarget(pid, 9333, "BBBB2222");
    expect(sessionTargetEnv(pid, 9333)).toEqual({ AB_TARGET_ID: "BBBB2222" });
  });

  test("omits the key when nothing is recorded", () => {
    expect(sessionTargetEnv(pid, 9333)).toEqual({});
  });
});

describe("cdp-click script", () => {
  test("refuses to click when the session has no recorded tab", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json(tabs),
    });
    try {
      const proc = Bun.spawn(["bun", "run", path.join(AB_DIR, "cdp-click.ts"), String(server.port), "button"], {
        env: { ...process.env, AB_TARGET_ID: "" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
      expect(code).toBe(1);
      expect(err).toMatch(/No tab recorded/);
    } finally {
      server.stop(true);
    }
  });
});

describe("console-tail script", () => {
  test("exits instead of reconnecting forever when the session has no recorded tab", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json(tabs),
    });
    try {
      const env: Record<string, string | undefined> = { ...process.env };
      delete env.AB_TARGET_ID;
      const proc = Bun.spawn(["bun", "run", path.join(AB_DIR, "console-tail.ts"), String(server.port)], {
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
      expect(code).toBe(1);
      expect(err).toMatch(/No tab recorded/);
      expect(err).not.toMatch(/Reconnecting/);
    } finally {
      server.stop(true);
    }
  }, 10_000);
});
