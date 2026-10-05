/**
 * RPC client contract tests.
 *
 * Tests that the RPC client produces actionable error messages
 * when the daemon is unreachable or returns errors.
 *
 * Does NOT start a real server — tests error paths only.
 */
import { test, expect, describe, beforeEach, afterEach, mock, spyOn } from "bun:test";

// ---------------------------------------------------------------------------
// We need to test rpc.ts behavior when daemon is not running.
// rpc.ts uses fetch() with Bun's `unix` option. When the socket doesn't exist,
// Bun throws an error containing "ENOENT" or "No such file".
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("rpc client contract", () => {
  test("when daemon socket does not exist, throws 'ab-server not running'", async () => {
    // Mock fetch to simulate ENOENT (no socket file)
    globalThis.fetch = mock(() => {
      throw new Error("No such file or directory");
    }) as unknown as typeof fetch;

    // Dynamic import to get fresh module
    const rpc = await import("../rpc");

    await expect(rpc.status()).rejects.toThrow("ab-server not running");
  });

  test("when daemon refuses connection, throws 'ab-server not running'", async () => {
    globalThis.fetch = mock(() => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const rpc = await import("../rpc");

    await expect(rpc.status()).rejects.toThrow("ab-server not running");
  });

  test("error message includes launchctl hint", async () => {
    globalThis.fetch = mock(() => {
      throw new Error("No such file or directory");
    }) as unknown as typeof fetch;

    const rpc = await import("../rpc");

    try {
      await rpc.status();
      expect(true).toBe(false); // should not reach
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("launchctl");
    }
  });

  test("when daemon returns non-200, throws with status and detail", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ error: "something broke" }),
          { status: 500 },
        ),
      ),
    ) as unknown as typeof fetch;

    const rpc = await import("../rpc");

    await expect(rpc.status()).rejects.toThrow("500");
  });

  test("when daemon returns non-200 with message field, extracts it", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ message: "Handler timeout after 30000ms" }),
          { status: 500 },
        ),
      ),
    ) as unknown as typeof fetch;

    const rpc = await import("../rpc");

    try {
      await rpc.status();
      expect(true).toBe(false);
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("Handler timeout");
    }
  });

  test("when daemon returns 400 with Zod error, throws with detail", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ ok: false, error: "Validation failed: sessionId: Required" }),
          { status: 400 },
        ),
      ),
    ) as unknown as typeof fetch;

    const rpc = await import("../rpc");

    await expect(
      rpc.authLogin({ sessionId: "", port: 9333 }),
    ).rejects.toThrow("Validation failed");
  });

  test("timeout error is not misidentified as daemon-not-running", async () => {
    globalThis.fetch = mock(() => {
      throw new Error("The operation timed out");
    }) as unknown as typeof fetch;

    const rpc = await import("../rpc");

    try {
      await rpc.status();
      expect(true).toBe(false);
    } catch (err) {
      const msg = (err as Error).message;
      // Should NOT say "ab-server not running" — it's a timeout, not missing daemon
      expect(msg).not.toContain("ab-server not running");
      expect(msg).toContain("timed out");
    }
  });
});

describe("auth login client timeout", () => {
  test("/auth/login waits AUTH_LOGIN_CLIENT_TIMEOUT_MS, longer than the daemon's handler budget", async () => {
    const { AUTH_LOGIN_CLIENT_TIMEOUT_MS, AUTH_LOGIN_TIMEOUT_MS } = await import("../config");
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ ok: true, user: { email: "blake@clay.com" } }), { status: 200 })),
    ) as unknown as typeof fetch;
    const timeoutSpy = spyOn(AbortSignal, "timeout");
    try {
      const rpc = await import("../rpc");
      await rpc.authLogin({ sessionId: "test", port: 9333, email: "blake@clay.com" });
      expect(timeoutSpy.mock.calls[0]![0]).toBe(AUTH_LOGIN_CLIENT_TIMEOUT_MS);
      expect(AUTH_LOGIN_CLIENT_TIMEOUT_MS).toBeGreaterThan(AUTH_LOGIN_TIMEOUT_MS);
    } finally {
      timeoutSpy.mockRestore();
    }
  });
});

describe("rpc.authStatus against the real server handler", () => {
  const originalSpawn = Bun.spawn;
  let requestedUrls: string[];
  let spawnCalls: string[][];

  beforeEach(async () => {
    requestedUrls = [];
    spawnCalls = [];
    const { handleRequest } = await import("../server");
    globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
      requestedUrls.push(String(input));
      return handleRequest(new Request(String(input), { method: init?.method }));
    }) as unknown as typeof fetch;
    // @ts-expect-error — test mock, narrower than Bun.spawn's overload set
    Bun.spawn = mock((cmd: string[]) => {
      spawnCalls.push(cmd);
      const cookies = [{ name: "__session", value: "jwt", domain: "terra.clay.com" }];
      return {
        exited: Promise.resolve(0),
        exitCode: 0,
        stdout: new Response(JSON.stringify({ data: { cookies } })).body,
        stderr: new Response("").body,
        kill: () => {},
      };
    });
  });

  afterEach(() => {
    Bun.spawn = originalSpawn;
  });

  test("port, sessionId and appBaseUrl survive encoding and reach the handler", async () => {
    const rpc = await import("../rpc");
    const result = await rpc.authStatus({
      port: 9335,
      sessionId: "shard 2&x",
      appBaseUrl: "https://terra.clay.com",
    });

    const url = new URL(requestedUrls[0]!);
    expect(url.pathname).toBe("/auth/status");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      port: "9335",
      sessionId: "shard 2&x",
      appBaseUrl: "https://terra.clay.com",
    });
    expect(spawnCalls[0]!.slice(0, 5)).toEqual(["agent-browser", "--session", "shard 2&x", "--cdp", "9335"]);
    expect(result.authenticated).toBe(true);
    expect(result.port).toBe(9335);
    expect(result.checkedVia).toBe("cookie");
  });

  test("without appBaseUrl sends only port and sessionId and the handler applies its app-base default", async () => {
    const rpc = await import("../rpc");
    const result = await rpc.authStatus({ port: 9333, sessionId: "default" });

    expect(requestedUrls[0]).toBe("http://localhost/auth/status?port=9333&sessionId=default");
    // The mocked cookie is for terra.clay.com; the default app base is localhost.
    expect(result.authenticated).toBe(false);
  });

  test("a daemon validation failure surfaces as an error carrying the 400 detail", async () => {
    const rpc = await import("../rpc");

    await expect(rpc.authStatus({ port: 0, sessionId: "default" })).rejects.toThrow(/Daemon returned 400 for GET \/auth\/status: .*port/);
  });

  test("/auth/status waits 15s on the client", async () => {
    const timeoutSpy = spyOn(AbortSignal, "timeout");
    try {
      const rpc = await import("../rpc");
      await rpc.authStatus({ port: 9333, sessionId: "default" });
      expect(timeoutSpy.mock.calls[0]![0]).toBe(15_000);
    } finally {
      timeoutSpy.mockRestore();
    }
  });
});
