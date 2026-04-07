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
    expect(states.headless).toEqual({ phase: "idle" });
    expect(states.headed).toEqual({ phase: "idle" });
  });

  test("getAllStates returns both targets", () => {
    const states = getAllStates();
    expect("headless" in states).toBe(true);
    expect("headed" in states).toBe(true);
  });

  test("markLaunching transitions to chrome_launching", () => {
    markLaunching("headless");
    const state = getState("headless");
    expect(state.phase).toBe("chrome_launching");
    assertValidState(state);
  });

  test("markUp transitions to chrome_up with pid and port", () => {
    markUp("headless", 12345, 9333);
    const state = getState("headless");
    expect(state.phase).toBe("chrome_up");
    assertValidState(state);
    if (state.phase === "chrome_up") {
      expect(state.pid).toBe(12345);
      expect(state.port).toBe(9333);
    }
  });

  test("markCrashed transitions to chrome_crashed with exitCode and lastCrash", () => {
    markCrashed("headless", 137);
    const state = getState("headless");
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
    const returned = transitionTo("headless", next);
    expect(returned).toEqual(next);
    expect(getState("headless")).toEqual(next);
  });

  test("targets are independent — headless transition does not affect headed", () => {
    markUp("headless", 12345, 9333);
    expect(getState("headed").phase).toBe("idle");

    markCrashed("headed", 1);
    expect(getState("headless").phase).toBe("chrome_up");
  });

  test("resetAll clears both targets to idle", () => {
    markUp("headless", 12345, 9333);
    markUp("headed", 67890, 9444);

    resetAll();

    expect(getState("headless").phase).toBe("idle");
    expect(getState("headed").phase).toBe("idle");
  });

  test("every valid transition produces a valid ChromeState", () => {
    // Full lifecycle: idle → launching → up → crashed → idle
    const transitions: Array<() => void> = [
      () => markLaunching("headless"),
      () => markUp("headless", 1234, 9333),
      () => markCrashed("headless", 1),
      () => markIdle("headless"),
    ];

    for (const transition of transitions) {
      transition();
      assertValidState(getState("headless"));
    }
  });
});
