/**
 * Headless shard ports, read from the daemon's /status pool.
 */
import type { ChromeState } from "./types";

/**
 * Look up the CDP port for `shard` from an already-fetched headlessPool
 * snapshot (`status().headlessPool`), or null if that shard's Chrome isn't
 * up.
 *
 * Tolerates a daemon that hasn't been restarted with pool support yet (no
 * `headlessPool` field on /status at all) via `legacyHeadless` — the
 * daemon's `status().headless` field, which exists in both the pre-pool and
 * pool-aware response shapes. A pre-pool daemon runs exactly one headless
 * Chrome, and every session's tab lives there regardless of what the
 * marker's shard= line claims, so when `headlessPool` is missing this falls
 * back to `legacyHeadless` for EVERY shard rather than reporting every
 * shard down (chrome-pool-plan Fix 1).
 */
export function portForShard(
  headlessPool: ChromeState[] | undefined,
  shard: number,
  legacyHeadless?: ChromeState,
): number | null {
  if (headlessPool) {
    const state = headlessPool[shard];
    return state && state.phase === "chrome_up" ? state.port : null;
  }
  return legacyHeadless && legacyHeadless.phase === "chrome_up" ? legacyHeadless.port : null;
}

/**
 * The daemon's CDP port for every headless shard, from its /status pool.
 * Never from the CLI's own AB_* env: the launchd daemon does not see the
 * shell env. An up shard reports its port; a down shard's port is inferred
 * from any up shard (the daemon lays shard i on base + i). null when no shard
 * is up to anchor on.
 */
export function headlessPortsFromPool(pool: ChromeState[] | undefined): Array<number | null> {
  if (!pool) return [];
  const anchor = pool.findIndex((s) => s.phase === "chrome_up");
  if (anchor === -1) return pool.map(() => null);
  const anchorState = pool[anchor] as Extract<ChromeState, { phase: "chrome_up" }>;
  const base = anchorState.port - anchor;
  return pool.map((s, i) => (s.phase === "chrome_up" ? s.port : base + i));
}

/** The headless shard the daemon serves on `port`, or null if its pool does not say. */
export function shardForPort(port: number, pool: ChromeState[] | undefined): number | null {
  const i = headlessPortsFromPool(pool).indexOf(port);
  return i === -1 ? null : i;
}

/**
 * The daemon owns the pool size (its own AB_HEADLESS_POOL_SIZE) and validates
 * shards against it, so the CLI must never trust its own env copy. A pre-pool
 * daemon has no `headlessPool` and runs exactly one headless Chrome.
 */
export function poolSizeFromStatus(status: { headlessPool?: unknown[] }): number {
  return Math.max(1, status.headlessPool?.length ?? 1);
}
