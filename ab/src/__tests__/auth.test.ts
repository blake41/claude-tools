/**
 * Auth contract tests.
 *
 * Tests the authenticate() flow against an injected fake Clerk client and mocked agent-browser responses (no network).
 * Verifies the shapes that cli.ts reads: { ok, user: { slackUserId, email }, error }.
 */
import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import * as fs from "fs";
import { resetAuthState, getAuthStatus, authenticate, isAuthenticatedUrl } from "../auth";
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
  resetAuthState();
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
  resetAuthState();
});

// ---------------------------------------------------------------------------
// Shape helpers
// ---------------------------------------------------------------------------

function assertLoginSuccess(result: AuthLoginResponse): void {
  expect(result.ok).toBe(true);
  // cli.ts reads result.user?.email and result.user?.slackUserId
  if (result.user) {
    expect(typeof result.user.email).toBe("string");
    // slackUserId is optional now: reauth identifies by email.
    if (result.user.slackUserId !== undefined) expect(typeof result.user.slackUserId).toBe("string");
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
  // user is { slackUserId, email } | null
  if (status.user !== null) {
    if (status.user.slackUserId !== undefined) expect(typeof status.user.slackUserId).toBe("string");
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

interface FakeClient extends AgentTaskClient {
  calls: Array<Record<string, unknown>>;
}

function fakeClerk(opts: { url?: string; throws?: unknown } = {}): { client: FakeClient; factory: ReturnType<typeof mock> } {
  const calls: Array<Record<string, unknown>> = [];
  const client: FakeClient = {
    calls,
    agentTasks: {
      create: async (params) => {
        calls.push(params as unknown as Record<string, unknown>);
        if (opts.throws) throw opts.throws;
        return { agentId: "agent_1", taskId: "task_1", url: opts.url ?? MINTED_URL };
      },
    },
  };
  const factory = mock((_secretKey: string) => client);
  return { client, factory };
}

/** Mock agent-browser: record args per call, answer `get url` from `urls` in order. */
function scriptBrowser(urls: string[]): string[][] {
  const calls: string[][] = [];
  let urlIdx = 0;
  spawnMock.mockImplementation((cmd: string[]) => {
    const args = cmd.slice(5); // after: agent-browser --session <id> --cdp <port>
    calls.push(args);
    const stdout = args[0] === "get" && args[1] === "url" ? (urls[Math.min(urlIdx++, urls.length - 1)] ?? "") : "";
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

function allLogs(): string {
  return JSON.stringify(getRecentLogs());
}

describe("auth contract", () => {
  test("authenticate without email or slackUserId returns failure telling the user to pass an email", async () => {
    scriptBrowser(["about:blank"]);
    const { factory } = fakeClerk();

    const result = await authenticate({ sessionId: "test", port: 9333, clerkSecretKey: TEST_KEY }, { createClerkClient: factory });

    assertLoginFailure(result);
    expect(result.error).toContain("email");
    expect(factory).not.toHaveBeenCalled();
  });

  test("slackUserId alone is rejected with a clear 'pass an email' error (no Slack lookup)", async () => {
    scriptBrowser(["about:blank"]);
    const { factory } = fakeClerk();

    const result = await authenticate(
      { sessionId: "test", port: 9333, slackUserId: "U0839QH8MMY", clerkSecretKey: TEST_KEY },
      { createClerkClient: factory },
    );

    assertLoginFailure(result);
    expect(result.error).toContain("slackUserId");
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

  test("falls back to the daemon's CLERK_SECRET_KEY when the request omits it", async () => {
    const original = process.env.CLERK_SECRET_KEY;
    process.env.CLERK_SECRET_KEY = TEST_KEY;
    try {
      scriptBrowser(["about:blank", "http://localhost:5173/"]);
      const { factory } = fakeClerk();
      const result = await authenticate({ sessionId: "test", port: 9333, email: "blake@clay.com" }, { createClerkClient: factory });
      assertLoginSuccess(result);
      expect(factory).toHaveBeenCalledWith(TEST_KEY);
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
    expect(calls.some((a) => a[0] === "wait" && a.includes("networkidle"))).toBe(true);
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

  test("secret key and ticket never appear in logs or errors when Clerk fails with them in the message", async () => {
    scriptBrowser(["about:blank"]);
    const { factory } = fakeClerk({ throws: new Error(`boom ${TEST_KEY} ${MINTED_URL}`) });

    const result = await authenticate(
      { sessionId: "test", port: 9333, email: "blake@clay.com", clerkSecretKey: TEST_KEY },
      { createClerkClient: factory },
    );

    assertLoginFailure(result);
    const blob = allLogs() + (result.error ?? "");
    expect(blob).not.toContain("UNITTESTSECRET");
    expect(blob).not.toContain("TICKETSECRET");
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

  test("times out when the browser never lands on the app origin", async () => {
    scriptBrowser(["about:blank", "https://fake-instance.clerk.accounts.dev/v1/tickets/accept"]);
    const { factory } = fakeClerk();

    const result = await authenticate(
      { sessionId: "test", port: 9333, email: "blake@clay.com", clerkSecretKey: TEST_KEY },
      { createClerkClient: factory, pollTimeoutMs: 50, pollIntervalMs: 5 },
    );

    assertLoginFailure(result);
    expect(result.error).toContain("timed out");
  });

  test("authenticate when browser already on authenticated page skips login", async () => {
    scriptBrowser(["http://localhost:5173/"]);
    const { factory } = fakeClerk();

    const result = await authenticate({ sessionId: "test", port: 9333, email: "blake@clay.com" }, { createClerkClient: factory });

    expect(result.ok).toBe(true);
    // No key, no Clerk client needed when already authenticated on the same origin.
    expect(factory).not.toHaveBeenCalled();
  });

  test("getAuthStatus returns correct shape when not authenticated", () => {
    const status = getAuthStatus();
    assertAuthStatusShape(status);
    expect(status.authenticated).toBe(false);
    expect(status.user).toBeNull();
    expect(status.lastLogin).toBeNull();
  });

  test("resetAuthState clears authenticated state", async () => {
    // First authenticate
    spawnMock.mockImplementation(() => ({
      pid: 1,
      exitCode: 0,
      exited: Promise.resolve(0),
      stdout: new ReadableStream({
        start(c) { c.enqueue(new TextEncoder().encode("http://localhost:5173/")); c.close(); },
      }),
      stderr: new ReadableStream({
        start(c) { c.enqueue(new TextEncoder().encode("")); c.close(); },
      }),
      kill: () => {},
    }));

    await authenticate({ sessionId: "test", port: 9333, email: "blake@clay.com" });

    const before = getAuthStatus();
    expect(before.authenticated).toBe(true);

    resetAuthState();

    const after = getAuthStatus();
    assertAuthStatusShape(after);
    expect(after.authenticated).toBe(false);
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
    expect(r.apiBaseUrl).toBe("https://worktree-foo.terra.localhost");
    expect(r.appBaseUrl).toBe("https://worktree-foo.terra.localhost");
    expect(r.error).toBeUndefined();
  });

  test("auto-detect: non-terra browser URL falls back to undefined (localhost defaults)", async () => {
    const { resolveReauthBaseUrls } = await import("../cli");
    const r = resolveReauthBaseUrls([], {}, "https://example.com/page");
    expect(r.apiBaseUrl).toBeUndefined();
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
    expect(r.apiBaseUrl).toBe("https://worktree-bar.terra.localhost");
    expect(r.appBaseUrl).toBe("https://worktree-bar.terra.localhost");
  });

  test("auto-detect: env var override wins over browser URL", async () => {
    const { resolveReauthBaseUrls } = await import("../cli");
    const r = resolveReauthBaseUrls(
      [],
      { AB_API_BASE_URL: "https://custom.example.com", AB_APP_BASE_URL: "https://custom.example.com" },
      "https://worktree-foo.terra.localhost/some-page",
    );
    expect(r.apiBaseUrl).toBe("https://custom.example.com");
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
          JSON.stringify({ ok: true, user: { email: "blake.johnson@clay.com", slackUserId: "U08M03CDY73" } }),
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
// rpc.ensureChrome({shard}) resolves. A pre-pool daemon ignores the `shard`
// field entirely and always serves its single Chrome on port 9333, so the
// marker would keep lying about where the tab actually lives unless it gets
// corrected from the ensure response's *port* (the daemon's actual source of
// truth) once that response arrives.
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

  function mockEnsurePort(port: number): void {
    fetchMock.mockImplementation(async () =>
      new Response(
        JSON.stringify({ ok: true, pid: 100, port, alreadyRunning: true, profileFresh: false }),
        { status: 200 },
      ),
    );
  }

  test("a pre-pool daemon that always serves 9333 rewrites a shard=2 marker down to shard 0", async () => {
    fs.writeFileSync(markerPath, `${testPid}\nshard=2\n`);
    mockEnsurePort(9333); // daemon ignored the requested shard, served its one Chrome

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
