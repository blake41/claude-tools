import { describe, expect, test } from "bun:test";
import { STALE_DEBOUNCE_MS, isSummaryStale } from "./summary-staleness.js";

const T0 = Date.parse("2026-08-10T12:00:00.000Z");

describe("isSummaryStale", () => {
  test("never-stale when storedSummarizedCount is null (never summarized, or summarized before the column existed)", () => {
    expect(
      isSummaryStale({
        storedSummarizedCount: null,
        freshMessageCount: 10_000,
        storedSummarizedAt: new Date(T0).toISOString(),
        now: T0 + STALE_DEBOUNCE_MS * 10,
      })
    ).toBe(false);
  });

  test("never-stale when storedSummarizedAt is null (legacy row predating the column)", () => {
    expect(
      isSummaryStale({
        storedSummarizedCount: 10,
        freshMessageCount: 10_000,
        storedSummarizedAt: null,
        now: T0 + STALE_DEBOUNCE_MS * 10,
      })
    ).toBe(false);
  });

  test("not stale with no growth, even long after the debounce window", () => {
    expect(
      isSummaryStale({
        storedSummarizedCount: 100,
        freshMessageCount: 100,
        storedSummarizedAt: new Date(T0).toISOString(),
        now: T0 + STALE_DEBOUNCE_MS * 10,
      })
    ).toBe(false);
  });

  test("not stale with shrinkage (message count went down)", () => {
    expect(
      isSummaryStale({
        storedSummarizedCount: 100,
        freshMessageCount: 80,
        storedSummarizedAt: new Date(T0).toISOString(),
        now: T0 + STALE_DEBOUNCE_MS * 10,
      })
    ).toBe(false);
  });

  test("any growth is not stale before the debounce window elapses", () => {
    expect(
      isSummaryStale({
        storedSummarizedCount: 100,
        freshMessageCount: 101,
        storedSummarizedAt: new Date(T0).toISOString(),
        now: T0 + STALE_DEBOUNCE_MS - 1,
      })
    ).toBe(false);
  });

  test("boundary: exactly at the debounce window with growth is stale", () => {
    expect(
      isSummaryStale({
        storedSummarizedCount: 100,
        freshMessageCount: 101,
        storedSummarizedAt: new Date(T0).toISOString(),
        now: T0 + STALE_DEBOUNCE_MS,
      })
    ).toBe(true);
  });

  test("any growth (even +1 message) is stale once the debounce window has passed", () => {
    expect(
      isSummaryStale({
        storedSummarizedCount: 100,
        freshMessageCount: 101,
        storedSummarizedAt: new Date(T0).toISOString(),
        now: T0 + STALE_DEBOUNCE_MS + 1,
      })
    ).toBe(true);
  });

  test("large growth well past the debounce window is stale", () => {
    expect(
      isSummaryStale({
        storedSummarizedCount: 50,
        freshMessageCount: 500,
        storedSummarizedAt: new Date(T0).toISOString(),
        now: T0 + STALE_DEBOUNCE_MS * 10,
      })
    ).toBe(true);
  });

  test("exported constant matches the documented debounce window (2 minutes)", () => {
    expect(STALE_DEBOUNCE_MS).toBe(2 * 60 * 1000);
  });

  test("regression: the 3,282-legacy-sessions stampede scenario stays quiet", () => {
    // Legacy sessions summarized before these columns existed all have
    // storedSummarizedCount/storedSummarizedAt === null. Even a session
    // that grew enormously must not be marked stale purely from the NULL case.
    expect(
      isSummaryStale({
        storedSummarizedCount: null,
        freshMessageCount: 50_000,
        storedSummarizedAt: null,
        now: T0,
      })
    ).toBe(false);
  });
});
