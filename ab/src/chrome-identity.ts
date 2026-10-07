/**
 * Which Chrome binary ab may spawn. ab must never run the bundle that holds
 * personal Chrome's LaunchServices identity (com.google.Chrome): two instances
 * under one bundle ID make macOS route Dock clicks, links and PWA launches to
 * the wrong one. There is deliberately no env override for that rule.
 *
 * Pure and synchronous (plutil + fs only) so it unit-tests against fixture
 * .app trees. Must not import ./chrome-supervisor.
 */

import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { CHROME_APP, FORBIDDEN_BUNDLE_ID } from "./config";

export interface BundleInfo {
  bundleId: string;
  /** Absolute path of the executable named by CFBundleExecutable. */
  bin: string;
  version: string;
}

export interface ChromeIdentity extends BundleInfo {
  appPath: string;
}

export type ChromeAppCheck =
  | { ok: true; identity: ChromeIdentity }
  | { ok: false; reason: "missing" | "personal-bundle"; appPath: string };

function xmlPlistValue(xml: string, key: string): string | null {
  const m = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(xml);
  return m ? m[1].trim() || null : null;
}

function plutilValue(infoPlist: string, key: string): string | null {
  const res = spawnSync("plutil", ["-extract", key, "raw", "-o", "-", infoPlist], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (res.status !== 0) return null;
  return res.stdout.trim() || null;
}

/**
 * Read one string key. Chrome ships an XML plist, parsed in-process (no
 * subprocess, so supervisor tests that stub Bun.spawnSync cannot break it);
 * a binary plist falls back to `plutil -extract`.
 */
function plistValue(infoPlist: string, key: string): string | null {
  let raw: Buffer;
  try {
    raw = fs.readFileSync(infoPlist);
  } catch {
    return null;
  }
  if (raw.subarray(0, 5).toString("latin1") === "<?xml") return xmlPlistValue(raw.toString("utf8"), key);
  return plutilValue(infoPlist, key);
}

/** Read identity keys from `<appPath>/Contents/Info.plist`; null if the bundle is absent or unreadable. */
export function readBundleInfo(appPath: string): BundleInfo | null {
  const infoPlist = path.join(appPath, "Contents", "Info.plist");
  if (!fs.existsSync(infoPlist)) return null;
  const bundleId = plistValue(infoPlist, "CFBundleIdentifier");
  const exe = plistValue(infoPlist, "CFBundleExecutable");
  const version = plistValue(infoPlist, "CFBundleShortVersionString");
  if (!bundleId || !exe || !version) return null;
  return { bundleId, bin: path.join(appPath, "Contents", "MacOS", exe), version };
}

/** ok when the bundle exists, its executable exists, and its bundle id is not personal Chrome's. */
export function checkChromeApp(appPath: string = CHROME_APP): ChromeAppCheck {
  const info = readBundleInfo(appPath);
  if (!info || !fs.existsSync(info.bin)) return { ok: false, reason: "missing", appPath };
  if (info.bundleId === FORBIDDEN_BUNDLE_ID) return { ok: false, reason: "personal-bundle", appPath };
  return { ok: true, identity: { ...info, appPath } };
}

function parseVersion(v: string): number[] | null {
  const parts = v.trim().split(".");
  if (parts.length === 0 || parts.some((p) => !/^\d+$/.test(p))) return null;
  return parts.map(Number);
}

/** Compare dotted integer versions. Missing trailing parts count as lower ("154" < "154.0.0.1"). */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a) ?? [];
  const pb = parseVersion(b) ?? [];
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x !== y) return x - y;
  }
  return 0;
}

/**
 * True when `<profileDir>/Last Version` is newer than `version`: Chrome does not
 * support opening a profile with an older build, so ab refuses the downgrade.
 * A missing or unparsable file means "not newer" (fresh profile).
 */
export function profileIsNewerThan(profileDir: string, version: string): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(profileDir, "Last Version"), "utf8");
  } catch {
    return false;
  }
  if (parseVersion(raw) === null || parseVersion(version) === null) return false;
  return compareVersions(raw, version) > 0;
}
