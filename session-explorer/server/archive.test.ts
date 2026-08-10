import { describe, expect, test } from "bun:test";
import { shouldArchive } from "./archive.js";

describe("shouldArchive", () => {
  test("archives when there's no manifest entry yet (first archive for this session)", () => {
    expect(shouldArchive(null, { size: 100, mtimeMs: 1000 })).toBe(true);
    expect(shouldArchive(undefined, { size: 100, mtimeMs: 1000 })).toBe(true);
  });

  test("skips when size and mtime both match the stored manifest entry", () => {
    const stored = { size: 100, mtimeMs: 1000 };
    expect(shouldArchive(stored, { size: 100, mtimeMs: 1000 })).toBe(false);
  });

  test("re-archives when size changed but mtime happens to match", () => {
    const stored = { size: 100, mtimeMs: 1000 };
    expect(shouldArchive(stored, { size: 200, mtimeMs: 1000 })).toBe(true);
  });

  test("re-archives when mtime changed but size happens to match", () => {
    const stored = { size: 100, mtimeMs: 1000 };
    expect(shouldArchive(stored, { size: 100, mtimeMs: 2000 })).toBe(true);
  });

  test("re-archives when both size and mtime changed", () => {
    const stored = { size: 100, mtimeMs: 1000 };
    expect(shouldArchive(stored, { size: 300, mtimeMs: 3000 })).toBe(true);
  });

  test("this is the core regression case: unchanged files must not be re-archived on every 30s tick", () => {
    // Simulate 50 auto-ingest ticks against a file that never changes on
    // disk. Only the very first tick (no manifest entry) should archive.
    const stat = { size: 12_345, mtimeMs: 1_700_000_000_000 };
    let manifest: { size: number; mtimeMs: number } | null = null;
    let archiveCount = 0;

    for (let tick = 0; tick < 50; tick++) {
      if (shouldArchive(manifest, stat)) {
        archiveCount++;
        manifest = { ...stat };
      }
    }

    expect(archiveCount).toBe(1);
  });
});
