/**
 * Shared types for the ab-server daemon.
 * RPC request/response types, Chrome config, session config.
 */

// ---------------------------------------------------------------------------
// Chrome configuration
// ---------------------------------------------------------------------------

export type ChromePolicy = "always-on" | "on-demand";

export type ChromeTarget = "headless" | "headed";

export interface ChromeConfig {
  target: ChromeTarget;
  port: number;
  profilePath: string;
  launchArgs: string[];
  policy: ChromePolicy;
}

// ---------------------------------------------------------------------------
// Chrome state (discriminated union used by state machine)
// ---------------------------------------------------------------------------

export type ChromeState =
  | { phase: "idle" }
  | { phase: "chrome_launching" }
  | { phase: "chrome_up"; pid: number; port: number }
  | { phase: "chrome_crashed"; exitCode: number; lastCrash: Date };

// ---------------------------------------------------------------------------
// RPC: /status
// ---------------------------------------------------------------------------

export interface StatusResponse {
  headless: ChromeState;
  headed: ChromeState;
  uptime: number;
}

// ---------------------------------------------------------------------------
// RPC: /health
// ---------------------------------------------------------------------------

export interface HealthResponse {
  ok: boolean;
  headless: { phase: ChromeState["phase"]; port: number | null };
  headed: { phase: ChromeState["phase"]; port: number | null };
}

// ---------------------------------------------------------------------------
// RPC: /chrome/ensure  &  /chrome/ensure-headed
// ---------------------------------------------------------------------------

export interface ChromeEnsureRequest {
  /** Optional timeout in ms to wait for Chrome to become ready */
  timeoutMs?: number;
}

export interface ChromeEnsureResponse {
  ok: boolean;
  pid: number;
  port: number;
  alreadyRunning: boolean;
}

// ---------------------------------------------------------------------------
// RPC: /heal
// ---------------------------------------------------------------------------

export interface HealResponse {
  ok: boolean;
  actions: string[];
}

// ---------------------------------------------------------------------------
// RPC: /auth/login  (dev-login flow)
// ---------------------------------------------------------------------------

export interface AuthLoginRequest {
  sessionId: string;
  port: number;
  email?: string;
  slackUserId?: string;
  apiBaseUrl?: string;
  appBaseUrl?: string;
}

export interface AuthLoginResponse {
  ok: boolean;
  // slackUserId is optional because callers may auth by email alone.
  user?: { slackUserId?: string; email: string };
  error?: string;
}

// ---------------------------------------------------------------------------
// RPC: /auth/status
// ---------------------------------------------------------------------------

export interface AuthStatusResponse {
  ok: boolean;
  authenticated: boolean;
  user: { slackUserId?: string; email: string } | null;
  lastLogin: string | null;
}
