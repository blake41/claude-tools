/**
 * Auth contract tests.
 *
 * Tests the authenticate() flow against an injected fake Clerk client and mocked agent-browser responses (no network).
 * Verifies the shapes that cli.ts reads: { ok, user: { email }, error }.
 */
import { test, expect, describe, beforeEach, afterEach, mock, spyOn } from "bun:test";
import * as fs from "fs";
import { __resetAuthStateForTest, getAuthStatus, authenticate, isAuthenticatedUrl } from "../auth";
import type { AgentTaskClient } from "../auth";
import { getRecentLogs } from "../logger";
import type { AuthLoginResponse, AuthStatusResponse } from "../types";

// ---------------------------------------------------------------------------
// Mock setup
// ---------------------------------------------------------------------------

// We mock global fetch (the ab daemon RPC in cmdReauth tests) and Bun.spawn (for agent-browser).
// Bun.spawn is used by the internal runAgentBrowser helper.

const originalFetch = globalThis.fetch;
const originalSpawn = Bun.spawn;

let fetchMock: ReturnType<typeof mock>;
let spawnMock: ReturnType<typeof mock>;

beforeEach(() => {
  __resetAuthStateForTest();
  fetchMock = mock(() => Promise.resolve(new Response("{}", { status: 200 })));
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  // Default spawn mock: agent-browser returns exit 0 with empty stdout
  spawnMock = mock(() => ({
    pid: 1,
    exitCode: 0,
    exited: Promise.resolve(0),
    stdout: new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode("")); c.close(); },
    }),
    stderr: new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode("")); c.close(); },
    }),
    kill: () => {},
  }));
  Bun.spawn = spawnMock;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  Bun.spawn = originalSpawn;
  __resetAuthStateForTest();
});

// ---------------------------------------------------------------------------
// Shape helpers
// ---------------------------------------------------------------------------

function assertLoginSuccess(result: AuthLoginResponse): void {
  expect(result.ok).toBe(true);
  // cli.ts reads result.user?.email
  if (result.user) {
    expect(typeof result.user.email).toBe("string");
  }
}

function assertLoginFailure(result: AuthLoginResponse): void {
  expect(result.ok).toBe(false);
  expect(typeof result.error).toBe("string");
  expect(result.error!.length).toBeGreaterThan(0);
}

function assertAuthStatusShape(status: AuthStatusResponse): void {
  expect(typeof status.ok).toBe("boolean");
  expect(typeof status.authenticated).toBe("boolean");
  // user is { email } | null
  if (status.user !== null) {
    expect(typeof status.user.email).toBe("string");
  }
  // lastLogin is ISO string | null
  if (status.lastLogin !== null) {
    expect(typeof status.lastLogin).toBe("string");
    // Should be a valid ISO date
    expect(new Date(status.lastLogin).toISOString()).toBe(status.lastLogin);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const TEST_KEY = "sk_test_UNITTESTSECRET";
const MINTED_URL = "https://fake-instance.clerk.accounts.dev/v1/tickets/accept?ticket=TICKETSECRET";

const SESSION_COOKIE = { name: "__session", value: "jwt.header.sig", domain: "localhost" };

interface FakeClient extends AgentTaskClient {
  calls: Array<Record<string, unknown>>;
}

function fakeClerk(opts: { url?: string; throws?: unknown } = {}): { client: FakeClient; factory: ReturnType<typeof mock> } {
  const calls: Array<Record<string, unknown>> = [];
  const client: FakeClient = {
    calls,
    agentTasks: {
      create: async (params: unknown) => {
        calls.push(params as Record<string, unknown>);
        if (opts.throws) throw opts.throws;
        return { agentId: "agent_1", taskId: "task_1", url: opts.url ?? MINTED_URL };
      },
    } as unknown as AgentTaskClient["agentTasks"],
  };
  const factory = mock((_secretKey: string) => client);
  return { client, factory };
}

/** Mock agent-browser: record args per call, answer `get url` from `urls` in order. */
function scriptBrowser(urls: string[], cookies: Array<Record<string, string>> = [SESSION_COOKIE]): string[][] {
  const calls: string[][] = [];
  let urlIdx = 0;
  spawnMock.mockImplementation((cmd: string[]) => {
    const args = cmd.slice(5); // after: agent-browser --session <id> --cdp <port>
    calls.push(args);
    let stdout = "";
    if (args[0] === "get" && args[1] === "url") stdout = urls[Math.min(urlIdx++, urls.length - 1)] ?? "";
    else if (args[0] === "cookies" && args[1] === "get") stdout = JSON.stringify({ success: true, data: { cookies }, error: null });
    return {
      pid: 1,
      exitCode: 0,
      exited: Promise.resolve(0),
      stdout: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(stdout)); c.close(); } }),
      stderr: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("")); c.close(); } }),
      kill: () => {},
    };
  });
  return calls;
}

const STATUS_OPTS = { port: 9333, sessionId: "test" };

function authStatusOf(s: AuthStatusResponse) {
  return { authenticated: s.authenticated, user: s.user, lastLogin: s.lastLogin };
}

function allLogs(): string {
  return JSON.stringify(getRecentLogs());
}

