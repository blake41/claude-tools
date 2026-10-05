import { loginRequest } from "./login-request";
import { autoAuthOrigin } from "./app-origins";
import type { AuthLoginRequest, AuthLoginResponse, AuthStatusResponse } from "./types";

function warn(text: string): void {
  process.stderr.write(text + "\n");
}

export interface AutoAuthDeps {
  authStatus: (opts: { port: number; sessionId: string; appBaseUrl: string }) => Promise<AuthStatusResponse>;
  authLogin: (req: AuthLoginRequest, opts: { timeoutMs: number }) => Promise<AuthLoginResponse>;
  navigate: (cdpPort: number, sessionName: string | null, url: string) => Promise<unknown>;
}

/** Client cap for the auto-auth login so a hung login cannot hold `ab open` for the full 65s RPC budget. */
export const AUTO_AUTH_LOGIN_TIMEOUT_MS = 30_000;

/**
 * Logs in after the session's own tab exists, when a dev app origin has no
 * Clerk session, then re-navigates that tab to `url`. Needs a recorded tab id:
 * the login drives the browser's focused target, which is only provably this
 * session's tab when its creation was recorded. Never throws.
 */
export async function autoAuthAfterOpen(
  url: string,
  recordedId: string | null,
  cdpPort: number,
  sessionName: string | null,
  deps: AutoAuthDeps,
): Promise<void> {
  const appBaseUrl = autoAuthOrigin(url);
  if (!appBaseUrl) return;
  if (recordedId === null) {
    warn(`ab: could not confirm this session's tab, so skipped auto-login to ${appBaseUrl}; run \`ab reauth\` if you see a login screen`);
    return;
  }
  const request = loginRequest(cdpPort, sessionName, appBaseUrl, process.env.CLERK_SECRET_KEY);
  try {
    const status = await deps.authStatus({ port: cdpPort, sessionId: request.sessionId, appBaseUrl });
    if (status.authenticated) return;
    if (!request.clerkSecretKey) {
      warn(`ab: not logged in to ${appBaseUrl}; run \`ab reauth\` from a directory whose env has CLERK_SECRET_KEY`);
      return;
    }
    const result = await deps.authLogin(request, { timeoutMs: AUTO_AUTH_LOGIN_TIMEOUT_MS });
    if (!result.ok) {
      warn(`ab: auto-login to ${appBaseUrl} failed (${result.error ?? "unknown error"})`);
      return;
    }
    await deps.navigate(cdpPort, sessionName, url);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warn(`ab: auto-login to ${appBaseUrl} failed (${message})`);
  }
}
