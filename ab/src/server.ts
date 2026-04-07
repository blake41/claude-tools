/**
 * Unix socket HTTP server for the ab-server daemon.
 *
 * Routes:
 *   GET  /status           → daemon status + chrome states
 *   GET  /health           → 200 if responsive
 *   POST /chrome/ensure    → ensure headless chrome, return port
 *   POST /chrome/ensure-headed → ensure headed chrome, return port
 *   POST /heal             → kill all chrome, restart headless
 *   POST /auth/login       → dev-login auth flow
 *   GET  /auth/status      → auth state
 *   *    *                 → 404
 */

import * as os from "os";
import * as path from "path";
import { getAllStates, resetAll } from "./state";
import * as supervisor from "./chrome-supervisor";
import { authenticate, getAuthStatus } from "./auth";
import { Logger } from "./logger";
import { z } from "zod";
import type {
  ChromeTarget,
  StatusResponse,
  HealthResponse,
  ChromeEnsureResponse,
  HealResponse,
  ChromeState,
} from "./types";

const log = new Logger({ component: "daemon" });

// ---------------------------------------------------------------------------
// Socket path
// ---------------------------------------------------------------------------

export const SOCKET_PATH = path.join(
  os.homedir(),
  ".agent-browser",
  "ab-server.sock",
);

// ---------------------------------------------------------------------------
// Startup timestamp (set when server starts)
// ---------------------------------------------------------------------------

let startedAt: number = Date.now();

const VERSION = "0.1.0";
const HANDLER_TIMEOUT_MS = 30_000;

const AuthLoginRequestSchema = z.object({
  sessionId: z.string().min(1),
  port: z.number().int().positive(),
  email: z.string().email().optional(),
  slackUserId: z.string().optional(),
  apiBaseUrl: z.string().optional(),
  appBaseUrl: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Route handler helpers
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function portFromState(state: ChromeState): number | null {
  if (state.phase === "chrome_up") {
    return state.port;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

function handleStatus(): Response {
  const states = getAllStates();
  const body: StatusResponse & { ok: true; version: string } = {
    ok: true,
    version: VERSION,
    uptime: Math.floor((Date.now() - startedAt) / 1000),
    headless: states.headless,
    headed: states.headed,
  };
  return json(body);
}

function handleHealth(): Response {
  const states = getAllStates();
  const body: HealthResponse = {
    ok: true,
    headless: {
      phase: states.headless.phase,
      port: portFromState(states.headless),
    },
    headed: {
      phase: states.headed.phase,
      port: portFromState(states.headed),
    },
  };
  return json(body);
}

async function handleEnsure(target: ChromeTarget): Promise<Response> {
  const result = await supervisor.ensure(target);
  const body: ChromeEnsureResponse = {
    ok: true,
    pid: result.pid,
    port: result.port,
    alreadyRunning: result.alreadyRunning,
  };
  return json(body);
}

async function handleHeal(): Promise<Response> {
  const actions: string[] = [];

  // Step 1: close all agent-browser sessions
  // close --all sends the close command to each daemon session.
  // For --cdp sessions (ours), this just disconnects — it does NOT kill
  // our managed Chrome (browser.rs checks browser_process.is_some()).
  log.info("Heal: running agent-browser close --all");
  const closeResult = Bun.spawnSync(["agent-browser", "close", "--all"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  actions.push(
    closeResult.exitCode === 0
      ? "agent-browser close --all succeeded"
      : `agent-browser close --all exited ${closeResult.exitCode}`,
  );

  // Step 2: stop all supervised chrome
  await supervisor.stopAll();
  actions.push("supervisor.stopAll()");

  // Step 3: reset state machine
  resetAll();
  actions.push("state reset");

  // Step 4: restart supervision (launches headless)
  await supervisor.startSupervision();
  actions.push("supervisor.startSupervision()");

  const body: HealResponse = { ok: true, actions };
  return json(body);
}

// ---------------------------------------------------------------------------
// Auth route handlers
// ---------------------------------------------------------------------------

async function handleAuthLogin(req: Request): Promise<Response> {
  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const parsed = AuthLoginRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    return json({ ok: false, error: `Validation failed: ${issues.join(", ")}` }, 400);
  }

  const result = await authenticate(parsed.data);
  return json(result, result.ok ? 200 : 400);
}

function handleAuthStatus(): Response {
  return json(getAuthStatus());
}

// ---------------------------------------------------------------------------
// Request dispatch
// ---------------------------------------------------------------------------

async function withTimeout(
  handler: () => Response | Promise<Response>,
): Promise<Response> {
  let timerId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<Response>((_, reject) => {
    timerId = setTimeout(() => {
      reject(new Error(`Handler timeout after ${HANDLER_TIMEOUT_MS}ms`));
    }, HANDLER_TIMEOUT_MS);
    if (typeof timerId === "object" && "unref" in timerId) {
      (timerId as NodeJS.Timeout).unref();
    }
  });
  const result = await Promise.race([
    Promise.resolve(handler()),
    timeoutPromise,
  ]);
  if (timerId !== null) clearTimeout(timerId);
  return result;
}

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url, "http://localhost");
  const method = req.method;
  const pathname = url.pathname;

  log.info(`${method} ${pathname}`);

  try {
    if (method === "GET" && pathname === "/status") {
      return handleStatus();
    }
    if (method === "GET" && pathname === "/health") {
      return handleHealth();
    }
    if (method === "POST" && pathname === "/chrome/ensure") {
      return await withTimeout(() => handleEnsure("headless"));
    }
    if (method === "POST" && pathname === "/chrome/ensure-headed") {
      return await withTimeout(() => handleEnsure("headed"));
    }
    if (method === "POST" && pathname === "/heal") {
      return await withTimeout(handleHeal);
    }
    if (method === "POST" && pathname === "/auth/login") {
      return await withTimeout(() => handleAuthLogin(req));
    }
    if (method === "POST" && pathname === "/chrome/touch-headed") {
      supervisor.touchHeaded();
      return json({ ok: true });
    }
    if (method === "GET" && pathname === "/auth/status") {
      return handleAuthStatus();
    }

    return json({ error: "not_found", path: pathname }, 404);
  } catch (err) {
    log.error(`Handler error: ${err}`, { path: pathname, err: String(err) });
    return json({ error: "internal", message: String(err) }, 500);
  }
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

export interface AbServer {
  server: ReturnType<typeof Bun.serve>;
  stop: () => void;
}

export function startServer(): AbServer {
  startedAt = Date.now();

  const server = Bun.serve({
    unix: SOCKET_PATH,
    fetch: handleRequest,
  });

  log.info(`Server listening on ${SOCKET_PATH}`);

  return {
    server,
    stop: () => {
      server.stop();
      log.info("Server stopped");
    },
  };
}
