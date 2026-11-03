import { test, expect, describe } from "bun:test";
import { mintProdTicketUrl, parseInfisicalSecret } from "../prod-ticket";

const SK = "sk_live_SUPERSECRET";
const AK = "ak_SECRETTOKEN";
const TICKET_URL = "https://clerk.terra.clay.com/v1/agents/tasks?ticket=TICKETSECRET";
const future = Date.now() + 86_400_000;

interface Call { url: string; init?: RequestInit }

function fakeFetch(overrides: { keys?: unknown[]; users?: unknown[]; mintStatus?: number } = {}) {
  const calls: Call[] = [];
  const keys = overrides.keys ?? [
    { id: "ak_revoked", revoked: true, expiration: null, scopes: ["agent:session:mint"] },
    { id: "ak_expired", revoked: false, expiration: Date.now() - 1000, scopes: ["agent:session:mint"] },
    { id: "ak_wrongscope", revoked: false, expiration: null, scopes: ["other"] },
    { id: "ak_good", revoked: false, expiration: future, scopes: ["x", "agent:session:mint"] },
  ];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const j = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (url.startsWith("https://api.clerk.com/v1/users?")) return j(overrides.users ?? [{ id: "user_1" }]);
    if (url.startsWith("https://api.clerk.com/v1/api_keys?")) return j({ data: keys });
    if (url === "https://api.clerk.com/v1/api_keys/ak_good/secret") return j({ secret: AK });
    if (url === "https://www.terra.clay.com/api/agent-sessions") {
      return overrides.mintStatus && overrides.mintStatus !== 200
        ? j({ error: `denied ${AK}` }, overrides.mintStatus)
        : j({ url: TICKET_URL });
    }
    return j({ error: "unexpected" }, 500);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const deps = (f: typeof fetch) => ({ readClerkSecret: async () => SK, fetch: f });

describe("mintProdTicketUrl", () => {
  test("walks user -> api key -> secret -> agent-sessions and returns the ticket URL", async () => {
    const { fn, calls } = fakeFetch();
    const r = await mintProdTicketUrl("blake.johnson@clay.com", deps(fn));
    expect(r).toEqual({ ok: true, url: TICKET_URL });
    expect(calls[0].url).toBe("https://api.clerk.com/v1/users?email_address=blake.johnson%40clay.com");
    expect(calls[1].url).toBe("https://api.clerk.com/v1/api_keys?subject=user_1&limit=20");
    expect(calls[2].url).toBe("https://api.clerk.com/v1/api_keys/ak_good/secret");
    const bapi = calls[0].init?.headers as Record<string, string>;
    expect(bapi.Authorization).toBe(`Bearer ${SK}`);
    expect(bapi["Clerk-API-Version"]).toBe("2025-04-10");
    expect(bapi["User-Agent"]).toStartWith("@clerk/backend@");
    const mint = calls[3];
    expect(mint.init?.method).toBe("POST");
    expect((mint.init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${AK}`);
    expect(mint.init?.body).toBe("{}");
  });

  test("errors clearly when no usable key has agent:session:mint", async () => {
    const { fn } = fakeFetch({ keys: [{ id: "k", revoked: false, expiration: null, scopes: ["other"] }] });
    const r = await mintProdTicketUrl("blake.johnson@clay.com", deps(fn));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("agent:session:mint");
  });

  test("errors when the user does not exist", async () => {
    const { fn } = fakeFetch({ users: [] });
    const r = await mintProdTicketUrl("nobody@clay.com", deps(fn));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("nobody@clay.com");
  });

  test("redacts secrets from a failing mint response", async () => {
    const { fn } = fakeFetch({ mintStatus: 403 });
    const r = await mintProdTicketUrl("blake.johnson@clay.com", deps(fn));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("403");
      expect(r.error).not.toContain(AK);
      expect(r.error).not.toContain(SK);
    }
  });

  test("reports an Infisical failure without leaking", async () => {
    const r = await mintProdTicketUrl("a@clay.com", {
      readClerkSecret: async () => { throw new Error("infisical-api exited 1"); },
      fetch: fakeFetch().fn,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("infisical-api exited 1");
  });

  test("refuses a ticket URL that is not on clerk.terra.clay.com", async () => {
    const calls: string[] = [];
    const f = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/users?")) return new Response(JSON.stringify([{ id: "u" }]));
      if (url.includes("/api_keys?")) return new Response(JSON.stringify({ data: [{ id: "ak_good", revoked: false, expiration: null, scopes: ["agent:session:mint"] }] }));
      if (url.endsWith("/secret")) return new Response(JSON.stringify({ secret: AK }));
      return new Response(JSON.stringify({ url: "https://evil.example/x?ticket=TICKETSECRET" }));
    }) as unknown as typeof fetch;
    const r = await mintProdTicketUrl("a@clay.com", deps(f));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).not.toContain("TICKETSECRET");
  });
});

describe("parseInfisicalSecret", () => {
  test("reads result.secretValue", () => {
    expect(parseInfisicalSecret(JSON.stringify({ result: { secretValue: "sk_live_x" } }))).toBe("sk_live_x");
  });
  test("reads secret.secretValue", () => {
    expect(parseInfisicalSecret(JSON.stringify({ secret: { secretValue: "sk_live_y" } }))).toBe("sk_live_y");
  });
  test("throws without echoing the payload when there is no value", () => {
    expect(() => parseInfisicalSecret(JSON.stringify({ result: { other: "SHH" } }))).toThrow(/no secret value/);
    try { parseInfisicalSecret("not json SHH"); } catch (e) { expect(String(e)).not.toContain("SHH"); }
  });
});
