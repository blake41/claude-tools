import { test, expect, describe, afterEach, spyOn } from "bun:test";
import { cmdOpen } from "../cli";
import type { CmdOpenDeps } from "../cli";
import type { AuthLoginRequest, AuthLoginResponse, AuthStatusResponse } from "../types";

const DEV_URL = "http://localhost:5173/accounts";

function status(authenticated: boolean): AuthStatusResponse {
  return { ok: true, authenticated, user: null, lastLogin: null, port: 9333, checkedVia: "cookie" };
}

interface Harness {
  deps: CmdOpenDeps;
  order: string[];
  statusCalls: Array<{ port?: number; sessionId?: string; appBaseUrl?: string }>;
  loginCalls: AuthLoginRequest[];
}

function harness(opts: {
  env?: { CLERK_SECRET_KEY?: string };
  status?: () => Promise<AuthStatusResponse>;
  login?: () => Promise<AuthLoginResponse>;
}): Harness {
  const h: Harness = { order: [], statusCalls: [], loginCalls: [], deps: undefined as unknown as CmdOpenDeps };
  h.deps = {
    openTab: async () => { h.order.push("openTab"); return "TAB1"; },
    setViewport: async () => { h.order.push("viewport"); },
    autoAuth: {
      env: opts.env ?? {},
      authStatus: async (o) => {
        h.order.push("status");
        h.statusCalls.push(o);
        return (opts.status ?? (async () => status(false)))();
      },
      authLogin: async (r) => {
        h.order.push("login");
        h.loginCalls.push(r);
        return (opts.login ?? (async () => ({ ok: true })))();
      },
    },
  };
  return h;
}

let stderrSpy: ReturnType<typeof spyOn> | undefined;
function captureStderr(): string[] {
  const lines: string[] = [];
  stderrSpy = spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as never);
  return lines;
}
afterEach(() => {
  stderrSpy?.mockRestore();
  stderrSpy = undefined;
});

const KEY = { CLERK_SECRET_KEY: "sk_test_abc" };

describe("cmdOpen auto-auth", () => {
  test("non-dev origins make no RPC at all", async () => {
    for (const url of ["https://terra.clay.com/", "https://google.com/", "not a url", "about:blank"]) {
      const h = harness({ env: KEY });
      await cmdOpen(url, 9333, "s", "p", h.deps);
      expect(h.order).toEqual(["openTab", "viewport"]);
    }
  });

  test("authenticated session: status checked, no login, tab opened", async () => {
    const h = harness({ env: KEY, status: async () => status(true) });
    expect(await cmdOpen(DEV_URL, 9333, "sess", "p", h.deps)).toBe(0);
    expect(h.order).toEqual(["status", "openTab", "viewport"]);
    expect(h.loginCalls).toEqual([]);
    expect(h.statusCalls).toEqual([{ port: 9333, sessionId: "sess", appBaseUrl: "http://localhost:5173" }]);
  });

  test("unauthenticated with key: one login with the key in the body, before the tab opens", async () => {
    const h = harness({ env: KEY });
    expect(await cmdOpen(DEV_URL, 9333, "sess", "p", h.deps)).toBe(0);
    expect(h.order).toEqual(["status", "login", "openTab", "viewport"]);
    expect(h.loginCalls).toHaveLength(1);
    expect(h.loginCalls[0]).toMatchObject({
      sessionId: "sess",
      port: 9333,
      appBaseUrl: "http://localhost:5173",
      clerkSecretKey: "sk_test_abc",
    });
  });

  test("session without a name logs in as default", async () => {
    const h = harness({ env: KEY });
    await cmdOpen(DEV_URL, 9333, null, "p", h.deps);
    expect(h.statusCalls[0].sessionId).toBe("default");
    expect(h.loginCalls[0].sessionId).toBe("default");
  });

  test("unauthenticated without key: one stderr hint, no login, open proceeds", async () => {
    const lines = captureStderr();
    const h = harness({ env: {} });
    expect(await cmdOpen(DEV_URL, 9333, "sess", "p", h.deps)).toBe(0);
    expect(h.loginCalls).toEqual([]);
    expect(h.order).toEqual(["status", "openTab", "viewport"]);
    const hints = lines.filter((l) => l.includes("ab reauth") && l.includes("CLERK_SECRET_KEY"));
    expect(hints).toHaveLength(1);
    expect(lines).toHaveLength(1);
  });

  test("login result ok:false: one warning, open proceeds", async () => {
    const lines = captureStderr();
    const h = harness({ env: KEY, login: async () => ({ ok: false, error: "mint refused" }) });
    expect(await cmdOpen(DEV_URL, 9333, "sess", "p", h.deps)).toBe(0);
    expect(h.order).toEqual(["status", "login", "openTab", "viewport"]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("mint refused");
    expect(lines[0]).not.toContain("sk_test_abc");
  });

  test("login RPC throws: one warning, open proceeds", async () => {
    const lines = captureStderr();
    const h = harness({ env: KEY, login: async () => { throw new Error("ab-server not running"); } });
    expect(await cmdOpen(DEV_URL, 9333, "sess", "p", h.deps)).toBe(0);
    expect(h.order).toEqual(["status", "login", "openTab", "viewport"]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("ab-server not running");
  });

  test("status RPC throws: one warning, no login, open proceeds", async () => {
    const lines = captureStderr();
    const h = harness({ env: KEY, status: async () => { throw new Error("timeout"); } });
    expect(await cmdOpen(DEV_URL, 9333, "sess", "p", h.deps)).toBe(0);
    expect(h.loginCalls).toEqual([]);
    expect(h.order).toEqual(["status", "openTab", "viewport"]);
    expect(lines).toHaveLength(1);
  });

  test("a thrown error that contains the key is redacted from the warning", async () => {
    const lines = captureStderr();
    const h = harness({ env: KEY, login: async () => { throw new Error("bad sk_test_abc here"); } });
    await cmdOpen(DEV_URL, 9333, "sess", "p", h.deps);
    expect(lines.join("")).not.toContain("sk_test_abc");
  });
});
