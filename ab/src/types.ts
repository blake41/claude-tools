/**
 * Shared types for the ab-server daemon.
 * RPC request/response types, Chrome config, session config.
 */

// ---------------------------------------------------------------------------
// Chrome configuration
// ---------------------------------------------------------------------------

export type ChromePolicy = "always-on" | "on-demand";

export type ChromeTarget = "headed" | `headless-${number}`;

export interface ChromeConfig {
  target: ChromeTarget;
  port: number;
  profilePath: string;
  launchArgs: string[];
  policy: ChromePolicy;
}

// ---------------------------------------------------------------------------
// Headless pool sizing
// ---------------------------------------------------------------------------

const MIN_HEADLESS_POOL_SIZE = 1;
const MAX_HEADLESS_POOL_SIZE = 8;
const DEFAULT_HEADLESS_POOL_SIZE = 3;

function clampPoolSize(n: number): number {
  return Math.min(MAX_HEADLESS_POOL_SIZE, Math.max(MIN_HEADLESS_POOL_SIZE, n));
}

function resolvePoolSize(): number {
  const raw = process.env.AB_HEADLESS_POOL_SIZE;
  if (raw === undefined || raw.trim() === "") return DEFAULT_HEADLESS_POOL_SIZE;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed)) return DEFAULT_HEADLESS_POOL_SIZE;
  return clampPoolSize(parsed);
}

/**
 * Number of headless Chrome shards this process supervises, resolved once
 * at module load from AB_HEADLESS_POOL_SIZE (default 3, clamped 1-8).
 */
export const HEADLESS_POOL_SIZE: number = resolvePoolSize();

/** Build the ChromeTarget key for headless shard `shard` (0-indexed). */
export function headlessTarget(shard: number): ChromeTarget {
  return `headless-${shard}`;
}

/** All headless shard targets in the pool: headless-0 .. headless-(N-1). */
export const HEADLESS_TARGETS: ChromeTarget[] = Array.from(
  { length: HEADLESS_POOL_SIZE },
  (_, i) => headlessTarget(i),
);

/** Every Chrome target the daemon supervises: headed + the headless pool. */
export const ALL_TARGETS: ChromeTarget[] = ["headed", ...HEADLESS_TARGETS];

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
  /** @deprecated back-compat alias for headlessPool[0] (shard 0) */
  headless: ChromeState;
  headed: ChromeState;
  /** Per-shard state, index = shard number. */
  headlessPool: ChromeState[];
  uptime: number;
  /**
   * Per-target health diagnostics — additive, does not replace/rename
   * anything above. Added for the 2026-08-04 incident diagnosability gap
   * (a heartbeat closed at 16:28Z and nothing loggable existed until the
   * next crash at 21:52Z).
   */
  diagnostics: {
    headed: ShardDiagnostics;
    /** Index-aligned with headlessPool. */
    headlessPool: ShardDiagnostics[];
  };
}

/** Per-target health diagnostics — see StatusResponse.diagnostics. */
export interface ShardDiagnostics {
  /** ISO timestamp of the last successful health-check poll, or null if none yet. */
  lastHealthOkAt: string | null;
  /** ISO timestamp since the current heartbeat WS was armed, or null if no heartbeat is open. */
  heartbeatArmedSince: string | null;
}

// ---------------------------------------------------------------------------
// RPC: /health
// ---------------------------------------------------------------------------

export interface HealthResponse {
  ok: boolean;
  /** @deprecated back-compat alias for headlessPool[0] (shard 0) */
  headless: { phase: ChromeState["phase"]; port: number | null };
  headed: { phase: ChromeState["phase"]; port: number | null };
  /** Per-shard health, index = shard number. */
  headlessPool: Array<{ phase: ChromeState["phase"]; port: number | null }>;
}

// ---------------------------------------------------------------------------
// RPC: /chrome/ensure  &  /chrome/ensure-headed
// ---------------------------------------------------------------------------

export interface ChromeEnsureRequest {
  /** Optional timeout in ms to wait for Chrome to become ready */
  timeoutMs?: number;
  /** Optional headless pool shard index (0..poolSize-1). Defaults to 0. */
  shard?: number;
}

export interface ChromeEnsureResponse {
  ok: boolean;
  pid: number;
  port: number;
  alreadyRunning: boolean;
  /**
   * True when this shard's Chrome just launched from a profile dir that
   * didn't exist yet (empty cookie jar — likely needs `ab reauth`). False
   * when Chrome was already running or the profile already existed.
   * (chrome-pool-plan Unit 3, decision 5.)
   */
  profileFresh: boolean;
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
