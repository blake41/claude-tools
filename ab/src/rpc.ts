/**
 * RPC client for communicating with the ab-server daemon over Unix socket.
 *
 * Uses fetch() to talk to the daemon at ~/.agent-browser/ab-server.sock.
 * Translates connection errors into actionable messages.
 */

import { SOCKET_PATH } from "./server";
import { AUTH_LOGIN_CLIENT_TIMEOUT_MS } from "./config";
import type {
  StatusResponse,
  HealthResponse,
  ChromeEnsureResponse,
  HealResponse,
  AuthLoginRequest,
  AuthLoginResponse,
  AuthStatusResponse,
} from "./types";

// ---------------------------------------------------------------------------
// Timeouts
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 5_000;

/** Routes that need longer timeouts (Chrome launch, auth flow) */
const SLOW_ROUTES: Record<string, number> = {
  "/chrome/ensure": 30_000,
  "/chrome/ensure-headed": 30_000,
  // Longer than the daemon's handler budget, so the CLI never gives up first.
  "/auth/login": AUTH_LOGIN_CLIENT_TIMEOUT_MS,
  "/heal": 30_000,
  // One agent-browser round trip to read cookies.
  "/auth/status": 15_000,
};

// ---------------------------------------------------------------------------
// Error messages
// ---------------------------------------------------------------------------

const DAEMON_NOT_RUNNING =
  "ab-server not running. Start with: launchctl start com.clay.ab-server";

// ---------------------------------------------------------------------------
// Core fetch wrapper
// ---------------------------------------------------------------------------

interface RpcOptions {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  /** Pre-encoded query string, without the leading `?`. */
  query?: string;
  timeoutMs?: number;
}

async function rpcFetch<T>(opts: RpcOptions): Promise<T> {
  const timeout = opts.timeoutMs ?? SLOW_ROUTES[opts.path] ?? DEFAULT_TIMEOUT_MS;

  const headers: Record<string, string> = {};
  let bodyStr: string | undefined;
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    bodyStr = JSON.stringify(opts.body);
  }

  let resp: Response;
  try {
    resp = await fetch(`http://localhost${opts.path}${opts.query ? `?${opts.query}` : ""}`, {
      method: opts.method,
      headers,
      body: bodyStr,
      signal: AbortSignal.timeout(timeout),
      // Bun supports unix sockets via the `unix` option on fetch.
      unix: SOCKET_PATH,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.includes("ECONNREFUSED") ||
      msg.includes("ENOENT") ||
      msg.includes("Connection refused") ||
      msg.includes("No such file") ||
      msg.includes("typo in the url")
    ) {
      throw new Error(DAEMON_NOT_RUNNING);
    }
    throw new Error(`RPC error (${opts.method} ${opts.path}): ${msg}`);
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    let detail = text;
    try {
      const parsed = JSON.parse(text);
      detail = parsed.error || parsed.message || text;
    } catch {
      // use raw text
    }
    throw new Error(
      `Daemon returned ${resp.status} for ${opts.method} ${opts.path}: ${detail}`,
    );
  }

  return (await resp.json()) as T;
}

// ---------------------------------------------------------------------------
// Public API — one method per daemon route
// ---------------------------------------------------------------------------

export async function status(): Promise<StatusResponse & { ok: true; version: string }> {
  return rpcFetch({ method: "GET", path: "/status" });
}

export async function health(): Promise<HealthResponse> {
  return rpcFetch({ method: "GET", path: "/health" });
}

/**
 * `opts.shard` selects which headless pool shard to ensure (server default:
 * shard 0). Omit it entirely to preserve today's no-body request shape.
 */
export async function ensureChrome(opts?: { shard?: number }): Promise<ChromeEnsureResponse> {
  return rpcFetch({
    method: "POST",
    path: "/chrome/ensure",
    body: opts?.shard !== undefined ? { shard: opts.shard } : undefined,
  });
}

export async function ensureChromeHeaded(): Promise<ChromeEnsureResponse> {
  return rpcFetch({ method: "POST", path: "/chrome/ensure-headed" });
}

export async function heal(): Promise<HealResponse> {
  return rpcFetch({ method: "POST", path: "/heal" });
}

export async function authLogin(
  req: AuthLoginRequest,
  opts: { timeoutMs?: number } = {},
): Promise<AuthLoginResponse> {
  return rpcFetch({ method: "POST", path: "/auth/login", body: req, timeoutMs: opts.timeoutMs });
}

export async function authStatus(
  opts: { port?: number; sessionId?: string; appBaseUrl?: string } = {},
): Promise<AuthStatusResponse> {
  const q = new URLSearchParams();
  if (opts.port !== undefined) q.set("port", String(opts.port));
  if (opts.sessionId !== undefined) q.set("sessionId", opts.sessionId);
  if (opts.appBaseUrl !== undefined) q.set("appBaseUrl", opts.appBaseUrl);
  const qs = q.toString();
  return rpcFetch({ method: "GET", path: "/auth/status", query: qs || undefined });
}

export async function touchHeaded(): Promise<{ ok: boolean }> {
  return rpcFetch({ method: "POST", path: "/chrome/touch-headed" });
}
