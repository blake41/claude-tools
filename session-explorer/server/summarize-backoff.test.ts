import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  BACKOFF_CAP_MINUTES,
  MAX_SUMMARY_RETRIES,
  UNSUMMARIZED_BACKOFF_SQL,
  backoffMinutes,
  isRetryEligible,
} from "./summarize-backoff.js";

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

describe("backoffMinutes", () => {
  test("doubles per retry", () => {
    expect(backoffMinutes(0)).toBe(1);
    expect(backoffMinutes(1)).toBe(2);
    expect(backoffMinutes(2)).toBe(4);
    expect(backoffMinutes(7)).toBe(128);
  });

  test("caps at 24h regardless of retry count", () => {
    expect(backoffMinutes(20)).toBe(BACKOFF_CAP_MINUTES);
  });
});

describe("isRetryEligible", () => {
  test("first attempt (no prior failure) is always eligible", () => {
    expect(isRetryEligible(0, null)).toBe(true);
  });

  test("permanently ineligible once retry count hits the max", () => {
    expect(isRetryEligible(MAX_SUMMARY_RETRIES, null)).toBe(false);
    expect(isRetryEligible(MAX_SUMMARY_RETRIES + 3, minutesAgo(10_000))).toBe(false);
  });

  test("ineligible while inside the backoff window", () => {
    // retry_count=2 -> 4 minute backoff; failed 1 minute ago -> still waiting
    expect(isRetryEligible(2, minutesAgo(1))).toBe(false);
  });

  test("eligible once the backoff window has elapsed", () => {
    // retry_count=2 -> 4 minute backoff; failed 10 minutes ago -> eligible
    expect(isRetryEligible(2, minutesAgo(10))).toBe(true);
  });

  test("this is the core regression case: a session stuck failing forever must eventually be excluded, not retried every tick", () => {
    // Before this fix, a failed parse just left summary/summary_short NULL,
    // and the "unsummarized" filter had no concept of retries — so the same
    // ~6 broken sessions were re-selected (and re-billed against Haiku) on
    // literally every 30s tick, forever.
    let retryCount = 0;
    let failedAt: string | null = null;
    let attempts = 0;

    for (let tick = 0; tick < 50 && attempts < 100; tick++) {
      if (isRetryEligible(retryCount, failedAt, new Date())) {
        attempts++;
        retryCount++;
        failedAt = new Date().toISOString(); // fails again immediately
      }
    }

    // It must NOT have been retried on every one of the 50 ticks — the
    // backoff (and eventual permanent exclusion at MAX_SUMMARY_RETRIES) has
    // to bound the number of real attempts far below the tick count.
    expect(attempts).toBeLessThanOrEqual(MAX_SUMMARY_RETRIES);
  });
});

describe("UNSUMMARIZED_BACKOFF_SQL parity with isRetryEligible", () => {
  // Exercises the *actual* SQL fragment used by index.ts's prepared
  // statements against an isolated in-memory database (never touches the
  // real app data), and checks it agrees with the pure JS predicate for the
  // same inputs.
  function makeDb(): Database {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        summary_retry_count INTEGER DEFAULT 0,
        summary_failed_at TEXT
      );
    `);
    return db;
  }

  const cases: Array<{ id: string; retryCount: number; failedAt: string | null }> = [
    { id: "fresh", retryCount: 0, failedAt: null },
    { id: "maxed-out", retryCount: MAX_SUMMARY_RETRIES, failedAt: null },
    { id: "maxed-out-old-failure", retryCount: MAX_SUMMARY_RETRIES + 2, failedAt: minutesAgo(100_000) },
    { id: "waiting", retryCount: 2, failedAt: minutesAgo(1) },
    { id: "backoff-elapsed", retryCount: 2, failedAt: minutesAgo(10) },
    { id: "high-retry-still-waiting", retryCount: 7, failedAt: minutesAgo(100) },
    { id: "high-retry-elapsed", retryCount: 7, failedAt: minutesAgo(200) },
  ];

  test("SQL fragment selects exactly the sessions the JS predicate says are eligible", () => {
    const db = makeDb();
    const insert = db.prepare(
      `INSERT INTO sessions (id, summary_retry_count, summary_failed_at) VALUES (?, ?, ?)`
    );
    for (const c of cases) {
      insert.run(c.id, c.retryCount, c.failedAt);
    }

    const rows = db
      .prepare(`SELECT id FROM sessions WHERE ${UNSUMMARIZED_BACKOFF_SQL}`)
      .all() as Array<{ id: string }>;
    const eligibleFromSql = new Set(rows.map((r) => r.id));

    for (const c of cases) {
      const expected = isRetryEligible(c.retryCount, c.failedAt);
      expect(eligibleFromSql.has(c.id)).toBe(expected);
    }

    db.close();
  });
});
