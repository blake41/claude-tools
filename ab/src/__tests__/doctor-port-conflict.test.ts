/**
 * `ab doctor` wording for Chromes the daemon may not signal: a refused port
 * occupant (lastPortConflict) and an adopted Chrome (adoptedPid). Pure
 * builders only; nothing here talks to a daemon or a CDP port.
 */
import { describe, expect, test } from "bun:test";
import { buildHeadedDoctorCheck, buildHeadlessDoctorChecks } from "../cli";
import type { ChromeState, ShardDiagnostics } from "../types";

const baseDiag: ShardDiagnostics = {
  lastHealthOkAt: null,
  heartbeatArmedSince: null,
  heartbeatMode: "off",
  lastExit: null,
  lastDetection: null,
};

const conflict = {
  port: 9333,
  pid: 4242,
  reason: "port-occupied-foreign" as const,
  detail: "command line unreadable",
  at: "2026-10-05T06:00:00.000Z",
};

const crashed: ChromeState = { phase: "chrome_crashed", exitCode: -1, lastCrash: new Date() };

describe("refused port occupant", () => {
  test("headless shard: the check names the pid and why, and does not suggest ab heal", () => {
    const [check] = buildHeadlessDoctorChecks({
      headless: crashed,
      headlessPool: [crashed],
      diagnostics: { headlessPool: [{ ...baseDiag, lastPortConflict: conflict }] },
    });
    expect(check.ok).toBe(false);
    expect(check.detail).toBe(
      "chrome_crashed — port 9333 held by PID 4242, not spawned by this daemon (command line unreadable)",
    );
    expect(check.fix).toContain("kill 4242");
    expect(check.fix).not.toContain("heal");
  });

  test("headed: same wording on the headed check", () => {
    const check = buildHeadedDoctorCheck({
      headed: crashed,
      diagnostics: { headed: { ...baseDiag, lastPortConflict: { ...conflict, port: 9444 } } },
    });
    expect(check.ok).toBe(false);
    expect(check.detail).toBe(
      "chrome_crashed — port 9444 held by PID 4242, not spawned by this daemon (command line unreadable)",
    );
    expect(check.fix).toContain("kill 4242");
  });
});

describe("adopted Chrome", () => {
  test("up and adopted: ok, and says ab heal re-adopts it instead of restarting it", () => {
    const up: ChromeState = { phase: "chrome_up", pid: 777, port: 9333 };
    const [check] = buildHeadlessDoctorChecks({
      headless: up,
      headlessPool: [up],
      diagnostics: { headlessPool: [{ ...baseDiag, adoptedPid: 777 }] },
    });
    expect(check).toMatchObject({
      label: "Chrome (headless-0, 9333)",
      ok: true,
      detail: "chrome_up (adopted PID 777, not spawned by this daemon; ab heal re-adopts it, it does not restart it)",
    });
  });

  test("a spawned Chrome keeps the bare phase", () => {
    const up: ChromeState = { phase: "chrome_up", pid: 778, port: 9333 };
    const [check] = buildHeadlessDoctorChecks({
      headless: up,
      headlessPool: [up],
      diagnostics: { headlessPool: [{ ...baseDiag, adoptedPid: null }] },
    });
    expect(check.detail).toBe("chrome_up");
  });
});
