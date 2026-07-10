/**
 * State machine contract tests.
 *
 * Verifies that every transition produces a valid ChromeState,
 * and that getAllStates/resetAll behave as documented.
 */
import { test, expect, describe, beforeEach } from "bun:test";
import {
  getState,
  getAllStates,
  transitionTo,
  markLaunching,
  markUp,
  markCrashed,
  markIdle,
  resetAll,
} from "../state";
import type { ChromeState } from "../types";
import { HEADLESS_POOL_SIZE, HEADLESS_TARGETS } from "../types";

// Reset before each test to avoid cross-contamination
beforeEach(() => {
  resetAll();
});

// ---------------------------------------------------------------------------
// Phase validation helper
// ---------------------------------------------------------------------------

const VALID_PHASES = new Set(["idle", "chrome_launching", "chrome_up", "chrome_crashed"]);

function assertValidState(state: ChromeState): void {
  expect(VALID_PHASES.has(state.phase)).toBe(true);

  if (state.phase === "chrome_up") {
    expect(typeof state.pid).toBe("number");
    expect(typeof state.port).toBe("number");
    expect(state.pid).toBeGreaterThan(0);
    expect(state.port).toBeGreaterThan(0);
  }

  if (state.phase === "chrome_crashed") {
    expect(typeof state.exitCode).toBe("number");
    expect(state.lastCrash).toBeInstanceOf(Date);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("state machine contract", () => {
  test("initial state is idle for both targets", () => {
    const states = getAllStates();
    expect(states["headless-0"]).toEqual({ phase: "idle" });
    expect(states.headed).toEqual({ phase: "idle" });
  });

  test("getAllStates returns both targets", () => {
    const states = getAllStates();
    expect("headless-0" in states).toBe(true);
    expect("headed" in states).toBe(true);
  });

  test("getAllStates includes every headless pool shard (default pool size 3)", () => {
    // Default AB_HEADLESS_POOL_SIZE (unset in this test run) is 3 shards.
    expect(HEADLESS_POOL_SIZE).toBe(3);
    const states = getAllStates();
    for (const target of HEADLESS_TARGETS) {
      expect(states[target]).toEqual({ phase: "idle" });
    }
    expect(HEADLESS_TARGETS).toEqual(["headless-0", "headless-1", "headless-2"]);
  });

  test("pool shards are independent — marking shard 1 up does not affect shard 0 or shard 2", () => {
    markUp("headless-1", 55555, 9334);
    expect(getState("headless-0").phase).toBe("idle");
    expect(getState("headless-2").phase).toBe("idle");
    const state1 = getState("headless-1");
    expect(state1.phase).toBe("chrome_up");
    if (state1.phase === "chrome_up") {
      expect(state1.port).toBe(9334);
    }
  });

  test("markLaunching transitions to chrome_launching", () => {
    markLaunching("headless-0");
    const state = getState("headless-0");
    expect(state.phase).toBe("chrome_launching");
    assertValidState(state);
  });

  test("markUp transitions to chrome_up with pid and port", () => {
    markUp("headless-0", 12345, 9333);
    const state = getState("headless-0");
    expect(state.phase).toBe("chrome_up");
    assertValidState(state);
    if (state.phase === "chrome_up") {
      expect(state.pid).toBe(12345);
      expect(state.port).toBe(9333);
    }
  });

  test("markCrashed transitions to chrome_crashed with exitCode and lastCrash", () => {
    markCrashed("headless-0", 137);
    const state = getState("headless-0");
    expect(state.phase).toBe("chrome_crashed");
    assertValidState(state);
    if (state.phase === "chrome_crashed") {
      expect(state.exitCode).toBe(137);
      expect(state.lastCrash.getTime()).toBeCloseTo(Date.now(), -3); // within ~1s
    }
  });

  test("markIdle transitions to idle", () => {
    markUp("headed", 99999, 9444);
    markIdle("headed");
    const state = getState("headed");
    expect(state.phase).toBe("idle");
    assertValidState(state);
  });

  test("transitionTo returns the new state", () => {
    const next: ChromeState = { phase: "chrome_up", pid: 111, port: 9333 };
    const returned = transitionTo("headless-0", next);
    expect(returned).toEqual(next);
    expect(getState("headless-0")).toEqual(next);
  });

  test("targets are independent — headless transition does not affect headed", () => {
    markUp("headless-0", 12345, 9333);
    expect(getState("headed").phase).toBe("idle");

    markCrashed("headed", 1);
    expect(getState("headless-0").phase).toBe("chrome_up");
  });

  test("resetAll clears both targets to idle", () => {
    markUp("headless-0", 12345, 9333);
    markUp("headed", 67890, 9444);

    resetAll();

    expect(getState("headless-0").phase).toBe("idle");
    expect(getState("headed").phase).toBe("idle");
  });

  test("every valid transition produces a valid ChromeState", () => {
    // Full lifecycle: idle → launching → up → crashed → idle
    const transitions: Array<() => void> = [
      () => markLaunching("headless-0"),
      () => markUp("headless-0", 1234, 9333),
      () => markCrashed("headless-0", 1),
      () => markIdle("headless-0"),
    ];

    for (const transition of transitions) {
      transition();
      assertValidState(getState("headless-0"));
    }
  });
});
