/**
 * Unix socket HTTP server for the ab-server daemon.
 *
 * Routes:
 *   GET  /status           → daemon status + chrome states
 *   GET  /health           → 200 if responsive
 *   POST /chrome/ensure    → ensure headless chrome, return port
 *   POST /chrome/ensure-headed → ensure headed chrome, return port
 *   POST /heal             → kill all chrome, restart headless
 *   POST /auth/login       → Agent Tasks auth flow
 *   GET  /auth/status      → auth state
 *   *    *                 → 404
 */

import * as os from "os";
import * as path from "path";
import { getAllStates, resetAll } from "./state";
import * as supervisor from "./chrome-supervisor";
import { authenticateJoined, getAuthStatus, loginTimedOutError, DEFAULT_AUTH_APP_BASE } from "./auth";
import { AUTH_LOGIN_TIMEOUT_MS, HEADLESS_BASE_PORT, HEADLESS_POOL_SIZE } from "./config";
import { Logger, withOpId, newOpId } from "./logger";
import { z } from "zod";
import type {
  ChromeTarget,
  StatusResponse,
  HealthResponse,
  ChromeEnsureResponse,
  HealResponse,
  ChromeState,
  AuthStatusResponse,
} from "./types";
import { HEADLESS_TARGETS, headlessTarget } from "./types";

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
  appBaseUrl: z.string().optional(),
  clerkSecretKey: z.string().optional(),
});

const ChromeEnsureRequestSchema = z.object({
  timeoutMs: z.number().int().positive().optional(),
  shard: z.number().int().min(0).max(HEADLESS_POOL_SIZE - 1).optional(),
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
  const headlessPool = HEADLESS_TARGETS.map((target) => states[target]);
  // Additive per-target diagnostics — 2026-08-04 incident diagnosability gap
  // (a heartbeat closed at 16:28Z and nothing loggable existed until the
  // next crash at 21:52Z). Doesn't touch/rename headless/headed/headlessPool.
  const diag = supervisor.getHealthDiagnostics();
  const body: StatusResponse & { ok: true; version: string } = {
    ok: true,
    version: VERSION,
    uptime: Math.floor((Date.now() - startedAt) / 1000),
    headless: headlessPool[0],
    headed: states.headed,
    headlessPool,
    diagnostics: {
      headed: diag.headed,
      headlessPool: HEADLESS_TARGETS.map((target) => diag[target]),
    },
  };
  return json(body);
}

function handleHealth(): Response {
  const states = getAllStates();
  const headlessPool = HEADLESS_TARGETS.map((target) => ({
    phase: states[target].phase,
    port: portFromState(states[target]),
  }));
  const body: HealthResponse = {
    ok: true,
    headless: headlessPool[0],
    headed: {
      phase: states.headed.phase,
      port: portFromState(states.headed),
    },
    headlessPool,
  };
  return json(body);
}

export async function handleEnsure(target: ChromeTarget): Promise<Response> {
  try {
    const result = await supervisor.ensure(target);
    const body: ChromeEnsureResponse = {
      ok: true,
      pid: result.pid,
      port: result.port,
      alreadyRunning: result.alreadyRunning,
      profileFresh: result.profileFresh,
    };
    return json(body);
  } catch (err) {
    if (err instanceof supervisor.RetryAfterError) {
      // A target inside its crash-loop backoff window rejects fast (see
      // launchChrome's ensure gate, which already logs "Ensure rejected —
      // crash backoff") rather than making the caller hang. The `error`
      // string embeds the human-readable retry-seconds message —
      // rpc.ts's generic HTTP-error surfacing (`parsed.error || parsed.message`)
      // only propagates a flat string to the CLI's stderr, with no separate
      // channel for `retryAfterMs`, so this is the one place that message
      // has to be readable on its own. `retryAfterMs` is still included
      // verbatim for any caller that parses the body directly.
      const retryAfterMs = err.retryAfterMs;
      return json(
        {
          ok: false,
          error: `crash-loop backoff, retry in ${Math.ceil(retryAfterMs / 1000)}s`,
          retryAfterMs,
        },
        503,
      );
    }
    throw err;
  }
}

/**
 * POST /chrome/ensure body is optional — existing callers send no body at
 * all (defaults to shard 0). Parse it leniently: empty body -> {}, invalid
 * JSON or an out-of-range shard -> 400.
 */
async function parseChromeEnsureBody(
  req: Request,
): Promise<{ shard?: number; timeoutMs?: number } | { error: string }> {
  const text = await req.text();
  if (!text) return {};

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { error: "Invalid JSON body" };
  }

  const parsed = ChromeEnsureRequestSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    return { error: `Validation failed: ${issues.join(", ")}` };
  }
  return parsed.data;
}

export async function handleEnsureHeadless(req: Request): Promise<Response> {
  const parsed = await parseChromeEnsureBody(req);
  if ("error" in parsed) {
    return json({ ok: false, error: parsed.error }, 400);
  }
  const shard = parsed.shard ?? 0;
  // The missing incident forensic (FINAL CONSENSUS SPEC item 15): every
  // ensure request logs which shard it resolved to, so an incident
  // postmortem can see which shard a given caller actually landed on
  // without cross-referencing the CLI's own shard-assignment file.
  log.info(`POST /chrome/ensure shard=${shard}`);
  return handleEnsure(headlessTarget(shard));
}

