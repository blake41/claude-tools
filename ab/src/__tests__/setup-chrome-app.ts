/**
 * Test preload: point AB_CHROME_APP at a fixture Chrome Beta bundle so
 * supervisor tests (which mock Bun.spawn) do not depend on Chrome Beta being
 * installed on the machine, and can never resolve to stock Chrome.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Per-process dir: the preload runs in every test file's process, so a shared
// path would be rewritten while another file reads it.
const app = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ab-test-chrome-")), "Google Chrome Beta.app");
const exe = "Google Chrome Beta";
fs.mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
fs.writeFileSync(
  path.join(app, "Contents", "Info.plist"),
  `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.google.Chrome.beta</string>
<key>CFBundleExecutable</key><string>${exe}</string>
<key>CFBundleShortVersionString</key><string>9999.0.0.0</string>
</dict></plist>`,
);
fs.writeFileSync(path.join(app, "Contents", "MacOS", exe), "#!/bin/sh\n", { mode: 0o755 });
process.on("exit", () => fs.rmSync(path.dirname(app), { recursive: true, force: true }));

// The version is far above any real profile's `Last Version`, so tests that use a real HOME profile
// path never trip the downgrade guard.
// Real-Chrome tests (daemon-integration) resolve the real Beta themselves.
process.env.AB_CHROME_APP = app;
