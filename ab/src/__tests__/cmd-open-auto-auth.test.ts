import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test";
import { cmdOpen } from "../cli";
import { autoAuthAfterOpen } from "../auto-auth";
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
  loginTimeouts: number[];
  navCalls: Array<{ port: number; session: string | null; url: string }>;
}

function harness(opts: {
  env?: { CLERK_SECRET_KEY?: string };
  status?: () => Promise<AuthStatusResponse>;
  login?: () => Promise<AuthLoginResponse>;
  navigate?: () => Promise<unknown>;
  recordedId?: string | null;
}): Harness {
  if (opts.env?.CLERK_SECRET_KEY) process.env.CLERK_SECRET_KEY = opts.env.CLERK_SECRET_KEY;
  else delete process.env.CLERK_SECRET_KEY;
  const h: Harness = {
    order: [], statusCalls: [], loginCalls: [], loginTimeouts: [], navCalls: [],
    deps: undefined as unknown as CmdOpenDeps,
  };
  h.deps = {
    openTab: async () => { h.order.push("openTab"); return opts.recordedId === undefined ? "TAB1" : opts.recordedId; },
    setViewport: async () => { h.order.push("viewport"); },
    afterOpen: (url, recordedId, port, session) => autoAuthAfterOpen(url, recordedId, port, session, {
      authStatus: async (o) => {
        h.order.push("status");
        h.statusCalls.push(o);
        return (opts.status ?? (async () => status(false)))();
      },
      authLogin: async (r, o) => {
        h.order.push("login");
        h.loginCalls.push(r);
        h.loginTimeouts.push(o.timeoutMs);
        return (opts.login ?? (async () => ({ ok: true })))();
      },
      navigate: async (port, session, url) => {
        h.order.push("navigate");
        h.navCalls.push({ port, session, url });
        return (opts.navigate ?? (async () => undefined))();
      },
    }),
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
const prevKey = process.env.CLERK_SECRET_KEY;
beforeEach(() => {
  delete process.env.CLERK_SECRET_KEY;
});
afterEach(() => {
  if (prevKey === undefined) delete process.env.CLERK_SECRET_KEY;
  else process.env.CLERK_SECRET_KEY = prevKey;
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

  test("authenticated session: status checked, no login, no re-navigation", async () => {
    const h = harness({ env: KEY, status: async () => status(true) });
    expect(await cmdOpen(DEV_URL, 9333, "sess", "p", h.deps)).toBe(0);
    expect(h.order).toEqual(["openTab", "viewport", "status"]);
    expect(h.navCalls).toEqual([]);
    expect(h.loginCalls).toEqual([]);
    expect(h.statusCalls).toEqual([{ port: 9333, sessionId: "sess", appBaseUrl: "http://localhost:5173" }]);
  });

  test("unauthenticated with key: tab first, then one login with the key in the body, then re-navigation", async () => {
    const h = harness({ env: KEY });
    expect(await cmdOpen(DEV_URL, 9333, "sess", "p", h.deps)).toBe(0);
    expect(h.order).toEqual(["openTab", "viewport", "status", "login", "navigate"]);
    expect(h.navCalls).toEqual([{ port: 9333, session: "sess", url: DEV_URL }]);
    expect(h.loginTimeouts).toEqual([30_000]);
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
    expect(h.order).toEqual(["openTab", "viewport", "status"]);
    const hints = lines.filter((l) => l.includes("ab reauth") && l.includes("CLERK_SECRET_KEY"));
    expect(hints).toHaveLength(1);
    expect(lines).toHaveLength(1);
  });

  test("login result ok:false: one warning, no re-navigation", async () => {
    const lines = captureStderr();
    const h = harness({ env: KEY, login: async () => ({ ok: false, error: "mint refused" }) });
    expect(await cmdOpen(DEV_URL, 9333, "sess", "p", h.deps)).toBe(0);
    expect(h.order).toEqual(["openTab", "viewport", "status", "login"]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("mint refused");
    expect(lines[0]).not.toContain("sk_test_abc");
  });

  test("login RPC throws: one warning, no re-navigation", async () => {
    const lines = captureStderr();
    const h = harness({ env: KEY, login: async () => { throw new Error("ab-server not running"); } });
    expect(await cmdOpen(DEV_URL, 9333, "sess", "p", h.deps)).toBe(0);
    expect(h.order).toEqual(["openTab", "viewport", "status", "login"]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("ab-server not running");
  });

  test("status RPC throws: one warning, no login, open proceeds", async () => {
    const lines = captureStderr();
    const h = harness({ env: KEY, status: async () => { throw new Error("timeout"); } });
    expect(await cmdOpen(DEV_URL, 9333, "sess", "p", h.deps)).toBe(0);
    expect(h.loginCalls).toEqual([]);
    expect(h.order).toEqual(["openTab", "viewport", "status"]);
    expect(lines).toHaveLength(1);
  });

  test("unrecorded tab on a dev origin: no RPC, one hint to run ab reauth", async () => {
    const lines = captureStderr();
    const h = harness({ env: KEY, recordedId: null });
    expect(await cmdOpen(DEV_URL, 9333, "sess", "p", h.deps)).toBe(0);
    expect(h.order).toEqual(["openTab"]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("ab reauth");
  });

  test("unrecorded tab on a non-dev origin: silent", async () => {
    const lines = captureStderr();
    const h = harness({ env: KEY, recordedId: null });
    await cmdOpen("https://google.com/", 9333, "sess", "p", h.deps);
    expect(lines).toEqual([]);
  });

  test("re-navigation failure after a good login: one warning, exit 0", async () => {
    const lines = captureStderr();
    const h = harness({ env: KEY, navigate: async () => { throw new Error("nav boom"); } });
    expect(await cmdOpen(DEV_URL, 9333, "sess", "p", h.deps)).toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("nav boom");
  });
});
