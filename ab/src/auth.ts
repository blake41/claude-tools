/**
 * Agent Tasks authentication flow for ab-server.
 *
 * Mints a Clerk Agent Task directly (development instance only) for the
 * requested user, then opens the one-time Clerk-hosted URL in the browser.
 * Clerk establishes the session and redirects to the app origin.
 *
 * The flow talks to Clerk directly, not to Terra's API.
 * The minted URL and the Clerk secret key are never logged.
 */

import type { ClerkClient } from "@clerk/backend";
import { Logger } from "./logger";
import type { AuthLoginRequest, AuthLoginResponse, AuthStatusResponse } from "./types";

const log = new Logger({ component: "auth" });

// ---------------------------------------------------------------------------
// In-memory auth state
// ---------------------------------------------------------------------------

interface AuthState {
  user: { email: string } | null;
  timestamp: number | null;
}

let authState: AuthState = {
  user: null,
  timestamp: null,
};

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Default app base used when a caller omits appBaseUrl. */
export const DEFAULT_AUTH_APP_BASE = "http://localhost:5173";

/** Origin of `url`, or "" when it is not a URL. */
function originOfUrl(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

function originOf(appBaseUrl: string | undefined): string {
  const base = appBaseUrl || DEFAULT_AUTH_APP_BASE;
  try {
    return new URL(base).origin;
  } catch {
    return base;
  }
}

/** The login-timeout error the CLI shows, whether authenticate() or the route budget ran out first. */
export function loginTimedOutError(appBaseUrl: string | undefined): string {
  return `Auth exchange timed out: browser did not land on ${originOf(appBaseUrl)}. The Agent Task URL is one-time, so retry the reauth.`;
}

// ---------------------------------------------------------------------------
// Clerk client seam
// ---------------------------------------------------------------------------

/** The slice of @clerk/backend's client that authenticate() uses. */
export type AgentTaskClient = Pick<ClerkClient, "agentTasks">;

export interface AuthenticateDeps {
  createClerkClient: (secretKey: string) => AgentTaskClient | Promise<AgentTaskClient>;
  pollIntervalMs?: number;
}

/**
 * The route budget a login runs inside: `signal` aborts when it expires and
 * `deadline` (epoch ms) is that same expiry, which per-step timeouts are
 * capped at. Both come from one clock in the server's withTimeout.
 */
export interface LoginBudget {
  signal: AbortSignal;
  deadline: number;
}

const defaultDeps: AuthenticateDeps = {
  createClerkClient: async (secretKey) => {
    const { createClerkClient } = await import("@clerk/backend");
    return createClerkClient({ secretKey });
  },
};

const AGENT_TASK_SESSION_SECONDS = 3600;

/** Clerk's "no such user" comes back as a 404 / `*_not_found` error code. */
function isClerkUserNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { status?: unknown; errors?: unknown };
  if (e.status === 404) return true;
  return Array.isArray(e.errors)
    && e.errors.some((x) => typeof (x as { code?: unknown })?.code === "string" && (x as { code: string }).code.includes("not_found"));
}

function ticketOf(url: string): string | undefined {
  try {
    return new URL(url).searchParams.get("ticket") ?? undefined;
  } catch {
    return undefined;
  }
}

function redactSecrets(text: string, secrets: Array<string | undefined>): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join("[redacted]");
  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NAV_STDERR_TAIL_CHARS = 400;
/** Per-call agent-browser cap; every browser step in the login flow is also capped at the time left. */
const STEP_TIMEOUT_MS = 15_000;

const ABORTED = Symbol("aborted");

