/**
 * Socket, port and pool configuration shared by the ab-server daemon and the ab CLI.
 *
 * They are separate processes, so each resolves this module from its own env
 * at load time. Loading never throws: a bad value is reported in CONFIG_ERROR
 * and the constants fall back to the defaults. The daemon refuses to start
 * while CONFIG_ERROR is set; the CLI only warns, because it takes its ports
 * from the daemon. Must not import ./types, ./server, ./cli or
 * ./chrome-supervisor.
 */

import * as os from "os";
import * as path from "path";

/** Unix socket the daemon serves its RPC routes on and the CLI connects to. */
export const SOCKET_PATH = path.join(os.homedir(), ".agent-browser", "ab-server.sock");

type Env = Record<string, string | undefined>;

export interface AbConfig {
  /** Headless shard i listens on headlessBasePort + i. */
  headlessBasePort: number;
  headedPort: number;
  dashboardPort: number;
  headlessPoolSize: number;
}

const DEFAULT_HEADLESS_BASE_PORT = 9333;
const DEFAULT_HEADED_PORT = 9444;
const DEFAULT_DASHBOARD_PORT = 4848;
const MIN_PORT = 1024;
const MAX_PORT = 65535;

// ---------------------------------------------------------------------------
// Headless pool sizing
// ---------------------------------------------------------------------------

const MIN_HEADLESS_POOL_SIZE = 1;
const MAX_HEADLESS_POOL_SIZE = 8;
const DEFAULT_HEADLESS_POOL_SIZE = 3;

function clampPoolSize(n: number): number {
  return Math.min(MAX_HEADLESS_POOL_SIZE, Math.max(MIN_HEADLESS_POOL_SIZE, n));
}

export function resolvePoolSize(env: Env = process.env): number {
  const raw = env.AB_HEADLESS_POOL_SIZE;
  if (raw === undefined || raw.trim() === "") return DEFAULT_HEADLESS_POOL_SIZE;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed)) return DEFAULT_HEADLESS_POOL_SIZE;
  return clampPoolSize(parsed);
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export function readPortEnv(name: string, fallback: number, env: Env = process.env): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const trimmed = raw.trim();
  const port = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new Error(
      `${name} must be an integer port between ${MIN_PORT} and ${MAX_PORT} (got "${raw}")`,
    );
  }
  return port;
}

/** Throws on a bad value; the message names the offending variable. */
export function resolveConfig(env: Env = process.env): AbConfig {
  const base = readPortEnv("AB_BASE_PORT", DEFAULT_HEADLESS_BASE_PORT, env);
  const headed = readPortEnv("AB_HEADED_PORT", DEFAULT_HEADED_PORT, env);
  const dashboard = readPortEnv("AB_DASHBOARD_PORT", DEFAULT_DASHBOARD_PORT, env);
  const poolSize = resolvePoolSize(env);

  const top = base + poolSize - 1;
  if (top > MAX_PORT) {
    throw new Error(
      `AB_BASE_PORT=${base} with ${poolSize} headless shards needs ports ${base}-${top}; the top exceeds ${MAX_PORT}`,
    );
  }
  for (const [name, port] of [["AB_HEADED_PORT", headed], ["AB_DASHBOARD_PORT", dashboard]] as const) {
    if (port >= base && port <= top) {
      throw new Error(
        `${name}=${port} collides with a headless shard port (AB_BASE_PORT=${base}, ${poolSize} shards)`,
      );
    }
  }
  if (headed === dashboard) {
    throw new Error(`AB_HEADED_PORT and AB_DASHBOARD_PORT must differ (both ${headed})`);
  }

  return { headlessBasePort: base, headedPort: headed, dashboardPort: dashboard, headlessPoolSize: poolSize };
}

function loadConfig(env: Env): { config: AbConfig; error: string | null } {
  try {
    return { config: resolveConfig(env), error: null };
  } catch (err) {
    return {
      config: resolveConfig({ AB_HEADLESS_POOL_SIZE: env.AB_HEADLESS_POOL_SIZE }),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

const loaded = loadConfig(process.env);
const config = loaded.config;

/** Why this process's AB_* env is invalid, or null. When set, the constants below are the defaults. */
export const CONFIG_ERROR: string | null = loaded.error;

/** Base CDP port for the headless pool (AB_BASE_PORT, default 9333). */
export const HEADLESS_BASE_PORT: number = config.headlessBasePort;
/** CDP port of the on-demand headed Chrome (AB_HEADED_PORT, default 9444). */
export const HEADED_PORT: number = config.headedPort;
/** agent-browser dashboard port (AB_DASHBOARD_PORT, default 4848). */
export const DASHBOARD_PORT: number = config.dashboardPort;
/**
 * Number of headless Chrome shards this process supervises, resolved once
 * at module load from AB_HEADLESS_POOL_SIZE (default 3, clamped 1-8).
 */
export const HEADLESS_POOL_SIZE: number = config.headlessPoolSize;

/** CDP port of headless shard `shard` (0-indexed). */
export function headlessPortForShard(shard: number): number {
  return HEADLESS_BASE_PORT + shard;
}

/** The agent-browser binary, looked up on PATH. */
export const AGENT_BROWSER = "agent-browser";

// ---------------------------------------------------------------------------
// Auth login budgets
// ---------------------------------------------------------------------------

/** Daemon handler budget for POST /auth/login (withTimeout). */
export const AUTH_LOGIN_TIMEOUT_MS = 60_000;
/** CLI RPC timeout for /auth/login; longer than the daemon's, so the CLI never gives up first. */
export const AUTH_LOGIN_CLIENT_TIMEOUT_MS = AUTH_LOGIN_TIMEOUT_MS + 5_000;