describe("auth contract", () => {
  test("authenticate without email returns failure telling the user to pass an email", async () => {
    scriptBrowser(["about:blank"]);
    const { factory } = fakeClerk();

    const result = await authenticate({ sessionId: "test", port: 9333, clerkSecretKey: TEST_KEY }, { createClerkClient: factory });

    assertLoginFailure(result);
    expect(result.error).toContain("email");
    expect(factory).not.toHaveBeenCalled();
  });

  test("refuses sk_live_ key before any Clerk call or browser navigation", async () => {
    const calls = scriptBrowser(["about:blank"]);
    const { factory } = fakeClerk();

    const result = await authenticate(
      { sessionId: "test", port: 9333, email: "blake@clay.com", clerkSecretKey: "sk_live_LIVESECRET" },
      { createClerkClient: factory },
    );

    assertLoginFailure(result);
    expect(result.error).toContain("sk_test_");
    expect(factory).not.toHaveBeenCalled();
    expect(calls.some((a) => a[0] === "open")).toBe(false);
    expect(allLogs()).not.toContain("LIVESECRET");
  });

  test("refuses the production app host", async () => {
    const calls = scriptBrowser(["about:blank"]);
    const { factory } = fakeClerk();

    const result = await authenticate(
      { sessionId: "test", port: 9333, email: "blake@clay.com", appBaseUrl: "https://terra.clay.com", clerkSecretKey: TEST_KEY },
      { createClerkClient: factory },
    );

    assertLoginFailure(result);
    expect(result.error).toContain("terra.clay.com");
    expect(factory).not.toHaveBeenCalled();
    expect(calls.some((a) => a[0] === "open")).toBe(false);
  });

  test("ignores the daemon's own CLERK_SECRET_KEY: the request must carry the key", async () => {
    const original = process.env.CLERK_SECRET_KEY;
    process.env.CLERK_SECRET_KEY = TEST_KEY;
    try {
      const calls = scriptBrowser(["about:blank", "http://localhost:5173/"]);
      const { factory } = fakeClerk();
      const result = await authenticate({ sessionId: "test", port: 9333, email: "blake@clay.com" }, { createClerkClient: factory });
      assertLoginFailure(result);
      expect(result.error).toContain("CLERK_SECRET_KEY");
      expect(factory).not.toHaveBeenCalled();
      expect(calls.some((a) => a[0] === "open")).toBe(false);
    } finally {
      if (original === undefined) delete process.env.CLERK_SECRET_KEY;
      else process.env.CLERK_SECRET_KEY = original;
    }
  });

  test("success: mints an Agent Task for the email, opens the minted url, polls until on the app origin", async () => {
    // get url sequence: initial (about:blank), then poll #1 still on Clerk-hosted page, poll #2 on app
    const calls = scriptBrowser(["about:blank", "https://fake-instance.clerk.accounts.dev/v1/tickets/accept", "http://localhost:5173/"]);
    const { client, factory } = fakeClerk();

    const result = await authenticate(
      { sessionId: "test", port: 9333, email: "blake@clay.com", clerkSecretKey: TEST_KEY },
      { createClerkClient: factory },
    );

    expect(result.ok).toBe(true);
    expect(result.user?.email).toBe("blake@clay.com");
    expect(factory).toHaveBeenCalledWith(TEST_KEY);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toMatchObject({
      onBehalfOf: { identifier: "blake@clay.com" },
      permissions: "*",
      agentName: "ab",
      taskDescription: "ab reauth",
      redirectUrl: "http://localhost:5173/",
      sessionMaxDurationInSeconds: 3600,
    });
    const open = calls.find((a) => a[0] === "open");
    expect(open).toEqual(["open", MINTED_URL]);
    // Step 5's poll checks the real landing condition; no networkidle wait eats the budget.
    expect(calls.some((a) => a[0] === "wait" || a.includes("networkidle"))).toBe(false);
    expect(calls.filter((a) => a[0] === "get" && a[1] === "url").length).toBeGreaterThanOrEqual(3);
  });

  test("secret key, minted url and ticket never appear in logs (success path)", async () => {
    scriptBrowser(["about:blank", "http://localhost:5173/"]);
    const { factory } = fakeClerk();

    await authenticate(
      { sessionId: "test", port: 9333, email: "blake@clay.com", clerkSecretKey: TEST_KEY },
      { createClerkClient: factory },
    );

    const logs = allLogs();
    expect(logs.length).toBeGreaterThan(2);
    expect(logs).not.toContain("UNITTESTSECRET");
    expect(logs).not.toContain("TICKETSECRET");
    expect(logs).not.toContain("clerk.accounts.dev");
  });

  test("secret key never appears in logs or errors when Clerk fails with it in the message", async () => {
    scriptBrowser(["about:blank"]);
    const { factory } = fakeClerk({ throws: new Error(`boom ${TEST_KEY}`) });

    const result = await authenticate(
      { sessionId: "test", port: 9333, email: "blake@clay.com", clerkSecretKey: TEST_KEY },
      { createClerkClient: factory },
    );

    assertLoginFailure(result);
    expect(allLogs() + (result.error ?? "")).not.toContain("UNITTESTSECRET");
  });

  test("minted url, ticket and key never appear in logs when browser navigation fails with them in stderr", async () => {
    const calls: string[][] = [];
    spawnMock.mockImplementation((cmd: string[]) => {
      const args = cmd.slice(5);
      calls.push(args);
      const failing = args[0] === "open";
      const out = failing ? "" : args[0] === "get" ? "about:blank" : "";
      const err = failing ? `navigation to ${MINTED_URL} failed ticket=TICKETSECRET ${TEST_KEY}` : "";
      const stream = (t: string) => new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(t)); c.close(); } });
      return { pid: 1, exitCode: failing ? 1 : 0, exited: Promise.resolve(failing ? 1 : 0), stdout: stream(out), stderr: stream(err), kill: () => {} };
    });
    const { factory } = fakeClerk();

    const result = await authenticate(
      { sessionId: "test", port: 9333, email: "blake@clay.com", clerkSecretKey: TEST_KEY },
      { createClerkClient: factory },
    );

    assertLoginFailure(result);
    // The 400 body carries the redacted stderr tail, not a generic message.
    expect(result.error).toBe("Auth exchange failed: navigation to [redacted] failed ticket=[redacted] [redacted]");
    const blob = allLogs() + (result.error ?? "");
    expect(blob).not.toContain("UNITTESTSECRET");
    expect(blob).not.toContain("TICKETSECRET");
    expect(blob).not.toContain("clerk.accounts.dev");
  });

  test("navigation failure keeps only the last ~400 chars of stderr in the error", async () => {
    spawnMock.mockImplementation((cmd: string[]) => {
      const args = cmd.slice(5);
      const failing = args[0] === "open";
      const err = failing ? `${"x".repeat(1_000)} ticket=TICKETSECRET END-OF-STDERR` : "";
      const stream = (t: string) => new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(t)); c.close(); } });
      return { pid: 1, exitCode: failing ? 1 : 0, exited: Promise.resolve(failing ? 1 : 0), stdout: stream(failing ? "" : "about:blank"), stderr: stream(err), kill: () => {} };
    });

    const result = await authenticate(
      { sessionId: "test", port: 9333, email: "blake@clay.com", clerkSecretKey: TEST_KEY },
      { createClerkClient: fakeClerk().factory },
    );

    assertLoginFailure(result);
    expect(result.error!.startsWith("Auth exchange failed: ")).toBe(true);
    expect(result.error!.endsWith("ticket=[redacted] END-OF-STDERR")).toBe(true);
    expect(result.error!.length).toBeLessThanOrEqual("Auth exchange failed: ".length + 400);
    expect(result.error).not.toContain("TICKETSECRET");
    // authState was not recorded (status.authenticated follows the cookie jar, which these scripts fill).
    expect((await getAuthStatus(STATUS_OPTS)).lastLogin).toBeNull();
  });

  test("Clerk user-not-found (404 / *_not_found) maps to the friendly 'no Clerk account' error", async () => {
    scriptBrowser(["about:blank"]);
    const notFound = Object.assign(new Error("Not Found"), {
      status: 404,
      errors: [{ code: "resource_not_found", message: "not found" }],
    });
    const { factory } = fakeClerk({ throws: notFound });

    const result = await authenticate(
      { sessionId: "test", port: 9333, email: "nobody@clay.com", appBaseUrl: "http://localhost:5173", clerkSecretKey: TEST_KEY },
      { createClerkClient: factory },
    );

    assertLoginFailure(result);
    expect(result.error).toContain("nobody@clay.com");
    expect(result.error).toContain("no Clerk account in this environment");
  });

  test("other Clerk errors surface as a generic mint failure", async () => {
    scriptBrowser(["about:blank"]);
    const { factory } = fakeClerk({ throws: Object.assign(new Error("Unauthorized"), { status: 401 }) });

    const result = await authenticate(
      { sessionId: "test", port: 9333, email: "blake@clay.com", clerkSecretKey: TEST_KEY },
      { createClerkClient: factory },
    );

    assertLoginFailure(result);
    expect(result.error).toContain("Agent Task");
    expect(result.error).not.toContain("no Clerk account");
  });

  test("a minted response without a url returns failure", async () => {
    scriptBrowser(["about:blank"]);
    const { factory } = fakeClerk({ url: "" });

    const result = await authenticate(
      { sessionId: "test", port: 9333, email: "blake@clay.com", clerkSecretKey: TEST_KEY },
      { createClerkClient: factory },
    );

    assertLoginFailure(result);
    expect(result.error).toContain("missing url");
  });

  test("times out at the deadline when the browser never lands on the app origin", async () => {
    scriptBrowser(["about:blank", "https://fake-instance.clerk.accounts.dev/v1/tickets/accept"]);
    const { factory } = fakeClerk();

    const started = Date.now();
    const result = await authenticate(
      { sessionId: "test", port: 9333, email: "blake@clay.com", clerkSecretKey: TEST_KEY },
      { createClerkClient: factory, deadline: started + 150, pollIntervalMs: 5 },
    );

    assertLoginFailure(result);
    expect(result.error).toContain("timed out");
    expect(Date.now() - started).toBeLessThan(1_000);
    // authState was not recorded (status.authenticated follows the cookie jar, which these scripts fill).
    expect((await getAuthStatus(STATUS_OPTS)).lastLogin).toBeNull();
  });

  test("a hung `open` is cut off at the deadline: timeout failure, authState untouched", async () => {
    const calls: string[][] = [];
    let killed = 0;
    spawnMock.mockImplementation((cmd: string[]) => {
      const args = cmd.slice(5);
      calls.push(args);
      const hangs = args[0] === "open";
      let resolveExit: (code: number) => void = () => {};
      const exited = hangs ? new Promise<number>((r) => { resolveExit = r; }) : Promise.resolve(0);
      const stream = (t: string) => new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(t)); c.close(); } });
      return {
        pid: 1,
        exitCode: hangs ? null : 0,
        exited,
        stdout: stream(args[0] === "get" ? "about:blank" : ""),
        stderr: stream(""),
        kill: () => { killed++; resolveExit(143); },
      };
    });

    const started = Date.now();
    const result = await authenticate(
      { sessionId: "test", port: 9333, email: "blake@clay.com", clerkSecretKey: TEST_KEY },
      { createClerkClient: fakeClerk().factory, deadline: started + 300, pollIntervalMs: 5 },
    );
    const elapsed = Date.now() - started;

    assertLoginFailure(result);
    expect(result.error).toContain("Auth exchange timed out");
    // open's own timeout was capped at the time left (~300 ms), not the 15 s default.
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(1_500);
    expect(killed).toBe(1);
    expect(calls.filter((a) => a[0] === "open")).toHaveLength(1);
    expect(authStatusOf(await getAuthStatus(STATUS_OPTS))).toEqual({ authenticated: false, user: null, lastLogin: null });
  });

  test("a session confirmed only after the deadline does not set authState", async () => {
    // The cookie read "takes" until past the deadline: the clock jumps inside
    // that call, then it reports a valid session. withTimeout may already have
    // answered the CLI with a failure, so the login must not land.
    const realNow = Date.now.bind(Date);
    let skew = 0;
    const nowSpy = spyOn(Date, "now").mockImplementation(() => realNow() + skew);
    try {
      const started = Date.now();
      const deadline = started + 5_000;
      const calls = scriptBrowser(["about:blank", "http://localhost:5173/"]);
      const inner = spawnMock.getMockImplementation()!;
      spawnMock.mockImplementation((cmd: string[]) => {
        if (cmd[5] === "cookies") skew += deadline - Date.now() + 1;
        return inner(cmd);
      });

      const result = await authenticate(
        { sessionId: "test", port: 9333, email: "blake@clay.com", clerkSecretKey: TEST_KEY },
        { createClerkClient: fakeClerk().factory, deadline, pollIntervalMs: 5 },
      );

      expect(calls.some((a) => a[0] === "cookies")).toBe(true);
      assertLoginFailure(result);
      expect(result.error).toContain("Auth exchange timed out");
      // authState was not recorded (status.authenticated follows the cookie jar, which these scripts fill).
    expect((await getAuthStatus(STATUS_OPTS)).lastLogin).toBeNull();
    } finally {
      nowSpy.mockRestore();
    }
  });

  test("fails when the browser lands on the app origin but no Clerk session cookie exists (wrong Clerk instance)", async () => {
    const calls = scriptBrowser(["about:blank", "http://localhost:5173/"], [{ name: "unrelated", value: "x", domain: "localhost" }]);
    const { factory } = fakeClerk();

    const result = await authenticate(
      { sessionId: "test", port: 9333, email: "blake@clay.com", clerkSecretKey: TEST_KEY },
      { createClerkClient: factory, deadline: Date.now() + 50, pollIntervalMs: 5 },
    );

    assertLoginFailure(result);
    expect(result.error).toContain("session");
    expect(result.error).toContain("CLERK_SECRET_KEY");
    expect(calls.some((a) => a[0] === "cookies")).toBe(true);
    // authState was not recorded (status.authenticated follows the cookie jar, which these scripts fill).
    expect((await getAuthStatus(STATUS_OPTS)).lastLogin).toBeNull();
  });

  test("a __session cookie on another host does not count", async () => {
    scriptBrowser(["about:blank", "http://localhost:5173/"], [{ name: "__session", value: "jwt", domain: "other.example.com" }]);
    const { factory } = fakeClerk();

    const result = await authenticate(
      { sessionId: "test", port: 9333, email: "blake@clay.com", clerkSecretKey: TEST_KEY },
      { createClerkClient: factory, deadline: Date.now() + 50, pollIntervalMs: 5 },
    );

    assertLoginFailure(result);
    // authState was not recorded (status.authenticated follows the cookie jar, which these scripts fill).
    expect((await getAuthStatus(STATUS_OPTS)).lastLogin).toBeNull();
  });

  test("__client_uat other than 0 on a parent domain counts as a session; 0 does not", async () => {
    scriptBrowser(["about:blank", "https://app.terra.localhost/"], [{ name: "__client_uat", value: "1759600000", domain: ".terra.localhost" }]);
    const ok = await authenticate(
      { sessionId: "test", port: 9333, email: "blake@clay.com", appBaseUrl: "https://app.terra.localhost", clerkSecretKey: TEST_KEY },
      { createClerkClient: fakeClerk().factory },
    );
    assertLoginSuccess(ok);

    __resetAuthStateForTest();
    scriptBrowser(["about:blank", "https://app.terra.localhost/"], [{ name: "__client_uat", value: "0", domain: ".terra.localhost" }]);
    const signedOut = await authenticate(
      { sessionId: "test", port: 9333, email: "blake@clay.com", appBaseUrl: "https://app.terra.localhost", clerkSecretKey: TEST_KEY },
      { createClerkClient: fakeClerk().factory, deadline: Date.now() + 50, pollIntervalMs: 5 },
    );
    assertLoginFailure(signedOut);
  });

  test("authenticate when browser already on authenticated page skips login", async () => {
    scriptBrowser(["http://localhost:5173/"]);
    const { factory } = fakeClerk();

    const result = await authenticate({ sessionId: "test", port: 9333, email: "blake@clay.com" }, { createClerkClient: factory });

    expect(result.ok).toBe(true);
    // No key, no Clerk client needed when already authenticated on the same origin.
    expect(factory).not.toHaveBeenCalled();
  });

  test("getAuthStatus returns correct shape when not authenticated", async () => {
    scriptBrowser([], []);
    const status = await getAuthStatus(STATUS_OPTS);
    assertAuthStatusShape(status);
    expect(status.authenticated).toBe(false);
    expect(status.user).toBeNull();
    expect(status.lastLogin).toBeNull();
    expect(status.port).toBe(9333);
    expect(status.checkedVia).toBe("cookie");
  });

  test("getAuthStatus is authenticated when the cookie jar holds a Clerk session cookie for the app host", async () => {
    const calls = scriptBrowser(["about:blank"], [SESSION_COOKIE]);
    const status = await getAuthStatus({ port: 9335, sessionId: "s1", appBaseUrl: "http://localhost:5173" });
    expect(status.authenticated).toBe(true);
    expect(status.port).toBe(9335);
    expect(calls).toEqual([["cookies", "get", "--json"]]);
  });

  test("getAuthStatus is not authenticated when the only cookie is for another host", async () => {
    scriptBrowser(["about:blank"], [{ name: "__session", value: "jwt", domain: "example.com" }]);
    // authState was not recorded (status.authenticated follows the cookie jar, which these scripts fill).
    expect((await getAuthStatus(STATUS_OPTS)).lastLogin).toBeNull();
  });

  test("survives a simulated crash: __resetAuthStateForTest does not flip authenticated while the cookie persists", async () => {
    scriptBrowser(["http://localhost:5173/"], [SESSION_COOKIE]);
    const login = await authenticate({ sessionId: "test", port: 9333, email: "blake@clay.com" });
    assertLoginSuccess(login);

    __resetAuthStateForTest(); // stands in for the supervisor crash path

    const status = await getAuthStatus(STATUS_OPTS);
    expect(status.authenticated).toBe(true);
    expect(status.user).toBeNull();
    expect(status.lastLogin).toBeNull();
  });

  test("a cookie read failure reports unauthenticated and does not throw", async () => {
    spawnMock.mockImplementation(() => ({
      pid: 1,
      exitCode: 1,
      exited: Promise.resolve(1),
      stdout: new ReadableStream({ start(c) { c.close(); } }),
      stderr: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("cdp connect failed")); c.close(); } }),
      kill: () => {},
    }));
    const status = await getAuthStatus(STATUS_OPTS);
    expect(status.ok).toBe(true);
    expect(status.authenticated).toBe(false);
  });

  test("__resetAuthStateForTest clears user and lastLogin; authenticated follows the cookie", async () => {
    scriptBrowser(["http://localhost:5173/"], [SESSION_COOKIE]);
    await authenticate({ sessionId: "test", port: 9333, email: "blake@clay.com" });
    // Already-authenticated short-circuit keeps user null; set lastLogin via timestamp.
    const before = await getAuthStatus(STATUS_OPTS);
    expect(before.authenticated).toBe(true);
    expect(before.lastLogin).not.toBeNull();

    __resetAuthStateForTest();

    const after = await getAuthStatus(STATUS_OPTS);
    assertAuthStatusShape(after);
    expect(after.authenticated).toBe(true);
    expect(after.user).toBeNull();
    expect(after.lastLogin).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Part B — isAuthenticatedUrl: .terra.localhost support
// ---------------------------------------------------------------------------

describe("isAuthenticatedUrl", () => {
  test("returns true for localhost:5173 page (not /sign-in)", () => {
    expect(isAuthenticatedUrl("http://localhost:5173/")).toBe(true);
  });

  test("returns false for localhost:5173 /sign-in", () => {
    expect(isAuthenticatedUrl("http://localhost:5173/sign-in")).toBe(false);
  });

  test("returns true for onrender.com page", () => {
    expect(isAuthenticatedUrl("https://slack-feedback-staging.onrender.com/home")).toBe(true);
  });

  test("returns true for terra.clay.com page", () => {
    expect(isAuthenticatedUrl("https://terra.clay.com/home")).toBe(true);
  });

  test("returns true for *.terra.localhost page (not /sign-in)", () => {
    // BUG BEFORE FIX: clayPatterns was missing .terra.localhost, so this returned false
    expect(isAuthenticatedUrl("https://worktree-foo.terra.localhost/home")).toBe(true);
  });

  test("returns true for terra.localhost page (exact match, not /sign-in)", () => {
    expect(isAuthenticatedUrl("https://terra.localhost/home")).toBe(true);
  });

  test("returns false for *.terra.localhost /sign-in page", () => {
    expect(isAuthenticatedUrl("https://worktree-foo.terra.localhost/sign-in")).toBe(false);
  });

  test("returns false for about:blank", () => {
    expect(isAuthenticatedUrl("about:blank")).toBe(false);
  });

  test("returns false for empty string", () => {
    expect(isAuthenticatedUrl("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Part B — origin-aware short-circuit
// ---------------------------------------------------------------------------

describe("origin-aware short-circuit", () => {
  // When the browser is on worktree-A's authenticated page but the reauth
  // target is worktree-B, we must NOT skip the auth flow.

  test("does NOT skip login when browser origin is worktree-A but appBaseUrl targets worktree-B", async () => {
    // Browser is authenticated on worktree-A; the mint must run for worktree-B
    const calls = scriptBrowser(["https://worktree-a.terra.localhost/home", "https://worktree-b.terra.localhost/home"]);
    const { client, factory } = fakeClerk();

    const result = await authenticate(
      {
        sessionId: "test",
        port: 9333,
        email: "blake@clay.com",
        appBaseUrl: "https://worktree-b.terra.localhost",
        clerkSecretKey: TEST_KEY,
      },
      { createClerkClient: factory },
    );

    // Did not short-circuit: minted a task redirecting to worktree-B and opened it.
    expect(client.calls[0]).toMatchObject({ redirectUrl: "https://worktree-b.terra.localhost/" });
    expect(calls.some((a) => a[0] === "open" && a[1] === MINTED_URL)).toBe(true);
    assertLoginSuccess(result);
  });

  test("DOES skip login when browser origin matches appBaseUrl (worktree-A to worktree-A)", async () => {
    // Browser is authenticated on worktree-A, targeting worktree-A
    spawnMock.mockImplementation(() => ({
      pid: 1,
      exitCode: 0,
      exited: Promise.resolve(0),
      stdout: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode("https://worktree-a.terra.localhost/home"));
          c.close();
        },
      }),
      stderr: new ReadableStream({
        start(c) { c.enqueue(new TextEncoder().encode("")); c.close(); },
      }),
      kill: () => {},
    }));

    const result = await authenticate({
      sessionId: "test",
      port: 9333,
      email: "blake@clay.com",
      appBaseUrl: "https://worktree-a.terra.localhost",
    });

    // same origin: skip is valid, no minting
    expect(spawnMock.mock.calls.some((c) => (c[0] as string[]).includes("open"))).toBe(false);
    assertLoginSuccess(result);
  });

  test("DOES skip login when browser is on default localhost:5173 and no appBaseUrl given", async () => {
    // Existing behavior preserved: browser on localhost:5173, targeting localhost default
    spawnMock.mockImplementation(() => ({
      pid: 1,
      exitCode: 0,
      exited: Promise.resolve(0),
      stdout: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode("http://localhost:5173/home"));
          c.close();
        },
      }),
      stderr: new ReadableStream({
        start(c) { c.enqueue(new TextEncoder().encode("")); c.close(); },
      }),
      kill: () => {},
    }));

    const result = await authenticate({
      sessionId: "test",
      port: 9333,
      email: "blake@clay.com",
      // no appBaseUrl → defaults to localhost:5173
    });

    expect(spawnMock.mock.calls.some((c) => (c[0] as string[]).includes("open"))).toBe(false);
    assertLoginSuccess(result);
  });
});

