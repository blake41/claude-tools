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
import { authLoginDeadline } from "./config";
import type { AuthLoginRequest, AuthLoginResponse, AuthStatusResponse } from "./types";

const log = new Logger({ component: "auth" });

// ---------------------------------------------------------------------------
// In-memory auth state
// ---------------------------------------------------------------------------

interface AuthState {
  authenticated: boolean;
  user: { email: string } | null;
  timestamp: number | null;
}

let authState: AuthState = {
  authenticated: false,
  user: null,
  timestamp: null,
};

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_APP_BASE = "http://localhost:5173";

// ---------------------------------------------------------------------------
// Clerk client seam
// ---------------------------------------------------------------------------

/** The slice of @clerk/backend's client that authenticate() uses. */
export type AgentTaskClient = Pick<ClerkClient, "agentTasks">;

export interface AuthenticateDeps {
  createClerkClient: (secretKey: string) => AgentTaskClient | Promise<AgentTaskClient>;
  /**
   * Absolute epoch-ms cutoff for the whole flow. Past it, authenticate()
   * returns a timeout failure and never sets authState. Defaults to the
   * daemon's login budget measured from the call.
   */
  deadline?: number;
  pollIntervalMs?: number;
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
/** Per-call agent-browser cap; every call in the login flow is also capped at the time left. */
const STEP_TIMEOUT_MS = 15_000;

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
  deps: Partial<AuthenticateDeps> = {},
): Promise<AuthLoginResponse> {
  const { createClerkClient, deadline = authLoginDeadline(Date.now()), pollIntervalMs = 1_000 } = { ...defaultDeps, ...deps };
  const { sessionId, port } = req;
  const appBaseUrl = req.appBaseUrl || DEFAULT_APP_BASE;
  const email = req.email;

  // Never log the secret key.
  log.info("Starting auth flow", { sessionId, port, appBaseUrl, email });

  // -----------------------------------------------------------------------
  // Step 1: Check if already authenticated
  //
  // The short-circuit is origin-aware: being authenticated on worktree-A
  // must not skip auth for worktree-B. We compare the browser URL's origin
  // against the target appBaseUrl origin. When no appBaseUrl is provided, the
  // target is localhost:5173 (the DEFAULT_APP_BASE), so we check that.
  // -----------------------------------------------------------------------

  const urlResult = await runAgentBrowser(sessionId, port, ["get", "url"]);
  if (urlResult.ok && isAuthenticatedUrl(urlResult.stdout)) {
    // Determine target origin for the comparison.
    const targetBase = appBaseUrl || DEFAULT_APP_BASE;
    let targetOrigin: string;
    try {
      targetOrigin = new URL(targetBase).origin;
    } catch {
      targetOrigin = targetBase;
    }

    let browserOrigin: string;
    try {
      browserOrigin = new URL(urlResult.stdout).origin;
    } catch {
      browserOrigin = "";
    }

    if (browserOrigin === targetOrigin) {
      log.info("Browser already on authenticated page for same origin — skipping login", {
        url: urlResult.stdout,
        targetOrigin,
      });
      authState = {
        authenticated: true,
        user: authState.user, // preserve existing user info
        timestamp: Date.now(),
      };
      return { ok: true, user: authState.user ?? undefined };
    }

    log.info("Browser is authenticated but on a different origin — proceeding with login", {
      browserOrigin,
      targetOrigin,
    });
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
    const clerk = await createClerkClient(secretKey!);
    log.info("Minting Agent Task", { email, appBaseUrl });
    const task = await clerk.agentTasks.create({
      onBehalfOf: { identifier: email },
      permissions: "*",
      agentName: "ab",
      taskDescription: "ab reauth",
      redirectUrl: `${appBaseUrl}/`,
      sessionMaxDurationInSeconds: AGENT_TASK_SESSION_SECONDS,
    });
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

  let appOrigin: string;
  try {
    appOrigin = new URL(appBaseUrl).origin;
  } catch {
    appOrigin = appBaseUrl;
  }
  const timeLeft = () => deadline - Date.now();
  const timedOut = (): AuthLoginResponse => {
    log.error("Browser did not land on the app origin before the deadline", { appOrigin });
    return {
      ok: false,
      error: `Auth exchange timed out: browser did not land on ${appOrigin}. The Agent Task URL is one-time, so retry the reauth.`,
    };
  };

  if (timeLeft() <= 0) return timedOut();
  const secrets = [secretKey, taskUrl, ticketOf(taskUrl)];
  const navResult = await runAgentBrowser(sessionId, port, ["open", taskUrl], Math.min(STEP_TIMEOUT_MS, timeLeft()));
  if (!navResult.ok) {
    if (timeLeft() <= 0) return timedOut();
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
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, Math.min(pollIntervalMs, Math.max(0, timeLeft()))));
    if (timeLeft() <= 0) break;
    const verifyResult = await runAgentBrowser(sessionId, port, ["get", "url"], Math.min(STEP_TIMEOUT_MS, timeLeft()));
    if (!verifyResult.ok) {
      log.warn("Could not read browser URL during poll");
      continue;
    }
    let origin = "";
    try {
      origin = new URL(verifyResult.stdout).origin;
    } catch { /* not a URL yet */ }
    if (origin === appOrigin && !verifyResult.stdout.includes("/sign-in")) {
      if (timeLeft() <= 0) break;
      if (await confirmClerkSession(sessionId, port, appOrigin, Math.min(STEP_TIMEOUT_MS, timeLeft()))) {
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

  // The handler's withTimeout fires after `deadline`. A landing confirmed past
  // it may already have been reported to the CLI as a failure: do not record it.
  if (timeLeft() <= 0) return timedOut();

  // -----------------------------------------------------------------------
  // Step 5: Update in-memory auth state
  // -----------------------------------------------------------------------

  const user = { email };
  authState = {
    authenticated: true,
    user,
    timestamp: Date.now(),
  };

  return { ok: true, user };
}

// ---------------------------------------------------------------------------
// Auth status query
// ---------------------------------------------------------------------------

/**
 * Reset auth state to defaults. Call when Chrome crashes/restarts
 * so the next agent command triggers a fresh login.
 */
export function resetAuthState(): void {
  authState = { authenticated: false, user: null, timestamp: null };
}

export function getAuthStatus(): AuthStatusResponse {
  return {
    ok: true,
    authenticated: authState.authenticated,
    user: authState.user,
    lastLogin: authState.timestamp ? new Date(authState.timestamp).toISOString() : null,
  };
}
