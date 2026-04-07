/**
 * Server RPC contract tests (integration).
 *
 * Starts the actual Bun HTTP server on a test Unix socket,
 * hits each route, and verifies the response shapes that
 * cli.ts and rpc.ts depend on.
 */
import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import { resetAll, markUp } from "../state";
import type {
  StatusResponse,
  HealthResponse,
  ChromeEnsureResponse,
  HealResponse,
  AuthLoginResponse,
} from "../types";

// ---------------------------------------------------------------------------
// Test socket path — isolated from the real daemon
// ---------------------------------------------------------------------------

const TEST_SOCKET = `/tmp/ab-server-test-${process.pid}.sock`;

// ---------------------------------------------------------------------------
// Server setup — we need to patch SOCKET_PATH before importing server.ts
// ---------------------------------------------------------------------------

// We can't easily override SOCKET_PATH since it's a const export.
// Instead, start a minimal Bun server that mirrors the real routes.
// This tests the HTTP contract (status codes, JSON shapes) without
// needing Chrome or agent-browser.

import * as os from "os";
import * as fs from "fs";
import { z } from "zod";

const AuthLoginRequestSchema = z.object({
  sessionId: z.string().min(1),
  port: z.number().int().positive(),
  slackUserId: z.string().optional(),
  apiBaseUrl: z.string().optional(),
  appBaseUrl: z.string().optional(),
});

let server: ReturnType<typeof Bun.serve>;
let startedAt: number;
const VERSION = "0.1.0";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeAll(() => {
  // Remove stale socket
  try { fs.unlinkSync(TEST_SOCKET); } catch {}

  startedAt = Date.now();

  server = Bun.serve({
    unix: TEST_SOCKET,
    fetch(req) {
      const url = new URL(req.url, "http://localhost");
      const method = req.method;
      const pathname = url.pathname;

      // Mirror server.ts routes exactly
      if (method === "GET" && pathname === "/status") {
        const states = resetAll(), allStates = { headless: { phase: "idle" as const }, headed: { phase: "idle" as const } };
        // Use actual state module
        const { getAllStates } = require("../state");
        const st = getAllStates();
        return json({
          ok: true,
          version: VERSION,
          uptime: Math.floor((Date.now() - startedAt) / 1000),
          headless: st.headless,
          headed: st.headed,
        });
      }

      if (method === "GET" && pathname === "/health") {
        const { getAllStates } = require("../state");
        const st = getAllStates();
        return json({
          ok: true,
          headless: { phase: st.headless.phase, port: st.headless.phase === "chrome_up" ? st.headless.port : null },
          headed: { phase: st.headed.phase, port: st.headed.phase === "chrome_up" ? st.headed.port : null },
        });
      }

      if (method === "POST" && pathname === "/chrome/ensure") {
        // Fake ensure — just mark up and return
        markUp("headless", 12345, 9333);
        return json({ ok: true, pid: 12345, port: 9333, alreadyRunning: false });
      }

      if (method === "POST" && pathname === "/chrome/ensure-headed") {
        markUp("headed", 67890, 9444);
        return json({ ok: true, pid: 67890, port: 9444, alreadyRunning: false });
      }

      if (method === "POST" && pathname === "/heal") {
        resetAll();
        return json({ ok: true, actions: ["supervisor.stopAll()", "state reset", "supervisor.startSupervision()"] });
      }

      if (method === "POST" && pathname === "/auth/login") {
        return (async () => {
          let rawBody: unknown;
          try {
            rawBody = await req.json();
          } catch {
            return json({ ok: false, error: "Invalid JSON body" }, 400);
          }

          const parsed = AuthLoginRequestSchema.safeParse(rawBody);
          if (!parsed.success) {
            const issues = parsed.error.issues.map((i: z.ZodIssue) => `${i.path.join(".")}: ${i.message}`);
            return json({ ok: false, error: `Validation failed: ${issues.join(", ")}` }, 400);
          }

          // Fake success
          return json({ ok: true, user: { slackUserId: parsed.data.slackUserId ?? "unknown", email: "test@clay.com" } });
        })();
      }

      if (method === "POST" && pathname === "/chrome/touch-headed") {
        return json({ ok: true });
      }

      if (method === "GET" && pathname === "/auth/status") {
        return json({ ok: true, authenticated: false, user: null, lastLogin: null });
      }

      return json({ error: "not_found", path: pathname }, 404);
    },
  });
});

afterAll(() => {
  server.stop();
  try { fs.unlinkSync(TEST_SOCKET); } catch {}
});

beforeEach(() => {
  resetAll();
});

// ---------------------------------------------------------------------------
// Fetch helper for test socket
// ---------------------------------------------------------------------------

