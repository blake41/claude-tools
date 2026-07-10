/**
 * Auth contract tests.
 *
 * Tests the authenticate() flow against mocked HTTP and agent-browser responses.
 * Verifies the shapes that cli.ts reads: { ok, user: { slackUserId, email }, error }.
 */
import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import * as fs from "fs";
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
