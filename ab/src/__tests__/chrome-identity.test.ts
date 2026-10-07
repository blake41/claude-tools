/**
 * chrome-identity: the guard that keeps ab off personal (stock) Google Chrome.
 * Fixture .app trees only; nothing here needs Chrome Beta installed.
 */
import { test, expect, describe, afterAll } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  readBundleInfo,
  checkChromeApp,
  profileIsNewerThan,
  compareVersions,
} from "../chrome-identity";
import { FORBIDDEN_BUNDLE_ID } from "../config";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ab-identity-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

/** Build a minimal .app tree with a real XML Info.plist and an executable file. */
function makeApp(name: string, bundleId: string, exe: string, version = "155.0.1.2", withExe = true): string {
  const app = path.join(root, `${name}.app`);
  fs.mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
  fs.writeFileSync(
    path.join(app, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${bundleId}</string>
<key>CFBundleExecutable</key><string>${exe}</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
</dict></plist>`,
  );
  if (withExe) fs.writeFileSync(path.join(app, "Contents", "MacOS", exe), "#!/bin/sh\n", { mode: 0o755 });
  return app;
}

describe("readBundleInfo", () => {
  test("reads bundle id, executable path (from the plist) and version", () => {
    const app = makeApp("beta", "com.google.Chrome.beta", "Google Chrome Beta", "156.0.7000.1");
    expect(readBundleInfo(app)).toEqual({
      bundleId: "com.google.Chrome.beta",
      bin: path.join(app, "Contents", "MacOS", "Google Chrome Beta"),
      version: "156.0.7000.1",
    });
  });

  test("returns null when the bundle does not exist", () => {
    expect(readBundleInfo(path.join(root, "nope.app"))).toBeNull();
  });
});

describe("checkChromeApp", () => {
  test("rejects the stable bundle id", () => {
    const app = makeApp("stable", FORBIDDEN_BUNDLE_ID, "Google Chrome");
    expect(checkChromeApp(app)).toEqual({ ok: false, reason: "personal-bundle", appPath: app });
  });

  test("accepts the beta bundle id and returns the identity", () => {
    const app = makeApp("beta2", "com.google.Chrome.beta", "Google Chrome Beta");
    const res = checkChromeApp(app);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.identity.bundleId).toBe("com.google.Chrome.beta");
      expect(res.identity.appPath).toBe(app);
      expect(res.identity.version).toBe("155.0.1.2");
    }
  });

  test("rejects a missing bundle", () => {
    const app = path.join(root, "missing.app");
    expect(checkChromeApp(app)).toEqual({ ok: false, reason: "missing", appPath: app });
  });

  test("rejects a bundle whose executable is gone", () => {
    const app = makeApp("noexe", "com.google.Chrome.beta", "Google Chrome Beta", "155.0.1.2", false);
    expect(checkChromeApp(app)).toEqual({ ok: false, reason: "missing", appPath: app });
  });
});

describe("compareVersions", () => {
  test("compares dotted integers numerically, not lexically", () => {
    expect(compareVersions("154.0.8037.98", "154.0.8037.98")).toBe(0);
    expect(compareVersions("155.0.1.0", "154.9.9.9")).toBeGreaterThan(0);
    expect(compareVersions("154.0.8037.98", "154.0.8037.100")).toBeLessThan(0);
    expect(compareVersions("154", "154.0.0.1")).toBeLessThan(0);
  });
});

describe("profileIsNewerThan", () => {
  const profileWith = (lastVersion: string | null): string => {
    const dir = fs.mkdtempSync(path.join(root, "prof-"));
    if (lastVersion !== null) fs.writeFileSync(path.join(dir, "Last Version"), lastVersion);
    return dir;
  };

  test("true when the profile was last opened by a newer Chrome (downgrade)", () => {
    expect(profileIsNewerThan(profileWith("154.0.8037.98"), "153.0.1.1")).toBe(true);
  });
  test("false for the same or an older profile version", () => {
    expect(profileIsNewerThan(profileWith("154.0.8037.98"), "154.0.8037.98")).toBe(false);
    expect(profileIsNewerThan(profileWith("153.0.1.1"), "154.0.8037.98")).toBe(false);
  });
  test("false when there is no Last Version file (fresh profile) or it is unparsable", () => {
    expect(profileIsNewerThan(profileWith(null), "154.0.0.0")).toBe(false);
    expect(profileIsNewerThan(profileWith("garbage"), "154.0.0.0")).toBe(false);
    expect(profileIsNewerThan(path.join(root, "no-such-dir"), "154.0.0.0")).toBe(false);
  });
  test("tolerates a trailing newline", () => {
    expect(profileIsNewerThan(profileWith("160.0.1.1\n"), "154.0.0.0")).toBe(true);
  });
});
