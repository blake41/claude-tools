/** `ab doctor` Chrome-identity checks. Pure builders; no daemon, no lsappinfo. */
import { describe, expect, test } from "bun:test";
import { buildChromeBinaryCheck, buildLaunchServicesChecks, parseBundleId } from "../doctor";

const good = { chromeApp: "/Applications/Google Chrome Beta.app", chromeBundleId: "com.google.Chrome.beta", chromeVersion: "155.0.1.2", error: null };

describe("Chrome binary check", () => {
  test("passes for Beta and names the app and version", () => {
    const c = buildChromeBinaryCheck(good);
    expect(c).toMatchObject({ label: "Chrome binary", ok: true });
    expect(c.detail).toContain("Google Chrome Beta.app");
    expect(c.detail).toContain("155.0.1.2");
  });
  test("fails for stock Chrome with an install/AB_CHROME_APP fix", () => {
    const c = buildChromeBinaryCheck({ chromeApp: "/Applications/Google Chrome.app", chromeBundleId: "com.google.Chrome", chromeVersion: null, error: "personal Chrome" });
    expect(c.ok).toBe(false);
    expect(c.fix).toContain("AB_CHROME_APP");
  });
  test("fails against a daemon that predates the field", () => {
    expect(buildChromeBinaryCheck(undefined).ok).toBe(false);
  });
});

describe("parseBundleId", () => {
  test("extracts the id from lsappinfo output", () => {
    expect(parseBundleId('"CFBundleIdentifier"="com.google.Chrome.beta"\n')).toBe("com.google.Chrome.beta");
    expect(parseBundleId('"CFBundleIdentifier"=[ NULL ] \n')).toBeNull();
    expect(parseBundleId("")).toBeNull();
  });
});

describe("LaunchServices identity check", () => {
  test("fails when an ab pid is registered as com.google.Chrome", () => {
    const [c] = buildLaunchServicesChecks([{ pid: 99403, bundleId: "com.google.Chrome" }]);
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("99403");
  });
  test("passes when every ab pid is under .beta", () => {
    const [c] = buildLaunchServicesChecks([{ pid: 1, bundleId: "com.google.Chrome.beta" }]);
    expect(c.ok).toBe(true);
  });
  test("a pid missing from LaunchServices is a warning, not a failure", () => {
    const [c] = buildLaunchServicesChecks([{ pid: 2, bundleId: null }]);
    expect(c.ok).toBe(true);
    expect(c.detail).toContain("not registered");
  });
  test("no running Chrome: passes with nothing to check", () => {
    expect(buildLaunchServicesChecks([])[0].ok).toBe(true);
  });
});