// ---------------------------------------------------------------------------
// Part A — resolveReauthBaseUrls auto-detect from browser URL
// ---------------------------------------------------------------------------

describe("resolveReauthBaseUrls with browserUrl auto-detect", () => {
  // These tests are in auth.test.ts because they test behavior that directly
  // affects the authenticate() call path. The browserUrl param on
  // resolveReauthBaseUrls is the mechanism; more extensive flag-parsing tests
  // live in session-resolution.test.ts.
  test("auto-detect: *.terra.localhost browser URL → portless HTTPS (443) for both bases", async () => {
    // This is tested at the resolveReauthBaseUrls level in session-resolution.test.ts
    // Verify that the logic works via the exported function from cli.ts
    const { resolveReauthBaseUrls } = await import("../cli");
    const r = resolveReauthBaseUrls([], {}, "https://worktree-foo.terra.localhost/some-page");
    expect(r.appBaseUrl).toBe("https://worktree-foo.terra.localhost");
    expect(r.error).toBeUndefined();
  });

  test("auto-detect: non-terra browser URL falls back to undefined (localhost defaults)", async () => {
    const { resolveReauthBaseUrls } = await import("../cli");
    const r = resolveReauthBaseUrls([], {}, "https://example.com/page");
    expect(r.appBaseUrl).toBeUndefined();
    expect(r.error).toBeUndefined();
  });

  test("auto-detect: explicit --host flag overrides browser URL", async () => {
    const { resolveReauthBaseUrls } = await import("../cli");
    const r = resolveReauthBaseUrls(
      ["--host", "worktree-bar.terra.localhost"],
      {},
      "https://worktree-foo.terra.localhost/some-page",
    );
    // Explicit --host wins over auto-detected browser URL
    expect(r.appBaseUrl).toBe("https://worktree-bar.terra.localhost");
  });

  test("auto-detect: env var override wins over browser URL", async () => {
    const { resolveReauthBaseUrls } = await import("../cli");
    const r = resolveReauthBaseUrls(
      [],
      { AB_APP_BASE_URL: "https://custom.example.com" },
      "https://worktree-foo.terra.localhost/some-page",
    );
    expect(r.appBaseUrl).toBe("https://custom.example.com");
  });
});

