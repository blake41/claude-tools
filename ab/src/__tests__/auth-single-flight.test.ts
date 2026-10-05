import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { __resetAuthStateForTest, authenticateJoined, createSingleFlight } from "../auth";
import type { AgentTaskClient } from "../auth";

const originalSpawn = Bun.spawn;

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

describe("createSingleFlight", () => {
  test("concurrent callers with the same key share one run and one result", async () => {
    const flight = createSingleFlight<{ n: number }>();
    const g = gate();
    let runs = 0;
    const run = async () => { runs++; await g.opened; return { n: runs }; };

    const a = flight("k", run);
    const b = flight("k", run);
    g.release();
    const [ra, rb] = await Promise.all([a, b]);

    expect(runs).toBe(1);
    expect(ra).toBe(rb);
  });

  test("different keys run independently", async () => {
    const flight = createSingleFlight<number>();
    const g = gate();
    let runs = 0;
    const run = async () => { runs++; await g.opened; return runs; };

    const a = flight("k1", run);
    const b = flight("k2", run);
    g.release();
    await Promise.all([a, b]);

    expect(runs).toBe(2);
  });

  test("entry is removed on success so a later call runs again", async () => {
    const flight = createSingleFlight<number>();
    let runs = 0;
    const run = async () => ++runs;

    await flight("k", run);
    await flight("k", run);

    expect(runs).toBe(2);
  });

  test("entry is removed on rejection and joined callers all see the rejection", async () => {
    const flight = createSingleFlight<number>();
    const g = gate();
    let runs = 0;
    const run = async () => { runs++; await g.opened; throw new Error("boom"); };

    const a = flight("k", run);
    const b = flight("k", run);
    g.release();
    const settled = await Promise.allSettled([a, b]);

    expect(settled.map((s) => s.status)).toEqual(["rejected", "rejected"]);
    expect(runs).toBe(1);
    await expect(flight("k", async () => 7)).resolves.toBe(7);
  });
});

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

    const a = authenticateJoined(req({ sessionId: "s1" }), deps);
    const b = authenticateJoined(req({ sessionId: "s2" }), deps);
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

    const a = authenticateJoined(req(), deps);
    const b = authenticateJoined(req({ appBaseUrl: "https://wt.terra.localhost" }), deps);
    await new Promise((r) => setTimeout(r, 20));
    c.release();
    await Promise.all([a, b]);

    expect(c.mints()).toBe(2);
  });

  test("different port mints separately", async () => {
    const c = countingClerk();
    const deps = { createClerkClient: () => c.client };

    const a = authenticateJoined(req(), deps);
    const b = authenticateJoined(req({ port: 9334 }), deps);
    await new Promise((r) => setTimeout(r, 20));
    c.release();
    await Promise.all([a, b]);

    expect(c.mints()).toBe(2);
  });

  test("a login started after the first settled mints again", async () => {
    const c = countingClerk();
    c.release();
    const deps = { createClerkClient: () => c.client };

    await authenticateJoined(req(), deps);
    await authenticateJoined(req(), deps);

    expect(c.mints()).toBe(2);
  });
});