export async function handleHeal(): Promise<Response> {
  const actions: string[] = [];

  // Step 1: clean agent-browser sessions (pure filesystem ops — no external process)
  log.info("Heal: cleaning agent-browser sessions");
  const cleanActions = await supervisor.cleanAgentBrowserSessions();
  actions.push(...cleanActions);

  // Step 2: stop all supervised chrome
  await supervisor.stopAll();
  actions.push("supervisor.stopAll()");

  // Step 3: reset state machine
  resetAll();
  actions.push("state reset");

  // Step 4: restart supervision (launches headless)
  const { skippedBackoff } = await supervisor.startSupervision();
  actions.push("supervisor.startSupervision()");
  // Surface any always-on target that was still inside crash-loop backoff
  // and got skipped this pass — heal must not silently leave it down with
  // no visible signal (same additive-actions pattern as the rest of this
  // list; HealResponse.actions is a plain string[]).
  for (const skip of skippedBackoff) {
    actions.push(
      `${skip.target}: launch skipped — crash backoff, retry in ${Math.ceil(skip.retryAfterMs / 1000)}s`,
    );
  }

  const body: HealResponse = { ok: true, actions };
  return json(body);
}

// ---------------------------------------------------------------------------
// Auth route handlers
// ---------------------------------------------------------------------------

async function parseAuthLoginBody(
  req: Request,
): Promise<z.infer<typeof AuthLoginRequestSchema> | { error: string }> {
  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return { error: "Invalid JSON body" };
  }

  const parsed = AuthLoginRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    return { error: `Validation failed: ${issues.join(", ")}` };
  }
  return parsed.data;
}

/**
 * POST /auth/login inside its route budget. When the budget runs out the CLI
 * gets the same 400 login-timeout error authenticate() returns, not a 500.
 * `budgetMs` is injectable for tests.
 */
export function handleAuthLogin(req: Request, budgetMs: number = AUTH_LOGIN_TIMEOUT_MS): Promise<Response> {
  let appBaseUrl: string | undefined;
  return withTimeout(
    async (signal, deadline) => {
      const parsed = await parseAuthLoginBody(req);
      if ("error" in parsed) return json({ ok: false, error: parsed.error }, 400);
      appBaseUrl = parsed.appBaseUrl;
      const result = await authenticateJoined(parsed, { signal, deadline });
      return json(result, result.ok ? 200 : 400);
    },
    budgetMs,
    () => json({ ok: false, error: loginTimedOutError(appBaseUrl) }, 400),
  );
}

const AuthStatusQuerySchema = z.object({
  port: z.coerce.number().int().min(1).max(65535),
  sessionId: z.string().min(1),
  appBaseUrl: z.string().min(1),
});

async function handleAuthStatus(url: URL): Promise<Response> {
  const q = url.searchParams;
  const parsed = AuthStatusQuerySchema.safeParse({
    port: q.get("port") ?? HEADLESS_BASE_PORT,
    sessionId: q.get("sessionId") ?? "default",
    appBaseUrl: q.get("appBaseUrl") ?? DEFAULT_AUTH_APP_BASE,
  });
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    return json({ ok: false, error: `Validation failed: ${issues.join(", ")}` }, 400);
  }
  const status: AuthStatusResponse = await getAuthStatus(parsed.data);
  return json(status);
}

// ---------------------------------------------------------------------------
// Request dispatch
// ---------------------------------------------------------------------------

/**
 * Runs `handler` with the route budget: a signal that aborts when it expires
 * and its `deadline` (epoch ms), both from one start time. At expiry the
 * route answers `onTimeout()` if given, else rejects (a 500).
 */
async function withTimeout(
  handler: (signal: AbortSignal, deadline: number) => Response | Promise<Response>,
  timeoutMs: number = HANDLER_TIMEOUT_MS,
  onTimeout?: () => Response,
): Promise<Response> {
  const controller = new AbortController();
  const deadline = Date.now() + timeoutMs;
  let timerId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<Response>((resolve, reject) => {
    timerId = setTimeout(() => {
      const err = new Error(`Handler timeout after ${timeoutMs}ms`);
      controller.abort(err);
      if (onTimeout) resolve(onTimeout());
      else reject(err);
    }, timeoutMs);
    if (typeof timerId === "object" && "unref" in timerId) {
      (timerId as NodeJS.Timeout).unref();
    }
  });
  try {
    return await Promise.race([Promise.resolve(handler(controller.signal, deadline)), timeoutPromise]);
  } finally {
    if (timerId !== null) clearTimeout(timerId);
  }
}

export async function handleRequest(req: Request): Promise<Response> {
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
      return await withOpId(newOpId(), () => withTimeout(() => handleEnsureHeadless(req))) as Response;
    }
    if (method === "POST" && pathname === "/chrome/ensure-headed") {
      return await withOpId(newOpId(), () => withTimeout(() => handleEnsure("headed"))) as Response;
    }
    if (method === "POST" && pathname === "/heal") {
      return await withOpId(newOpId(), () => withTimeout(handleHeal)) as Response;
    }
    if (method === "POST" && pathname === "/auth/login") {
      return await withOpId(newOpId(), () => handleAuthLogin(req)) as Response;
    }
    if (method === "POST" && pathname === "/chrome/touch-headed") {
      supervisor.touchHeaded();
      return json({ ok: true });
    }
    if (method === "GET" && pathname === "/auth/status") {
      return await withOpId(newOpId(), () => withTimeout(() => handleAuthStatus(url))) as Response;
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