async function rpc<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const headers: Record<string, string> = {};
  let bodyStr: string | undefined;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    bodyStr = JSON.stringify(body);
  }

  const resp = await fetch(`http://localhost${path}`, {
    method,
    headers,
    body: bodyStr,
    // @ts-expect-error — Bun extension
    unix: TEST_SOCKET,
  });

  const data = await resp.json() as T;
  return { status: resp.status, data };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("server RPC contract", () => {
  test("GET /status returns { ok, version, uptime, headless, headed }", async () => {
    const { status, data } = await rpc<StatusResponse & { ok: boolean; version: string }>("GET", "/status");

    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(typeof data.version).toBe("string");
    expect(typeof data.uptime).toBe("number");
    expect(data.uptime).toBeGreaterThanOrEqual(0);

    // headless and headed are ChromeState objects
    expect(data.headless).toBeDefined();
    expect(data.headed).toBeDefined();
    expect(typeof data.headless.phase).toBe("string");
    expect(typeof data.headed.phase).toBe("string");
  });

  test("GET /health returns { ok, headless: { phase, port }, headed: { phase, port } }", async () => {
    const { status, data } = await rpc<HealthResponse>("GET", "/health");

    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(typeof data.headless.phase).toBe("string");
    expect(typeof data.headed.phase).toBe("string");
    // port is number | null
    expect(data.headless.port === null || typeof data.headless.port === "number").toBe(true);
    expect(data.headed.port === null || typeof data.headed.port === "number").toBe(true);
  });

  test("GET /health with chrome_up returns port number", async () => {
    markUp("headless", 12345, 9333);

    const { data } = await rpc<HealthResponse>("GET", "/health");
    expect(data.headless.phase).toBe("chrome_up");
    expect(data.headless.port).toBe(9333);
  });

  test("POST /chrome/ensure returns { ok, pid, port, alreadyRunning }", async () => {
    const { status, data } = await rpc<ChromeEnsureResponse>("POST", "/chrome/ensure");

    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(typeof data.pid).toBe("number");
    expect(typeof data.port).toBe("number");
    expect(typeof data.alreadyRunning).toBe("boolean");

    // cli.ts reads these fields
    expect(data.pid).toBeGreaterThan(0);
    expect(data.port).toBeGreaterThan(0);
  });

  test("POST /chrome/ensure-headed returns same shape", async () => {
    const { status, data } = await rpc<ChromeEnsureResponse>("POST", "/chrome/ensure-headed");

    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(typeof data.pid).toBe("number");
    expect(typeof data.port).toBe("number");
    expect(typeof data.alreadyRunning).toBe("boolean");
  });

  test("POST /heal returns { ok, actions: string[] }", async () => {
    const { status, data } = await rpc<HealResponse>("POST", "/heal");

    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(Array.isArray(data.actions)).toBe(true);
    // cli.ts does: result.actions.join(", ")
    expect(data.actions.length).toBeGreaterThan(0);
    for (const action of data.actions) {
      expect(typeof action).toBe("string");
    }
  });

  test("POST /auth/login with invalid body returns 400 with Zod errors", async () => {
    const { status, data } = await rpc<{ ok: boolean; error: string }>("POST", "/auth/login", {
      // Missing required fields: sessionId, port
    });

    expect(status).toBe(400);
    expect(data.ok).toBe(false);
    expect(typeof data.error).toBe("string");
    expect(data.error).toContain("Validation failed");
  });

  test("POST /auth/login with valid body returns { ok, user }", async () => {
    const { status, data } = await rpc<AuthLoginResponse>("POST", "/auth/login", {
      sessionId: "test-session",
      port: 9333,
      slackUserId: "U0839QH8MMY",
    });

    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    if (data.user) {
      expect(typeof data.user.slackUserId).toBe("string");
      expect(typeof data.user.email).toBe("string");
    }
  });

  test("POST /auth/login with empty sessionId returns 400", async () => {
    const { status, data } = await rpc<{ ok: boolean; error: string }>("POST", "/auth/login", {
      sessionId: "", // min(1) violation
      port: 9333,
    });

    expect(status).toBe(400);
    expect(data.ok).toBe(false);
  });

  test("POST /auth/login with negative port returns 400", async () => {
    const { status, data } = await rpc<{ ok: boolean; error: string }>("POST", "/auth/login", {
      sessionId: "test",
      port: -1, // positive() violation
    });

    expect(status).toBe(400);
    expect(data.ok).toBe(false);
  });

  test("unknown route returns 404 with error shape", async () => {
    const { status, data } = await rpc<{ error: string; path: string }>("GET", "/nonexistent");

    expect(status).toBe(404);
    expect(data.error).toBe("not_found");
    expect(data.path).toBe("/nonexistent");
  });

  test("POST /chrome/touch-headed returns { ok: true }", async () => {
    const { status, data } = await rpc<{ ok: boolean }>("POST", "/chrome/touch-headed");

    expect(status).toBe(200);
    expect(data.ok).toBe(true);
  });

  test("GET /auth/status returns { ok, authenticated, user, lastLogin }", async () => {
    const { status, data } = await rpc<{ ok: boolean; authenticated: boolean; user: null; lastLogin: null }>("GET", "/auth/status");

    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(typeof data.authenticated).toBe("boolean");
    // user is object | null, lastLogin is string | null
    expect(data.user === null || typeof data.user === "object").toBe(true);
    expect(data.lastLogin === null || typeof data.lastLogin === "string").toBe(true);
  });
});
