/**
 * RPC client for communicating with the ab-server daemon over Unix socket.
 *
 * Uses fetch() to talk to the daemon at ~/.agent-browser/ab-server.sock.
 * Translates connection errors into actionable messages.
 */

import { SOCKET_PATH } from "./server";
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
  "/auth/login": 30_000,
  "/heal": 30_000,
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
    resp = await fetch(`http://localhost${opts.path}`, {
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

export async function ensureChrome(): Promise<ChromeEnsureResponse> {
  return rpcFetch({ method: "POST", path: "/chrome/ensure" });
}

export async function ensureChromeHeaded(): Promise<ChromeEnsureResponse> {
  return rpcFetch({ method: "POST", path: "/chrome/ensure-headed" });
}

export async function heal(): Promise<HealResponse> {
  return rpcFetch({ method: "POST", path: "/heal" });
}

export async function authLogin(
  req: AuthLoginRequest,
): Promise<AuthLoginResponse> {
  return rpcFetch({ method: "POST", path: "/auth/login", body: req });
}

export async function authStatus(): Promise<AuthStatusResponse> {
  return rpcFetch({ method: "GET", path: "/auth/status" });
}

export async function touchHeaded(): Promise<{ ok: boolean }> {
  return rpcFetch({ method: "POST", path: "/chrome/touch-headed" });
}
