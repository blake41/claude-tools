/**
 * Dev-login authentication flow for ab-server.
 *
 * Uses Terra's POST /auth/dev-login endpoint to mint a Clerk sign-in token,
 * then navigates the browser to the exchange URL to establish a real session.
 *
 * Two-origin model (local dev):
 *   apiBaseUrl  → backend (port 8000) — where POST /auth/dev-login goes
 *   appBaseUrl  → frontend (port 5173) — where browser exchanges the ticket
 *
 * In staging both collapse to the same origin.
 */

import { Logger } from "./logger";
import type { AuthLoginRequest, AuthLoginResponse, AuthStatusResponse } from "./types";

const log = new Logger({ component: "auth" });

// ---------------------------------------------------------------------------
// In-memory auth state
// ---------------------------------------------------------------------------

interface AuthState {
  authenticated: boolean;
  user: { slackUserId: string; email: string } | null;
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

const DEFAULT_API_BASE = "http://localhost:8000";
const DEFAULT_APP_BASE = "http://localhost:5173";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function runAgentBrowser(
  sessionId: string,
  port: number,
  args: string[],
  timeoutMs = 15_000,
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

/**
 * Check whether the browser is already on an authenticated page.
 * An authenticated page is a Clay URL that is NOT /dev-login or /sign-in.
 */
function isAuthenticatedUrl(url: string): boolean {
  if (!url) return false;
  const clayPatterns = ["localhost:5173", "onrender.com", "terra.clay.com"];
  const isClay = clayPatterns.some((p) => url.includes(p));
  if (!isClay) return false;
  const unauthPaths = ["/dev-login", "/sign-in"];
  return !unauthPaths.some((p) => url.includes(p));
}

// ---------------------------------------------------------------------------
// Main authenticate flow
// ---------------------------------------------------------------------------

export async function authenticate(req: AuthLoginRequest): Promise<AuthLoginResponse> {
  const { sessionId, port } = req;
  const apiBaseUrl = req.apiBaseUrl || DEFAULT_API_BASE;
  const appBaseUrl = req.appBaseUrl || DEFAULT_APP_BASE;
  const slackUserId = req.slackUserId;

  log.info("Starting auth flow", { sessionId, port, apiBaseUrl, appBaseUrl, slackUserId });

  // -----------------------------------------------------------------------
  // Step 1: Check if already authenticated
  // -----------------------------------------------------------------------

  const urlResult = await runAgentBrowser(sessionId, port, ["get", "url"]);
  if (urlResult.ok && isAuthenticatedUrl(urlResult.stdout)) {
    log.info("Browser already on authenticated page — skipping login", { url: urlResult.stdout });
    authState = {
      authenticated: true,
      user: authState.user, // preserve existing user info
      timestamp: Date.now(),
    };
    return { ok: true, user: authState.user ?? undefined };
  }

  // -----------------------------------------------------------------------
  // Step 2: POST /auth/dev-login to get a sign-in token
  // -----------------------------------------------------------------------

  if (!slackUserId) {
    return { ok: false, error: "slackUserId is required for dev-login" };
  }

  let token: string;
  let userEmail: string | undefined;

  try {
    const loginUrl = `${apiBaseUrl}/auth/dev-login`;
    log.info("Requesting dev-login token", { loginUrl, slackUserId });

    const resp = await fetch(loginUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slackUserId }),
      signal: AbortSignal.timeout(5_000),
    });

    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      const msg = (body as Record<string, string>).message || `HTTP ${resp.status}`;

      if (resp.status === 404 && (body as Record<string, string>).error === "user_not_found") {
        return { ok: false, error: "User not found. Must log in via Google OAuth first." };
      }

      log.error("dev-login request failed", { status: resp.status, msg });
      return { ok: false, error: `dev-login failed: ${msg}` };
    }

    const data = await resp.json() as Record<string, unknown>;
    if (typeof data.token !== 'string' || !data.token) {
      return { ok: false, error: 'dev-login returned invalid response: missing token' };
    }
    token = data.token;
    userEmail = typeof data.email === 'string' ? data.email : undefined;

    log.info("Got dev-login token", { exchangeUrl: data.exchangeUrl });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("fetch") || message.includes("ECONNREFUSED") || message.includes("timeout")) {
      return { ok: false, error: `Dev server unreachable at ${apiBaseUrl}` };
    }
    return { ok: false, error: `dev-login request error: ${message}` };
  }

  // -----------------------------------------------------------------------
  // Step 3: Navigate browser to exchange the ticket
  // -----------------------------------------------------------------------

  const exchangeUrl = `${appBaseUrl}/dev-login?ticket=${token}`;
  log.info("Navigating to exchange URL", { exchangeUrl });

  const navResult = await runAgentBrowser(sessionId, port, ["open", exchangeUrl]);
  if (!navResult.ok) {
    log.error("Navigation failed", { stderr: navResult.stderr });
    return { ok: false, error: `Auth exchange failed: browser navigation error` };
  }

  // -----------------------------------------------------------------------
  // Step 4: Wait for network idle
  // -----------------------------------------------------------------------

  const waitResult = await runAgentBrowser(sessionId, port, ["wait", "--load", "networkidle"], 30_000);
  if (!waitResult.ok) {
    log.warn("Wait for networkidle returned non-zero", { stderr: waitResult.stderr });
    // Continue anyway — the page may have loaded fine
  }

  // -----------------------------------------------------------------------
  // Step 5: Verify the browser is no longer on /dev-login
  // -----------------------------------------------------------------------

  const verifyResult = await runAgentBrowser(sessionId, port, ["get", "url"]);
  if (!verifyResult.ok) {
    log.error("Could not read browser URL after exchange", { stderr: verifyResult.stderr });
    return { ok: false, error: "Auth exchange failed: could not verify final URL" };
  }

  const finalUrl = verifyResult.stdout;
  if (finalUrl.includes("/dev-login")) {
    log.error("Browser still on /dev-login after exchange", { finalUrl });
    return { ok: false, error: "Auth exchange failed: browser did not redirect after ticket exchange" };
  }

  log.info("Auth exchange succeeded", { finalUrl });

  // -----------------------------------------------------------------------
  // Step 6: Update in-memory auth state
  // -----------------------------------------------------------------------

  const user = { slackUserId, email: userEmail ?? "" };
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
 * so the next agent command triggers a fresh dev-login.
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
