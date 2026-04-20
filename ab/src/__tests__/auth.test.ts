/**
 * Auth contract tests.
 *
 * Tests the authenticate() flow against mocked HTTP and agent-browser responses.
 * Verifies the shapes that cli.ts reads: { ok, user: { slackUserId, email }, error }.
 */
import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { resetAuthState, getAuthStatus, authenticate } from "../auth";
import type { AuthLoginResponse, AuthStatusResponse } from "../types";

// ---------------------------------------------------------------------------
// Mock setup
// ---------------------------------------------------------------------------

// We need to mock both global fetch (for dev-login POST) and Bun.spawn (for agent-browser).
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
    expect(typeof result.user.slackUserId).toBe("string");
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
    expect(typeof status.user.slackUserId).toBe("string");
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

describe("auth contract", () => {
  test("authenticate with missing slackUserId returns failure with descriptive error", async () => {
    // agent-browser "get url" returns about:blank (not authenticated)
    spawnMock.mockImplementation(() => ({
      pid: 1,
      exitCode: 0,
      exited: Promise.resolve(0),
      stdout: new ReadableStream({
        start(c) { c.enqueue(new TextEncoder().encode("about:blank")); c.close(); },
      }),
      stderr: new ReadableStream({
        start(c) { c.enqueue(new TextEncoder().encode("")); c.close(); },
      }),
      kill: () => {},
    }));

    const result = await authenticate({
      sessionId: "test",
      port: 9333,
      // No slackUserId
    });

    assertLoginFailure(result);
    expect(result.error).toContain("slackUserId");
  });

  test("authenticate with unreachable dev server returns failure", async () => {
    // agent-browser "get url" returns about:blank
    spawnMock.mockImplementation(() => ({
      pid: 1,
      exitCode: 0,
      exited: Promise.resolve(0),
      stdout: new ReadableStream({
        start(c) { c.enqueue(new TextEncoder().encode("about:blank")); c.close(); },
      }),
      stderr: new ReadableStream({
        start(c) { c.enqueue(new TextEncoder().encode("")); c.close(); },
      }),
      kill: () => {},
    }));

    // fetch throws ECONNREFUSED
    fetchMock.mockImplementation(() => {
      throw new Error("fetch failed: ECONNREFUSED");
    });

    const result = await authenticate({
      sessionId: "test",
      port: 9333,
      slackUserId: "U0839QH8MMY",
      apiBaseUrl: "http://localhost:9999",
    });

    assertLoginFailure(result);
    expect(result.error).toContain("unreachable");
  });

  test("authenticate with valid dev-login response returns success shape", async () => {
    let callCount = 0;

    // Mock agent-browser calls in sequence:
    //   1. "get url" → about:blank (not authenticated)
    //   2. "open <exchange>" → ok
    //   3. "wait --load networkidle" → ok
    //   4. "get url" → http://localhost:5173/ (authenticated, not /dev-login)
    spawnMock.mockImplementation(() => {
      callCount++;
      let stdout = "";
      if (callCount === 1) stdout = "about:blank";
      else if (callCount === 4) stdout = "http://localhost:5173/";

      return {
        pid: 1,
        exitCode: 0,
        exited: Promise.resolve(0),
        stdout: new ReadableStream({
          start(c) { c.enqueue(new TextEncoder().encode(stdout)); c.close(); },
        }),
        stderr: new ReadableStream({
          start(c) { c.enqueue(new TextEncoder().encode("")); c.close(); },
        }),
        kill: () => {},
      };
    });

    // dev-login returns a token
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ token: "test-ticket-123", email: "blake@clay.com", exchangeUrl: "http://localhost:5173/dev-login?ticket=test-ticket-123" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    const result = await authenticate({
      sessionId: "test",
      port: 9333,
      slackUserId: "U0839QH8MMY",
    });

    assertLoginSuccess(result);
    expect(result.user).toBeDefined();
    expect(result.user!.slackUserId).toBe("U0839QH8MMY");
    expect(result.user!.email).toBe("blake@clay.com");
  });

  test("authenticate when browser already on authenticated page skips login", async () => {
    // agent-browser "get url" returns authenticated URL
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

    const result = await authenticate({
      sessionId: "test",
      port: 9333,
      slackUserId: "U0839QH8MMY",
    });

    assertLoginSuccess(result);
    // fetch should NOT have been called (no dev-login needed)
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("dev-login returning missing token returns failure", async () => {
    // agent-browser "get url" returns about:blank
    spawnMock.mockImplementation(() => ({
      pid: 1,
      exitCode: 0,
      exited: Promise.resolve(0),
      stdout: new ReadableStream({
        start(c) { c.enqueue(new TextEncoder().encode("about:blank")); c.close(); },
      }),
      stderr: new ReadableStream({
        start(c) { c.enqueue(new TextEncoder().encode("")); c.close(); },
      }),
      kill: () => {},
    }));

    // dev-login returns 200 but no token
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ email: "blake@clay.com" }), // missing token!
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    const result = await authenticate({
      sessionId: "test",
      port: 9333,
      slackUserId: "U0839QH8MMY",
    });

    assertLoginFailure(result);
    expect(result.error).toContain("missing token");
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

    await authenticate({ sessionId: "test", port: 9333, slackUserId: "U0839QH8MMY" });

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
