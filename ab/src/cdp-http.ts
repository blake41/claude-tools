import type { ChromeState } from "./types";

// ---------------------------------------------------------------------------
// CDP HTTP helpers (tab-teardown-fix U1)
//
// Modeled on `checkCdp` (chrome-supervisor.ts:621-632) — plain HTTP against
// the shard's DevTools endpoint, short AbortSignal.timeout, fail soft
// (null/false) so a wedged or absent Chrome can never hang `ab gc`.
//
// These are the ONLY teardown mechanism that has no last-tab guard: raw CDP
// closes an exact targetId with no agent-browser binary and no per-session
// daemon in the path.
// ---------------------------------------------------------------------------

/** Short by design: teardown runs ~2,300x/month under launchd; a wedged
 *  shard must degrade to "unverified" fast, never block the reap loop. */
const CDP_HTTP_TIMEOUT_MS = 2_000;

export interface CdpPage {
  id: string;
  url: string;
  title: string;
}

/**
 * List a shard's open page targets via `GET /json/list`, filtered to
 * `type === "page"` (service workers / iframes / extension targets are not
 * tabs and must never be counted or closed). Returns null — never throws —
 * when the shard is unreachable, slow, non-OK, or returns a body that
 * isn't the expected array.
 */
export async function listCdpPages(
  port: number,
  timeoutMs: number = CDP_HTTP_TIMEOUT_MS,
): Promise<CdpPage[] | null> {
  let body: unknown;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    body = await res.json();
  } catch {
    return null; // unreachable / timed out / unparseable — caller treats as unknown
  }
  if (!Array.isArray(body)) return null;
  const pages: CdpPage[] = [];
  for (const raw of body) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    if (entry.type !== "page") continue;
    if (typeof entry.id !== "string" || entry.id.length === 0) continue;
    pages.push({
      id: entry.id,
      url: typeof entry.url === "string" ? entry.url : "",
      title: typeof entry.title === "string" ? entry.title : "",
    });
  }
  return pages;
}

/** CDP target ids are uppercase hex. Anything else is either corruption in a
 *  session marker or an injection attempt into the request path — refuse it
 *  rather than letting it reach `/json/close/`. */
export const CDP_TARGET_ID_RE = /^[0-9A-Fa-f]{4,}$/;

/**
 * Close one exact target via `GET /json/close/<targetId>`. Returns false
 * (never throws) on a malformed id, a non-OK response, or an unreachable
 * shard.
 */
export async function closeCdpTarget(
  port: number,
  targetId: string,
  timeoutMs: number = CDP_HTTP_TIMEOUT_MS,
): Promise<boolean> {
  if (!CDP_TARGET_ID_RE.test(targetId)) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/close/${targetId}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Fetch per-shard open-page counts for `ab status`/`ab doctor`
 * (tab-teardown-fix U3, R5). Mirrors `buildHeadlessDoctorChecks`'s
 * pool-vs-legacy fallback shape so tab visibility degrades the same way
 * Chrome-liveness visibility already does: every `headlessPool` shard gets
 * an entry (its real count if `chrome_up`, `null` otherwise — down/idle and
 * "couldn't ask" must never be conflated with a passing zero), and a
 * pre-pool daemon (no `headlessPool` field at all) falls back to a single
 * legacy entry. `listPages` is injectable (defaults to `listCdpPages`) so
 * tests never contact the real shared CDP pool. Fails soft per shard: a
 * `null` from `listPages` (timeout/unreachable, per `listCdpPages`'s own
 * contract) becomes a `null` count for that shard only — sibling shards are
 * unaffected.
 */
export async function fetchTabCounts(
  headlessPool: ChromeState[] | undefined,
  legacyHeadless: ChromeState | undefined,
  listPages: (port: number) => Promise<CdpPage[] | null> = listCdpPages,
): Promise<Array<number | null>> {
  if (headlessPool) {
    return Promise.all(
      headlessPool.map(async (state) => {
        if (state.phase !== "chrome_up") return null;
        const p = await listPages(state.port);
        return p ? p.length : null;
      }),
    );
  }
  if (legacyHeadless) {
    if (legacyHeadless.phase !== "chrome_up") return [null];
    const p = await listPages(legacyHeadless.port);
    return [p ? p.length : null];
  }
  return [];
}
