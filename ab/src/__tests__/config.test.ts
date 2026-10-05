/**
 * Shared port / pool config. The daemon and the CLI are separate processes
 * that each resolve this from their own env, so the pure `resolveConfig(env)`
 * is the contract both rely on.
 */
import { test, expect, describe } from "bun:test";
import {
  resolveConfig,
  HEADLESS_BASE_PORT,
  HEADED_PORT,
  DASHBOARD_PORT,
  HEADLESS_POOL_SIZE,
  headlessPortForShard,
  AUTH_LOGIN_TIMEOUT_MS,
  AUTH_LOGIN_CLIENT_TIMEOUT_MS,
  AUTH_DEADLINE_GUARD_MS,
  authLoginDeadline,
} from "../config";

describe("module-level constants", () => {
  test("are resolveConfig(process.env)", () => {
    expect({
      headlessBasePort: HEADLESS_BASE_PORT,
      headedPort: HEADED_PORT,
      dashboardPort: DASHBOARD_PORT,
      headlessPoolSize: HEADLESS_POOL_SIZE,
    }).toEqual(resolveConfig(process.env));
  });

  test("headlessPortForShard(i) is base + i", () => {
    expect(headlessPortForShard(0)).toBe(HEADLESS_BASE_PORT);
    expect(headlessPortForShard(2)).toBe(HEADLESS_BASE_PORT + 2);
  });
});

describe("resolveConfig", () => {
  test("defaults when no AB_* env is set", () => {
    expect(resolveConfig({})).toEqual({
      headlessBasePort: 9333,
      headedPort: 9444,
      dashboardPort: 4848,
      headlessPoolSize: 3,
    });
  });

  test("AB_BASE_PORT / AB_HEADED_PORT / AB_DASHBOARD_PORT overrides are parsed", () => {
    expect(
      resolveConfig({ AB_BASE_PORT: "29333", AB_HEADED_PORT: " 29444 ", AB_DASHBOARD_PORT: "24848" }),
    ).toEqual({
      headlessBasePort: 29333,
      headedPort: 29444,
      dashboardPort: 24848,
      headlessPoolSize: 3,
    });
  });

  test.each([
    ["1", 1],
    ["5", 5],
    ["8", 8],
    ["9", 8], // clamps to the 8-shard maximum
    ["0", 1], // clamps to the 1-shard minimum
    ["-3", 1],
    ["", 3],
    ["   ", 3],
    ["lots", 3], // unparseable falls back to the default, never throws
  ])("AB_HEADLESS_POOL_SIZE=%p resolves to %p shards", (raw, expected) => {
    expect(resolveConfig({ AB_HEADLESS_POOL_SIZE: raw }).headlessPoolSize).toBe(expected);
  });

  test("headless range running past 65535 throws naming AB_BASE_PORT", () => {
    expect(() => resolveConfig({ AB_BASE_PORT: "65534", AB_HEADLESS_POOL_SIZE: "3" })).toThrow(
      "AB_BASE_PORT=65534 with 3 headless shards needs ports 65534-65536; the top exceeds 65535",
    );
  });

  test.each([
    ["AB_HEADED_PORT", { AB_BASE_PORT: "9443", AB_HEADED_PORT: "9444" }, 9444],
    ["AB_DASHBOARD_PORT", { AB_BASE_PORT: "4847", AB_DASHBOARD_PORT: "4848" }, 4848],
  ])("%s inside the headless shard range throws", (name, env, port) => {
    expect(() => resolveConfig(env)).toThrow(
      `${name}=${port} collides with a headless shard port (AB_BASE_PORT=${env.AB_BASE_PORT}, 3 shards)`,
    );
  });

  test("headed and dashboard on the same port throws", () => {
    expect(() => resolveConfig({ AB_HEADED_PORT: "5000", AB_DASHBOARD_PORT: "5000" })).toThrow(
      "AB_HEADED_PORT and AB_DASHBOARD_PORT must differ (both 5000)",
    );
  });

  test.each([
    ["AB_BASE_PORT", "abc"],
    ["AB_BASE_PORT", "9333abc"],
    ["AB_HEADED_PORT", "1023"],
    ["AB_HEADED_PORT", "65536"],
    ["AB_DASHBOARD_PORT", "48.5"],
    ["AB_DASHBOARD_PORT", "-4848"],
  ])("%s=%s throws a message naming the variable", (name, value) => {
    expect(() => resolveConfig({ [name]: value })).toThrow(
      `${name} must be an integer port between 1024 and 65535 (got "${value}")`,
    );
  });
});

// The daemon wraps /auth/login in withTimeout(AUTH_LOGIN_TIMEOUT_MS) and hands
// authenticate() the deadline authLoginDeadline(startedAt). authenticate()
// refuses to set authState once that deadline has passed, so it must fall
// strictly before the handler's own timeout: otherwise withTimeout could
// already have rejected (CLI sees failure) while the login still lands.
describe("auth login budgets", () => {
  test("the login handler budget is 60 s", () => {
    expect(AUTH_LOGIN_TIMEOUT_MS).toBe(60_000);
  });

  test("authenticate's deadline falls strictly before the handler timeout fires", () => {
    const t = 1_759_600_000_000;
    expect(AUTH_DEADLINE_GUARD_MS).toBeGreaterThan(0);
    expect(authLoginDeadline(t)).toBe(t + AUTH_LOGIN_TIMEOUT_MS - AUTH_DEADLINE_GUARD_MS);
    expect(authLoginDeadline(t)).toBeLessThan(t + AUTH_LOGIN_TIMEOUT_MS);
  });

  test("the CLI waits longer than the daemon's handler budget", () => {
    expect(AUTH_LOGIN_CLIENT_TIMEOUT_MS).toBe(AUTH_LOGIN_TIMEOUT_MS + 5_000);
    expect(AUTH_LOGIN_CLIENT_TIMEOUT_MS).toBeGreaterThan(AUTH_LOGIN_TIMEOUT_MS);
  });
});

describe("loading config with an invalid AB_* port", () => {
  test("does not throw: CONFIG_ERROR names the variable and the constants are the defaults", async () => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !k.startsWith("AB_")) env[k] = v;
    }
    env.AB_BASE_PORT = "abc";
    const script =
      'const c = await import("./src/config.ts"); console.log(JSON.stringify({ e: c.CONFIG_ERROR, b: c.HEADLESS_BASE_PORT, h: c.HEADED_PORT }));';
    const proc = Bun.spawn(["bun", "-e", script], {
      cwd: `${import.meta.dir}/../..`,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, out] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({
      e: 'AB_BASE_PORT must be an integer port between 1024 and 65535 (got "abc")',
      b: 9333,
      h: 9444,
    });
  });

  test("CONFIG_ERROR is null for this test process's valid env", async () => {
    const { CONFIG_ERROR } = await import("../config");
    expect(CONFIG_ERROR).toBeNull();
  });
});