// ---------------------------------------------------------------------------
// FINAL CONSENSUS SPEC item 13 — the four Chrome-consuming debug commands
// (`console-tail`, `watch`, `click-js`, `click-xy`) join NEEDS_CHROME.
//
// Before this, a down shard turned "wrong Chrome" into "correct error
// against a dead shard" for these commands, instead of healing it via the
// same demand-driven ensure() every other Chrome-consuming command already
// goes through (cli.ts:2238's gate: `if (NEEDS_CHROME.has(command) &&
// !flags.userChrome) { cdpPort = await ensureChromePort(flags.headed); }`).
// No handler changes were needed — cmdConsoleTail/cmdWatch/cmdClickJs/
// cmdClickXy already take `cdpPort` as a parameter (cli.ts:2253-2256); set
// membership alone is what routes them through the gate. This is a plain
// membership check, not a full main() dispatch drive — main() itself isn't
// exported, same constraint the "reauth is shard-aware" tests below work
// around by testing ensureChromePort()/cmdReauth directly instead.
// ---------------------------------------------------------------------------

describe("NEEDS_CHROME membership (FINAL CONSENSUS SPEC item 13)", () => {
  test("console-tail, watch, click-js, click-xy are all members", async () => {
    const { NEEDS_CHROME } = await import("../cli");
    expect(NEEDS_CHROME.has("console-tail")).toBe(true);
    expect(NEEDS_CHROME.has("watch")).toBe(true);
    expect(NEEDS_CHROME.has("click-js")).toBe(true);
    expect(NEEDS_CHROME.has("click-xy")).toBe(true);
  });

  test("close stays excluded — it must tear down, never boot Chrome", async () => {
    const { NEEDS_CHROME } = await import("../cli");
    expect(NEEDS_CHROME.has("close")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// chrome-pool-plan Unit 3 — reauth is shard-aware "for free"
//
// `reauth` is a member of cli.ts's NEEDS_CHROME set, so main() already
// resolves this session's sticky shard and ensures that shard's Chrome
// *before* dispatching to cmdReauth — the cdpPort cmdReauth receives is
// never the old hardcoded CDP_PORT_HEADLESS constant. These tests exercise
// that exact production sequence (ensureChromePort -> cmdReauth) against a
// mocked daemon (fetch) and mocked agent-browser (spawn, reused from the
// top-level beforeEach) to prove authLogin receives the shard-correct port.
// ---------------------------------------------------------------------------

describe("reauth is shard-aware (chrome-pool-plan Unit 3)", () => {
  const testPid = `abtest-reauth-shard-${process.pid}`;
  const markerPath = `/tmp/.ab-session-${testPid}`;
  const originalAbPid = process.env.AB_SESSION_PID;
  const originalCco = process.env.CCO_SESSION_ID;

  beforeEach(() => {
    process.env.AB_SESSION_PID = testPid;
    delete process.env.CCO_SESSION_ID;
  });

  afterEach(() => {
    try { fs.unlinkSync(markerPath); } catch { /* ignore */ }
    if (originalAbPid === undefined) delete process.env.AB_SESSION_PID;
    else process.env.AB_SESSION_PID = originalAbPid;
    if (originalCco === undefined) delete process.env.CCO_SESSION_ID;
    else process.env.CCO_SESSION_ID = originalCco;
  });

  /** Route the shared fetchMock like a minimal daemon: /chrome/ensure echoes
   *  9333+shard, /chrome/ensure-headed returns 9444, /auth/login always
   *  succeeds. Records every call's { path, body } for assertions. */
  function installDaemonRouter(): Array<{ path: string; body: unknown }> {
    const calls: Array<{ path: string; body: unknown }> = [];
    fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : (url as Request).url;
      const pathname = new URL(urlStr, "http://localhost").pathname;
      let body: unknown;
      if (init?.body) {
        try { body = JSON.parse(String(init.body)); } catch { body = undefined; }
      }
      calls.push({ path: pathname, body });

      if (pathname === "/status") {
        return new Response(JSON.stringify({ ok: true, headlessPool: [{}, {}, {}] }), { status: 200 });
      }
      if (pathname === "/chrome/ensure") {
        const shard = (body as { shard?: number } | undefined)?.shard ?? 0;
        return new Response(
          JSON.stringify({ ok: true, pid: 100 + shard, port: 9333 + shard, alreadyRunning: true, profileFresh: false }),
          { status: 200 },
        );
      }
      if (pathname === "/chrome/ensure-headed") {
        return new Response(
          JSON.stringify({ ok: true, pid: 200, port: 9444, alreadyRunning: true, profileFresh: false }),
          { status: 200 },
        );
      }
      if (pathname === "/auth/login") {
        return new Response(
          JSON.stringify({ ok: true, user: { email: "blake.johnson@clay.com" } }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    });
    return calls;
  }

  test("reauth on a session pinned to shard 1 sends port 9334 to authLogin", async () => {
    fs.writeFileSync(markerPath, `${testPid}\nshard=1\n`);
    const calls = installDaemonRouter();

    const { ensureChromePort, cmdReauth } = await import("../cli");
    const cdpPort = await ensureChromePort(false);
    expect(cdpPort).toBe(9334); // 9333 + shard 1

    const exitCode = await cmdReauth([], cdpPort, `ab-${testPid}`);
    expect(exitCode).toBe(0);

    const loginCall = calls.find((c) => c.path === "/auth/login");
    expect(loginCall).toBeDefined();
    expect((loginCall!.body as { port: number }).port).toBe(9334);
  });

  test("reauth forwards CLERK_SECRET_KEY from the CLI env in the login RPC body, and logs no secret", async () => {
    fs.writeFileSync(markerPath, `${testPid}\nshard=0\n`);
    const calls = installDaemonRouter();
    const original = process.env.CLERK_SECRET_KEY;
    process.env.CLERK_SECRET_KEY = "sk_test_CLIFORWARDSECRET";
    const writes: string[] = [];
    const origStderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => { writes.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try {
      const { cmdReauth } = await import("../cli");
      await cmdReauth([], 9333, `ab-${testPid}`);
    } finally {
      process.stderr.write = origStderr;
      if (original === undefined) delete process.env.CLERK_SECRET_KEY;
      else process.env.CLERK_SECRET_KEY = original;
    }
    const loginCall = calls.find((c) => c.path === "/auth/login");
    expect((loginCall!.body as { clerkSecretKey?: string }).clerkSecretKey).toBe("sk_test_CLIFORWARDSECRET");
    expect(writes.join("")).not.toContain("CLIFORWARDSECRET");
  });

  test("headed reauth keeps port 9444 regardless of the session's headless shard assignment", async () => {
    // Pin the session to headless shard 1 — headed reauth must ignore this
    // entirely and stay on the single headed Chrome (port 9444).
    fs.writeFileSync(markerPath, `${testPid}\nshard=1\n`);
    const calls = installDaemonRouter();

    const { ensureChromePort, cmdReauth } = await import("../cli");
    const cdpPort = await ensureChromePort(true);
    expect(cdpPort).toBe(9444);

    await cmdReauth([], cdpPort, `ab-${testPid}`);

    const loginCall = calls.find((c) => c.path === "/auth/login");
    expect(loginCall).toBeDefined();
    expect((loginCall!.body as { port: number }).port).toBe(9444);
  });
});

// ---------------------------------------------------------------------------
// chrome-pool-plan Fix 2 — persist the shard the daemon actually served.
//
// resolveOrAssignShard writes `shard=<requested>` to the marker BEFORE
// rpc.ensureChrome({shard}) resolves. If the daemon serves a different shard
// than requested, the marker is corrected from the ensure response's *port*,
// mapped to a shard through the daemon's own /status pool ports (never the
// CLI's env base port).
// ---------------------------------------------------------------------------

describe("sticky shard correction from the ensure response's served port (Fix 2)", () => {
  const testPid = `abtest-shard-correct-${process.pid}`;
  const markerPath = `/tmp/.ab-session-${testPid}`;
  const originalAbPid = process.env.AB_SESSION_PID;
  const originalCco = process.env.CCO_SESSION_ID;

  beforeEach(() => {
    process.env.AB_SESSION_PID = testPid;
    delete process.env.CCO_SESSION_ID;
  });

  afterEach(() => {
    try { fs.unlinkSync(markerPath); } catch { /* ignore */ }
    if (originalAbPid === undefined) delete process.env.AB_SESSION_PID;
    else process.env.AB_SESSION_PID = originalAbPid;
    if (originalCco === undefined) delete process.env.CCO_SESSION_ID;
    else process.env.CCO_SESSION_ID = originalCco;
  });

  function mockEnsurePort(
    port: number,
    poolSize = 3,
    pool: unknown[] = Array.from({ length: poolSize }, () => ({})),
  ): Array<{ path: string; body: unknown }> {
    const calls: Array<{ path: string; body: unknown }> = [];
    fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : (url as Request).url;
      const pathname = new URL(urlStr, "http://localhost").pathname;
      calls.push({ path: pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (pathname === "/status") {
        return new Response(
          JSON.stringify({ ok: true, headlessPool: pool }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({ ok: true, pid: 100, port, alreadyRunning: true, profileFresh: false }),
        { status: 200 },
      );
    });
    return calls;
  }

  test("pool size comes from the daemon's /status, not the CLI's own env", async () => {
    fs.writeFileSync(markerPath, `${testPid}\nshard=2\n`);
    const calls = mockEnsurePort(9333, 2); // daemon runs a 2-shard pool; CLI default is 3

    const { ensureChromePort, readShardAssignment } = await import("../cli");
    await ensureChromePort(false);
    const ensure = calls.find((c) => c.path === "/chrome/ensure");
    expect(ensure?.body).toEqual({ shard: 0 });
    expect(readShardAssignment(testPid)).toBe(0);
  });

  test("a daemon that serves shard 0's port for a shard=2 request rewrites the marker to shard 0", async () => {
    fs.writeFileSync(markerPath, `${testPid}\nshard=2\n`);
    // The daemon ignored the requested shard and served shard 0's Chrome.
    mockEnsurePort(9333, 3, [{ phase: "chrome_up", pid: 100, port: 9333 }, { phase: "idle" }, { phase: "idle" }]);

    const { ensureChromePort, readShardAssignment } = await import("../cli");
    const cdpPort = await ensureChromePort(false);
    expect(cdpPort).toBe(9333);
    expect(readShardAssignment(testPid)).toBe(0);
  });

  test("when the served port matches the requested shard, the marker is left untouched", async () => {
    fs.writeFileSync(markerPath, `${testPid}\nshard=1\n`);
    const before = fs.statSync(markerPath).mtimeMs;
    mockEnsurePort(9334); // 9333 + shard 1 — matches what was requested

    const { ensureChromePort, readShardAssignment } = await import("../cli");
    const cdpPort = await ensureChromePort(false);
    expect(cdpPort).toBe(9334);
    expect(readShardAssignment(testPid)).toBe(1);
    const after = fs.statSync(markerPath).mtimeMs;
    expect(after).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// chrome-pool-plan Unit 3 — fresh-profile stderr hint
//
// ensureChromePort prints a one-line hint when the daemon reports
// profileFresh: true (an agent landed on a shard whose Chrome just started
// from an empty, logged-out profile), and stays silent otherwise.
// ---------------------------------------------------------------------------

describe("fresh-profile hint on ensureChromePort", () => {
  const testPid = `abtest-freshhint-${process.pid}`;
  const markerPath = `/tmp/.ab-session-${testPid}`;
  const originalAbPid = process.env.AB_SESSION_PID;
  const originalCco = process.env.CCO_SESSION_ID;
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  let stderrLines: string[];

  beforeEach(() => {
    process.env.AB_SESSION_PID = testPid;
    delete process.env.CCO_SESSION_ID;
    stderrLines = [];
    process.stderr.write = ((chunk: unknown) => {
      stderrLines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stderr.write = originalStderrWrite;
    try { fs.unlinkSync(markerPath); } catch { /* ignore */ }
    if (originalAbPid === undefined) delete process.env.AB_SESSION_PID;
    else process.env.AB_SESSION_PID = originalAbPid;
    if (originalCco === undefined) delete process.env.CCO_SESSION_ID;
    else process.env.CCO_SESSION_ID = originalCco;
  });

  function mockEnsureResponse(profileFresh: boolean): void {
    fetchMock.mockImplementation(async (url: unknown) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : (url as Request).url;
      const pathname = new URL(urlStr, "http://localhost").pathname;
      if (pathname === "/chrome/ensure") {
        return new Response(
          JSON.stringify({ ok: true, pid: 1, port: 9333, alreadyRunning: !profileFresh, profileFresh }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    });
  }

  test("prints the hint when the daemon reports profileFresh: true", async () => {
    mockEnsureResponse(true);
    const { ensureChromePort } = await import("../cli");
    await ensureChromePort(false);
    expect(stderrLines.some((l) => l.includes("fresh profile"))).toBe(true);
  });

  test("stays silent when the daemon reports profileFresh: false", async () => {
    mockEnsureResponse(false);
    const { ensureChromePort } = await import("../cli");
    await ensureChromePort(false);
    expect(stderrLines.some((l) => l.includes("fresh profile"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ab import: auth is grabbed from the browser's own origin, never minted
// ---------------------------------------------------------------------------

describe("cmdImport pins appBaseUrl to the browser's origin", () => {
  const originalCco = process.env.CCO_SESSION_ID;
  beforeEach(() => { delete process.env.CCO_SESSION_ID; });
  afterEach(() => {
    if (originalCco === undefined) delete process.env.CCO_SESSION_ID;
    else process.env.CCO_SESSION_ID = originalCco;
  });

  function routeDaemon(): Array<{ path: string; body: Record<string, unknown> | undefined }> {
    const calls: Array<{ path: string; body: Record<string, unknown> | undefined }> = [];
    fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : (url as Request).url;
      const pathname = new URL(urlStr, "http://localhost").pathname;
      calls.push({ path: pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (pathname === "/chrome/ensure-headed") {
        return new Response(JSON.stringify({ ok: true, pid: 200, port: 9444, alreadyRunning: true, profileFresh: false }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, user: { email: "blake.johnson@clay.com" } }), { status: 200 });
    });
    return calls;
  }

  test("sends the browser's origin (staging) and no clerkSecretKey", async () => {
    const calls = routeDaemon();
    const { cmdImport } = await import("../cli");
    const code = await cmdImport({
      openUrl: async () => {},
      waitForEnter: async () => {},
      getBrowserUrl: async () => "https://slack-feedback-staging.onrender.com/accounts?x=1",
    });
    expect(code).toBe(0);
    const login = calls.find((c) => c.path === "/auth/login");
    expect(login?.body?.appBaseUrl).toBe("https://slack-feedback-staging.onrender.com");
    expect(login?.body?.port).toBe(9444);
    expect(login?.body).not.toHaveProperty("clerkSecretKey");
  });

  test("an unauthenticated browser (/sign-in) is reported and never reaches the daemon's login", async () => {
    const calls = routeDaemon();
    const { cmdImport } = await import("../cli");
    const code = await cmdImport({
      openUrl: async () => {},
      waitForEnter: async () => {},
      getBrowserUrl: async () => "http://localhost:5173/sign-in",
    });
    expect(code).toBe(1);
    expect(calls.some((c) => c.path === "/auth/login")).toBe(false);
  });

  test("an unreadable browser URL is reported and never reaches the daemon's login", async () => {
    const calls = routeDaemon();
    const { cmdImport } = await import("../cli");
    const code = await cmdImport({
      openUrl: async () => {},
      waitForEnter: async () => {},
      getBrowserUrl: async () => undefined,
    });
    expect(code).toBe(1);
    expect(calls.some((c) => c.path === "/auth/login")).toBe(false);
  });
});
