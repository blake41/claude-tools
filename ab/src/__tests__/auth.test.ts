/**
 * Auth contract tests.
 *
 * Tests the authenticate() flow against mocked HTTP and agent-browser responses.
 * Verifies the shapes that cli.ts reads: { ok, user: { slackUserId, email }, error }.
 */
import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { resetAuthState, getAuthStatus, authenticate, isAuthenticatedUrl } from "../auth";
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

// ---------------------------------------------------------------------------
// Part B — isAuthenticatedUrl: .terra.localhost support
// ---------------------------------------------------------------------------

describe("isAuthenticatedUrl", () => {
  test("returns true for localhost:5173 page (not /dev-login)", () => {
    expect(isAuthenticatedUrl("http://localhost:5173/")).toBe(true);
  });

  test("returns false for localhost:5173 /dev-login", () => {
    expect(isAuthenticatedUrl("http://localhost:5173/dev-login")).toBe(false);
  });

  test("returns true for onrender.com page", () => {
    expect(isAuthenticatedUrl("https://slack-feedback-staging.onrender.com/home")).toBe(true);
  });

  test("returns true for terra.clay.com page", () => {
    expect(isAuthenticatedUrl("https://terra.clay.com/home")).toBe(true);
  });

  test("returns true for *.terra.localhost page (not /dev-login)", () => {
    // BUG BEFORE FIX: clayPatterns was missing .terra.localhost, so this returned false
    expect(isAuthenticatedUrl("https://worktree-foo.terra.localhost/home")).toBe(true);
  });

  test("returns true for terra.localhost page (exact match, not /dev-login)", () => {
    expect(isAuthenticatedUrl("https://terra.localhost/home")).toBe(true);
  });

  test("returns false for *.terra.localhost /dev-login page", () => {
    expect(isAuthenticatedUrl("https://worktree-foo.terra.localhost/dev-login")).toBe(false);
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
    // Browser is authenticated on worktree-A
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

    // fetch should be called because we're targeting worktree-B (different origin)
    fetchMock.mockImplementation(() => {
      throw new Error("fetch failed: ECONNREFUSED");
    });

    const result = await authenticate({
      sessionId: "test",
      port: 9333,
      slackUserId: "U0839QH8MMY",
      apiBaseUrl: "https://worktree-b.terra.localhost",
      appBaseUrl: "https://worktree-b.terra.localhost",
    });

    // fetch WAS called (did not short-circuit)
    expect(fetchMock).toHaveBeenCalled();
    // Result is failure because worktree-B is unreachable, but that's expected —
    // the important thing is that we didn't silently skip
    assertLoginFailure(result);
    expect(result.error).toContain("unreachable");
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
      slackUserId: "U0839QH8MMY",
      apiBaseUrl: "https://worktree-a.terra.localhost",
      appBaseUrl: "https://worktree-a.terra.localhost",
    });

    // fetch should NOT have been called (same origin, skip is valid)
    expect(fetchMock).not.toHaveBeenCalled();
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
      slackUserId: "U0839QH8MMY",
      // no appBaseUrl → defaults to localhost:5173
    });

    expect(fetchMock).not.toHaveBeenCalled();
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
