import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { reapSessionFiles } from "../session-gc";

const pid = `reap-test-${process.pid}`;
const marker = `/tmp/.ab-session-${pid}`;
const wrapper = `/tmp/ab-${pid}`;
let configDir: string;

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-reap-"));
  fs.writeFileSync(marker, pid);
  fs.writeFileSync(wrapper, "#!/bin/sh");
  fs.writeFileSync(path.join(configDir, `ab-${pid}.config`), "{}");
});

afterEach(() => {
  for (const p of [marker, wrapper]) fs.rmSync(p, { force: true });
  fs.rmSync(configDir, { recursive: true, force: true });
});

test("removes marker, wrapper and the ab-<pid>.config sidecar", () => {
  reapSessionFiles(pid, { configDir });
  expect(fs.existsSync(marker)).toBe(false);
  expect(fs.existsSync(wrapper)).toBe(false);
  expect(fs.existsSync(path.join(configDir, `ab-${pid}.config`))).toBe(false);
});

test("keepWrapper preserves the wrapper but still removes marker and config", () => {
  reapSessionFiles(pid, { configDir, keepWrapper: true });
  expect(fs.existsSync(wrapper)).toBe(true);
  expect(fs.existsSync(marker)).toBe(false);
  expect(fs.existsSync(path.join(configDir, `ab-${pid}.config`))).toBe(false);
});

test("tolerates already-missing files", () => {
  reapSessionFiles(pid, { configDir });
  expect(() => reapSessionFiles(pid, { configDir })).not.toThrow();
});
