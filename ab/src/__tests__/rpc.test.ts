/**
 * RPC client contract tests.
 *
 * Tests that the RPC client produces actionable error messages
 * when the daemon is unreachable or returns errors.
 *
 * Does NOT start a real server — tests error paths only.
 */
import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";

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