/** `work`'s result, or ABORTED once `signal` aborts. A losing `work` keeps running and its result is dropped. */
function unlessAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T | typeof ABORTED> {
  if (signal.aborted) return Promise.resolve(ABORTED);
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve(ABORTED);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

function tail(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(-maxChars);
}

async function runAgentBrowser(
  sessionId: string,
  port: number,
  args: string[],
  timeoutMs = STEP_TIMEOUT_MS,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const proc = Bun.spawn(
    ["agent-browser", "--session", sessionId, "--cdp", String(port), ...args],
    { stdout: "pipe", stderr: "pipe" },
  );

  const exited = proc.exited;
  const timeout = new Promise<never>((_, reject) => {
    const id = setTimeout(() => reject(new Error(`agent-browser timed out after ${timeoutMs}ms`)), timeoutMs);
    if (typeof id === "object" && "unref" in id) (id as NodeJS.Timeout).unref();
  });

  try {
    await Promise.race([exited, timeout]);
  } catch (err) {
    proc.kill();
    return { ok: false, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
  }

  return {
    ok: proc.exitCode === 0,
    stdout: await new Response(proc.stdout).text().then(s => s.trim()),
    stderr: await new Response(proc.stderr).text().then(s => s.trim()),
  };
}

const PRODUCTION_APP_HOST = "terra.clay.com";

/**
 * Pure safety gate for minting an Agent Task. Refuses anything but a Clerk
 * development instance (`sk_test_` key) and refuses the production app host.
 * Error text never contains the key.
 */
export function checkAgentTaskGuards(input: {
  secretKey: string | undefined;
  appBaseUrl: string;
}): { ok: true } | { ok: false; error: string } {
  const { secretKey, appBaseUrl } = input;
  if (!secretKey) {
    return {
      ok: false,
      error: "CLERK_SECRET_KEY is not set. Export the development-instance key (sk_test_...) in the shell that runs `ab`.",
    };
  }
  if (!secretKey.startsWith("sk_test_")) {
    return {
      ok: false,
      error: "Refusing to mint: CLERK_SECRET_KEY is not a development-instance key (must start with sk_test_). Use `ab import` for production.",
    };
  }
  let host: string;
  try {
    host = new URL(appBaseUrl).hostname.toLowerCase();
  } catch {
    return { ok: false, error: `Refusing to mint: appBaseUrl is not a valid URL: ${appBaseUrl}` };
  }
  if (host === PRODUCTION_APP_HOST) {
    return {
      ok: false,
      error: `Refusing to mint against ${PRODUCTION_APP_HOST}. Production auth uses \`ab import\` (headed Google login).`,
    };
  }
  return { ok: true };
}

/**
 * True when a Clerk session cookie is visible for the app host: `__session`
 * with a value, or `__client_uat` with a value other than "0". Cookie names may
 * carry a per-instance suffix (`__session_<id>`).
 */
export function hasClerkSessionCookie(cookies: unknown, appHost: string): boolean {
  if (!Array.isArray(cookies)) return false;
  const host = appHost.toLowerCase();
  return cookies.some((c) => {
    if (typeof c !== "object" || c === null) return false;
    const { name, value, domain } = c as { name?: unknown; value?: unknown; domain?: unknown };
    if (typeof name !== "string" || typeof value !== "string" || !value) return false;
    if (typeof domain !== "string") return false;
    const d = domain.toLowerCase().replace(/^\./, "");
    if (host !== d && !host.endsWith(`.${d}`)) return false;
    if (name === "__session" || name.startsWith("__session_")) return true;
    return (name === "__client_uat" || name.startsWith("__client_uat_")) && value !== "0";
  });
}

async function confirmClerkSession(
  sessionId: string,
  port: number,
  appOrigin: string,
  timeoutMs = STEP_TIMEOUT_MS,
): Promise<boolean> {
  const result = await runAgentBrowser(sessionId, port, ["cookies", "get", "--json"], timeoutMs);
  if (!result.ok) {
    log.warn("Could not read browser cookies to confirm the Clerk session");
    return false;
  }
  try {
    const parsed = JSON.parse(result.stdout) as { data?: { cookies?: unknown } };
    return hasClerkSessionCookie(parsed?.data?.cookies, new URL(appOrigin).hostname);
  } catch {
    return false;
  }
}

/**
 * Check whether the browser is already on an authenticated page.
 * An authenticated page is a Clay URL that is NOT /sign-in.
 */
export function isAuthenticatedUrl(url: string): boolean {
  if (!url) return false;
  const clayPatterns = ["localhost:5173", "onrender.com", "terra.clay.com", ".terra.localhost", "terra.localhost"];
  const isClay = clayPatterns.some((p) => url.includes(p));
  if (!isClay) return false;
  const unauthPaths = ["/sign-in"];
  return !unauthPaths.some((p) => url.includes(p));
}

// ---------------------------------------------------------------------------
// Main authenticate flow
// ---------------------------------------------------------------------------

export async function authenticate(
  req: AuthLoginRequest,
  { signal, deadline }: LoginBudget,
  deps: Partial<AuthenticateDeps> = {},
): Promise<AuthLoginResponse> {
  const { createClerkClient, pollIntervalMs = 1_000 } = { ...defaultDeps, ...deps };
  const { sessionId, port } = req;
  const appBaseUrl = req.appBaseUrl || DEFAULT_AUTH_APP_BASE;
  const email = req.email;

  // Never log the secret key.
  log.info("Starting auth flow", { sessionId, port, appBaseUrl, email });

  const appOrigin = originOf(appBaseUrl);
  const timeLeft = () => deadline - Date.now();
  // Once the signal aborts, the route has already answered the CLI: no state write may follow.
  const expired = () => signal.aborted || timeLeft() <= 0;
  /**
   * One browser step capped at the time left, or null when the budget is
   * spent before it starts or by the time it ends. A step cut off at the
   * deadline must report the login timeout, not whatever the next step finds.
   */
  const step = async <T>(run: (timeoutMs: number) => Promise<T>): Promise<T | null> => {
    if (expired()) return null;
    const result = await run(Math.min(STEP_TIMEOUT_MS, timeLeft()));
    return expired() ? null : result;
  };
  const timedOut = (): AuthLoginResponse => {
    log.error("Browser did not land on the app origin before the deadline", { appOrigin });
    return { ok: false, error: loginTimedOutError(appBaseUrl) };
  };

  // -----------------------------------------------------------------------
  // Step 1: Check if already authenticated
  //
  // The short-circuit is origin-aware: being authenticated on worktree-A
  // must not skip auth for worktree-B. We compare the browser URL's origin
  // against the target appBaseUrl origin. When no appBaseUrl is provided, the
  // target is localhost:5173 (the DEFAULT_AUTH_APP_BASE), so we check that.
  //
  // The URL alone proves nothing: a fresh load of the app origin reads as
  // authenticated until the app redirects to /sign-in. Only the Clerk session
  // cookie skips the login.
  // -----------------------------------------------------------------------

  const urlResult = await step((ms) => runAgentBrowser(sessionId, port, ["get", "url"], ms));
  if (urlResult === null) return timedOut();
  if (urlResult.ok && isAuthenticatedUrl(urlResult.stdout)) {
    const browserOrigin = originOfUrl(urlResult.stdout);

    if (browserOrigin === appOrigin) {
      const hasSession = await step((ms) => confirmClerkSession(sessionId, port, appOrigin, ms));
      if (hasSession === null) return timedOut();
      if (hasSession) {
        log.info("Browser already holds a Clerk session for the same origin — skipping login", {
          url: urlResult.stdout,
          targetOrigin: appOrigin,
        });
        authState = {
          user: authState.user, // preserve existing user info
          timestamp: Date.now(),
        };
        return { ok: true, user: authState.user ?? undefined };
      }
      log.info("Browser is on the app origin without a Clerk session — proceeding with login", {
        url: urlResult.stdout,
        targetOrigin: appOrigin,
      });
    } else {
      log.info("Browser is authenticated but on a different origin — proceeding with login", {
        browserOrigin,
        targetOrigin: appOrigin,
      });
    }
  }

  // -----------------------------------------------------------------------
  // Step 2: Resolve identity + guards, then mint an Agent Task
  // -----------------------------------------------------------------------

  if (!email) {
    return { ok: false, error: "email is required: set AB_AUTH_EMAIL to the account's email." };
  }

  const secretKey = req.clerkSecretKey;
  const guard = checkAgentTaskGuards({ secretKey, appBaseUrl });
  if (!guard.ok) {
    log.warn("Agent Task guard refused", { reason: guard.error });
    return { ok: false, error: guard.error };
  }

  let taskUrl = "";
  try {
    const mint = async () => {
      const clerk = await createClerkClient(secretKey!);
      log.info("Minting Agent Task", { email, appBaseUrl });
      return clerk.agentTasks.create({
        onBehalfOf: { identifier: email },
        permissions: "*",
        agentName: "ab",
        taskDescription: "ab reauth",
        redirectUrl: `${appBaseUrl}/`,
        sessionMaxDurationInSeconds: AGENT_TASK_SESSION_SECONDS,
      });
    };
    const task = await unlessAborted(mint(), signal);
    if (task === ABORTED) return timedOut();
    if (typeof task?.url !== "string" || !task.url) {
      return { ok: false, error: "Agent Task mint returned invalid response: missing url" };
    }
    taskUrl = task.url;
    log.info("Minted Agent Task", { taskId: task.taskId });
  } catch (err) {
    if (isClerkUserNotFound(err)) {
      return {
        ok: false,
        error: `User ${email} has no Clerk account in this environment. `
          + `Log in via Google OAuth once at ${appBaseUrl} to create it, then retry.`,
      };
    }
    const raw = err instanceof Error ? err.message : String(err);
    const message = redactSecrets(raw, [secretKey]);
    log.error("Agent Task mint failed", { message });
    return { ok: false, error: `Agent Task mint failed: ${message}` };
  }

  // -----------------------------------------------------------------------
  // Step 3: Open the one-time Clerk-hosted URL (never logged)
  // -----------------------------------------------------------------------

  const secrets = [secretKey, taskUrl, ticketOf(taskUrl)];
  const navResult = await step((ms) => runAgentBrowser(sessionId, port, ["open", taskUrl], ms));
  if (navResult === null) return timedOut();
  if (!navResult.ok) {
    const stderr = redactSecrets(navResult.stderr, secrets);
    log.error("Navigation failed", { stderr });
    return { ok: false, error: `Auth exchange failed: ${tail(stderr, NAV_STDERR_TAIL_CHARS) || "browser navigation error"}` };
  }

  // -----------------------------------------------------------------------
  // Step 4: Poll until the browser lands on the app origin, has left
  // Clerk-hosted / sign-in pages, and holds a Clerk session cookie
  // -----------------------------------------------------------------------

  let landed = false;
  let landedWithoutSession = false;
  while (!expired()) {
    await new Promise((r) => setTimeout(r, Math.min(pollIntervalMs, Math.max(0, timeLeft()))));
    const verifyResult = await step((ms) => runAgentBrowser(sessionId, port, ["get", "url"], ms));
    if (verifyResult === null) break;
    if (!verifyResult.ok) {
      log.warn("Could not read browser URL during poll");
      continue;
    }
    const origin = originOfUrl(verifyResult.stdout);
    if (origin === appOrigin && !verifyResult.stdout.includes("/sign-in")) {
      const hasSession = await step((ms) => confirmClerkSession(sessionId, port, appOrigin, ms));
      if (hasSession === null) break;
      if (hasSession) {
        landed = true;
        landedWithoutSession = false;
        log.info("Auth exchange succeeded", { origin });
        break;
      }
      landedWithoutSession = true;
      continue;
    }
    log.debug("Not on the app origin yet, waiting...", { origin });
  }

  if (!landed && landedWithoutSession) {
    log.error("Browser reached the app origin but no Clerk session cookie exists", { appOrigin });
    return {
      ok: false,
      error: `Browser reached ${appOrigin} but has no Clerk session. CLERK_SECRET_KEY probably belongs to a different Clerk instance than this app. Use this app's development key.`,
    };
  }

  if (!landed) return timedOut();

  // -----------------------------------------------------------------------
  // Step 5: Update in-memory auth state
  // -----------------------------------------------------------------------

  const user = { email };
  authState = {
    user,
    timestamp: Date.now(),
  };

  return { ok: true, user };
}

const loginFlights = new Map<string, Promise<AuthLoginResponse>>();

/**
 * authenticate() with concurrent logins joined into one: sessions share a
 * cookie jar per shard, so one Agent Task serves every waiting caller.
 * Requests are joined by port and app base URL only; the first caller's
 * email, session, key and budget decide the outcome for all of them, and a
 * joiner's own signal is not watched. When the first caller's signal aborts,
 * the entry is dropped at once, so the next caller starts a fresh login.
 */
export function authenticateJoined(
  req: AuthLoginRequest,
  budget: LoginBudget,
  deps: Partial<AuthenticateDeps> = {},
): Promise<AuthLoginResponse> {
  const key = `${req.port}|${req.appBaseUrl || DEFAULT_AUTH_APP_BASE}`;
  const existing = loginFlights.get(key);
  if (existing) return existing;
  const forget = () => {
    if (loginFlights.get(key) === flight) loginFlights.delete(key);
  };
  const flight = authenticate(req, budget, deps).finally(forget);
  loginFlights.set(key, flight);
  budget.signal.addEventListener("abort", forget, { once: true });
  return flight;
}

// ---------------------------------------------------------------------------
// Auth status query
// ---------------------------------------------------------------------------

/**
 * Reset the cached user/lastLogin to defaults. Test-only: `authenticated` is
 * derived from the cookie jar, so production never needs to reset on crash.
 */
export function __resetAuthStateForTest(): void {
  authState = { user: null, timestamp: null };
}

/** Cap on the cookie probe so /auth/status cannot hang on a wedged agent-browser. */
const STATUS_PROBE_TIMEOUT_MS = 8_000;

/**
 * Report whether the shard's Chrome profile holds a Clerk session cookie.
 *
 * The cookie, not in-memory state, is the truth: it persists in the profile
 * across Chrome crashes and daemon restarts. `user` and `lastLogin` are
 * best-effort metadata from memory and may be null after a restart.
 *
 * `cookies get` is context-wide, so any `sessionId` works. The call spawns or
 * reuses an agent-browser helper process named `sessionId` that stays resident
 * like any other session helper.
 */
export async function getAuthStatus(
  opts: { port: number; sessionId: string; appBaseUrl: string },
): Promise<AuthStatusResponse> {
  const authenticated = await confirmClerkSession(
    opts.sessionId,
    opts.port,
    opts.appBaseUrl,
    STATUS_PROBE_TIMEOUT_MS,
  ).catch(() => false);
  return {
    ok: true,
    authenticated,
    user: authState.user,
    lastLogin: authState.timestamp ? new Date(authState.timestamp).toISOString() : null,
    port: opts.port,
    checkedVia: "cookie",
  };
}
