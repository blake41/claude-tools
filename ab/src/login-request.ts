import type { AuthLoginRequest } from "./types";

// Default user for `reauth`. The Agent Task is minted by email.
// Override with AB_AUTH_EMAIL.
export const DEFAULT_AUTH_EMAIL = process.env.AB_AUTH_EMAIL ?? "blake.johnson@clay.com";

/** `clerkSecretKey` and `taskUrl` go in the request body only; never written to disk or logged. */
export function loginRequest(
  cdpPort: number,
  sessionName: string | null,
  appBaseUrl: string | undefined,
  clerkSecretKey?: string,
  taskUrl?: string,
): AuthLoginRequest {
  return {
    sessionId: sessionName ?? "default",
    port: cdpPort,
    email: DEFAULT_AUTH_EMAIL,
    appBaseUrl,
    clerkSecretKey,
    taskUrl,
  };
}
