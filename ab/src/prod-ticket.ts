/**
 * Production sign-in ticket for `ab reauth --prod`.
 *
 * Production Terra runs on a Clerk production instance, where Agent Tasks are
 * unavailable, so the ticket comes from Terra's own `POST /api/agent-sessions`,
 * authenticated with the user's `ak_` Clerk API key (scope agent:session:mint).
 * That key is fetched through the instance's Clerk secret key, which is read
 * from Infisical. Everything stays in memory: nothing is written to disk, and
 * no secret, key or ticket appears in a returned error.
 */

import { PROD_APP_BASE } from "./app-origins";

const INFISICAL_PROJECT_ID = "320dfa64-a77c-4a51-ba4f-6ccbc21208ef";
const INFISICAL_ENV = "production";
const CLERK_BAPI = "https://api.clerk.com/v1";
const MINT_SCOPE = "agent:session:mint";
export const PROD_TICKET_HOST = "clerk.terra.clay.com";
const REQUEST_TIMEOUT_MS = 10_000;

export interface ProdTicketDeps {
  readClerkSecret: () => Promise<string>;
  fetch: typeof fetch;
}

export type ProdTicketResult = { ok: true; url: string } | { ok: false; error: string };

/** The value of an `infisical-api secrets get --json` payload. Never echoes the payload. */
export function parseInfisicalSecret(stdout: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("infisical-api returned non-JSON output");
  }
  const o = parsed as {
    result?: { secret?: { secretValue?: unknown }; secretValue?: unknown };
    secret?: { secretValue?: unknown };
    secretValue?: unknown;
  };
  const value = o?.result?.secret?.secretValue ?? o?.result?.secretValue ?? o?.secret?.secretValue ?? o?.secretValue;
  if (typeof value !== "string" || !value) throw new Error("infisical-api returned no secret value");
  return value;
}

async function readClerkSecretFromInfisical(): Promise<string> {
  const proc = Bun.spawn(
    ["infisical-api", "secrets", "get", "CLERK_SECRET_KEY", "-p", INFISICAL_PROJECT_ID, "-e", INFISICAL_ENV],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
  if (code !== 0) throw new Error(`infisical-api exited ${code} reading the production Clerk secret`);
  return parseInfisicalSecret(stdout);
}

const defaultDeps: ProdTicketDeps = { readClerkSecret: readClerkSecretFromInfisical, fetch };

class MintError extends Error {}

function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join("[redacted]");
  return out;
}

export async function mintProdTicketUrl(email: string, deps: Partial<ProdTicketDeps> = {}): Promise<ProdTicketResult> {
  const { readClerkSecret, fetch: doFetch } = { ...defaultDeps, ...deps };
  const secrets: string[] = [];
  const call = async (url: string, init: RequestInit, what: string): Promise<unknown> => {
    const res = await doFetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) throw new MintError(`${what} failed (HTTP ${res.status})`);
    return res.json();
  };
  try {
    const sk = await readClerkSecret();
    secrets.push(sk);
    const bapi = {
      Authorization: `Bearer ${sk}`,
      "Clerk-API-Version": "2025-04-10",
      // Cloudflare in front of Clerk rejects some default client user agents.
      "User-Agent": "@clerk/backend@3.2.8",
    };

    const users = (await call(`${CLERK_BAPI}/users?email_address=${encodeURIComponent(email)}`, { headers: bapi }, "Clerk user lookup")) as Array<{ id?: string }>;
    const userId = users?.[0]?.id;
    if (!userId) throw new MintError(`No production Clerk user for ${email}`);

    const list = (await call(`${CLERK_BAPI}/api_keys?subject=${encodeURIComponent(userId)}&limit=20`, { headers: bapi }, "Clerk API key list")) as {
      data?: Array<{ id: string; revoked?: boolean; expiration?: number | null; scopes?: string[] }>;
    };
    const now = Date.now();
    const key = (list.data ?? []).find(
      (k) => !k.revoked && (k.expiration == null || k.expiration > now) && k.scopes?.includes(MINT_SCOPE),
    );
    if (!key) {
      throw new MintError(`${email} has no active Clerk API key with scope ${MINT_SCOPE}; create one for the user in Clerk, or use \`ab import\``);
    }

    const keySecret = (await call(`${CLERK_BAPI}/api_keys/${encodeURIComponent(key.id)}/secret`, { headers: bapi }, "Clerk API key secret fetch")) as { secret?: string };
    if (!keySecret.secret) throw new MintError("Clerk returned no API key secret");
    secrets.push(keySecret.secret);

    const minted = (await call(
      `${PROD_APP_BASE}/api/agent-sessions`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${keySecret.secret}`, "Content-Type": "application/json" },
        body: "{}",
      },
      "Terra agent-sessions mint",
    )) as { url?: unknown };
    if (typeof minted?.url !== "string") throw new MintError("Terra agent-sessions returned no url");
    secrets.push(minted.url);
    let ticketUrl: URL;
    try {
      ticketUrl = new URL(minted.url);
    } catch {
      throw new MintError("Terra agent-sessions returned an invalid url");
    }
    if (ticketUrl.protocol !== "https:" || ticketUrl.hostname !== PROD_TICKET_HOST) {
      throw new MintError(`Terra agent-sessions returned a url outside ${PROD_TICKET_HOST}`);
    }
    return { ok: true, url: minted.url };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Production sign-in failed: ${redact(raw, secrets)}` };
  }
}
