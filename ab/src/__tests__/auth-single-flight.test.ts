import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { __resetAuthStateForTest, authenticateJoined } from "../auth";
import type { AgentTaskClient, LoginBudget } from "../auth";

const originalSpawn = Bun.spawn;

/** A login budget whose signal is never aborted. */
const budget = (deadline = Date.now() + 60_000): LoginBudget => ({ signal: new AbortController().signal, deadline });

beforeEach(() => {
  __resetAuthStateForTest();
  Bun.spawn = (() => ({
    pid: 1,
    exitCode: 0,
    exited: Promise.resolve(0),
    stdout: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("about:blank")); c.close(); } }),
    stderr: new ReadableStream({ start(c) { c.close(); } }),
    kill: () => {},
  })) as unknown as typeof Bun.spawn;
});

afterEach(() => {
  Bun.spawn = originalSpawn;
  __resetAuthStateForTest();
});

function gate() {
  let release!: () => void;
  const opened = new Promise<void>((r) => { release = r; });
  return { opened, release };
}

describe("authenticateJoined", () => {
  const TEST_KEY = "sk_test_abcdef";

  function countingClerk() {
    const g = gate();
    let mints = 0;
    const client = {
      agentTasks: {
        create: async () => { mints++; await g.opened; throw new Error("mint refused"); },
      },
    } as unknown as AgentTaskClient;
    return { client, release: g.release, mints: () => mints };
  }

  const req = (over: Partial<Parameters<typeof authenticateJoined>[0]> = {}) => ({
    sessionId: "s",
    port: 9333,
    email: "blake@clay.com",
    appBaseUrl: "http://localhost:5173",
    clerkSecretKey: TEST_KEY,
    ...over,
  });

  test("two concurrent logins for the same port and appBaseUrl mint once and get the same result", async () => {
    const c = countingClerk();
    const deps = { createClerkClient: () => c.client };

    const a = authenticateJoined(req({ sessionId: "s1" }), budget(), deps);
    const b = authenticateJoined(req({ sessionId: "s2" }), budget(), deps);
    await new Promise((r) => setTimeout(r, 20));
    c.release();
    const [ra, rb] = await Promise.all([a, b]);

    expect(c.mints()).toBe(1);
    expect(ra).toBe(rb);
    expect(ra.ok).toBe(false);
    expect(ra.error).toContain("mint refused");
  });

  test("different appBaseUrl mints separately", async () => {
    const c = countingClerk();
    const deps = { createClerkClient: () => c.client };

    const a = authenticateJoined(req(), budget(), deps);
    const b = authenticateJoined(req({ appBaseUrl: "https://wt.terra.localhost" }), budget(), deps);
    await new Promise((r) => setTimeout(r, 20));
    c.release();
    await Promise.all([a, b]);

    expect(c.mints()).toBe(2);
  });

  test("different port mints separately", async () => {
    const c = countingClerk();
    const deps = { createClerkClient: () => c.client };

    const a = authenticateJoined(req(), budget(), deps);
    const b = authenticateJoined(req({ port: 9334 }), budget(), deps);
    await new Promise((r) => setTimeout(r, 20));
    c.release();
    await Promise.all([a, b]);

    expect(c.mints()).toBe(2);
  });

  test("after the first caller aborts mid-mint, a retry starts a fresh flight and the first answers the timeout", async () => {
    const c = countingClerk();
    const deps = { createClerkClient: () => c.client };
    const first = new AbortController();

    const a = authenticateJoined(req({ sessionId: "s1" }), { signal: first.signal, deadline: Date.now() + 60_000 }, deps);
    await new Promise((r) => setTimeout(r, 20));
    expect(c.mints()).toBe(1);
    first.abort();
    const b = authenticateJoined(req({ sessionId: "s2" }), budget(), deps);

    const ra = await a;
    expect(ra.ok).toBe(false);
    expect(ra.error).toContain("Auth exchange timed out");
    await new Promise((r) => setTimeout(r, 20));
    expect(c.mints()).toBe(2);
    c.release();
    expect((await b).error).toContain("mint refused");
  });

  test("a login started after the first settled mints again", async () => {
    const c = countingClerk();
    c.release();
    const deps = { createClerkClient: () => c.client };

    await authenticateJoined(req(), budget(), deps);
    await authenticateJoined(req(), budget(), deps);

    expect(c.mints()).toBe(2);
  });

  test("a rejected login clears the entry: joined callers all reject, a later call runs fresh", async () => {
    let spawns = 0;
    Bun.spawn = (() => {
      spawns++;
      throw new Error("spawn exploded");
    }) as unknown as typeof Bun.spawn;
    const c = countingClerk();
    const deps = { createClerkClient: () => c.client };

    const a = authenticateJoined(req({ sessionId: "s1" }), budget(), deps);
    const b = authenticateJoined(req({ sessionId: "s2" }), budget(), deps);
    const settled = await Promise.allSettled([a, b]);
    const after = await Promise.allSettled([authenticateJoined(req(), budget(), deps)]);

    expect(settled.map((x) => x.status)).toEqual(["rejected", "rejected"]);
    expect(after[0].status).toBe("rejected");
    expect(spawns).toBe(2);
  });
});
