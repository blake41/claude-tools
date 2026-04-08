/**
 * Chrome instance state machine for the ab-server daemon.
 *
 * Each Chrome target (headless, headed) has independent state.
 * All transitions are logged with timestamps.
 */

import type { ChromeState, ChromeTarget } from "./types";
import { Logger } from "./logger";

const log = new Logger({ component: "chrome" });

// ---------------------------------------------------------------------------
// State store — one per Chrome target
// ---------------------------------------------------------------------------

export interface ChromeInstance {
  target: ChromeTarget;
  state: ChromeState;
}

const instances: Record<ChromeTarget, ChromeInstance> = {
  headless: { target: "headless", state: { phase: "idle" } },
  headed: { target: "headed", state: { phase: "idle" } },
};

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export function getState(target: ChromeTarget): ChromeState {
  return instances[target].state;
}

export function getAllStates(): Record<ChromeTarget, ChromeState> {
  return {
    headless: instances.headless.state,
    headed: instances.headed.state,
  };
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

/** Valid state transitions — anything not listed is a bug. */
const VALID_TRANSITIONS: Record<string, Set<string>> = {
  idle: new Set(["chrome_launching", "chrome_up"]),       // up: adoption path
  chrome_launching: new Set(["chrome_up", "chrome_crashed"]),
  chrome_up: new Set(["chrome_crashed", "idle"]),          // idle: intentional kill
  chrome_crashed: new Set(["chrome_launching", "idle"]),   // launching: restart, idle: give up
};

export function transitionTo(
  target: ChromeTarget,
  next: ChromeState,
): ChromeState {
  const prev = instances[target].state;

  // Validate transition
  const allowed = VALID_TRANSITIONS[prev.phase];
  if (!allowed?.has(next.phase)) {
    log.error(`[${target}] Invalid transition: ${prev.phase} → ${next.phase}`, {
      target,
      from: prev.phase,
      to: next.phase,
    });
  }

  instances[target].state = next;

  log.info(`[${target}] ${prev.phase} → ${next.phase}`, {
    target,
    from: prev.phase,
    to: next.phase,
    ...(next.phase === "chrome_up"
      ? { pid: next.pid, port: next.port }
      : {}),
    ...(next.phase === "chrome_crashed"
      ? { exitCode: next.exitCode, lastCrash: next.lastCrash.toISOString() }
      : {}),
  });

  return next;
}

// ---------------------------------------------------------------------------
// Convenience transition helpers
// ---------------------------------------------------------------------------

export function markLaunching(target: ChromeTarget): void {
  transitionTo(target, { phase: "chrome_launching" });
}

export function markUp(target: ChromeTarget, pid: number, port: number): void {
  transitionTo(target, { phase: "chrome_up", pid, port });
}

export function markCrashed(target: ChromeTarget, exitCode: number): void {
  transitionTo(target, {
    phase: "chrome_crashed",
    exitCode,
    lastCrash: new Date(),
  });
}

export function markIdle(target: ChromeTarget): void {
  transitionTo(target, { phase: "idle" });
}

// ---------------------------------------------------------------------------
// Reset (for tests or heal)
// ---------------------------------------------------------------------------

export function resetAll(): void {
  instances.headless.state = { phase: "idle" };
  instances.headed.state = { phase: "idle" };
  log.info("All Chrome states reset to idle");
}
