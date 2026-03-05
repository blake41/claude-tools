# Plan: browser-ctl persistent server mode

## Problem

Every `browser-ctl` command pays ~200-500ms to:
1. Bootstrap Node.js + require Playwright
2. `chromium.connectOverCDP()` — HTTP discovery via `/json/version`
3. Enumerate contexts and pages
4. Execute the actual command
5. `browser.close()` — tear down the connection

During a typical UI debugging session (10-20 sequential commands), this wastes 3-6 seconds on reconnection overhead alone.

The `do` compound command works around this by batching steps on one connection, but it requires the caller to know all steps upfront.

## Solution

A persistent server process that holds one warm CDP connection and exposes commands over a local Unix socket. The CLI becomes a thin client that sends a request and prints the response.

## Architecture

```
browser-ctl serve        (daemon — holds CDP connection)
    |
    |  Unix socket: /tmp/browser-ctl-server-{profile}.sock
    |
browser-ctl <command>    (thin client — sends command, prints result)
```

### Two modes of operation

1. **Server running** — CLI sends `{command, args}` over the socket, server executes using its warm connection, returns result. Sub-millisecond overhead.
2. **Server not running** — CLI falls back to current direct-connect behavior. Nothing breaks.

## Implementation

### Phase 1: Server daemon (`browser-ctl serve`)

New file: `browser-ctl-server.js` (separate process, not inside the main script)

```
Responsibilities:
- connect() once on startup, hold the browser/page handles
- Listen on Unix socket /tmp/browser-ctl-server-{profile}.sock
- Accept newline-delimited JSON requests: { command, args, tab? }
- Route to existing exec* functions (already separated from cmd* wrappers)
- Return JSON response: { ok, data, output, error }
- Health check: reconnect if CDP connection drops (page closed, Chrome restarted)
- Graceful shutdown on SIGTERM/SIGINT (close socket, close CDP)
- PID file at /tmp/browser-ctl-server-{profile}.pid for lifecycle management
```

Key detail: The exec* functions (execScreenshot, execSnapshot, execClick, etc.) already accept `(page, args)` and return `{ output, data }`. The server just needs to hold `page` and dispatch to these. No refactoring of command logic needed.

**Health/reconnect strategy:**
- Before each command execution, check `page.isClosed()`. If closed, re-run `connect()`.
- If `connect()` fails, return error to client (don't crash the server).
- Optionally: periodic heartbeat (CDP `Runtime.evaluate("1")` every 30s) to detect stale connections proactively.

**Tab handling:**
- Server tracks "active page" — defaults to first page, switches via `tab` command.
- When a tab command comes in, update the held `page` reference.
- If the active tab navigates away or closes, fall back to first available page.

### Phase 2: Client mode in browser-ctl

Modify `main()` in browser-ctl:

```
Before dispatching to cmd* functions:
1. Check if socket exists at /tmp/browser-ctl-server-{profile}.sock
2. If yes, send { command, args } over socket
3. Read response, print output (or JSON), exit with appropriate code
4. If socket doesn't exist or connection refused, fall back to current behavior
```

This is ~30 lines of code in main(). The change is:

```javascript
// In main(), before the switch statement:
const serverResult = await tryServerDispatch(command, cmdArgs);
if (serverResult !== null) {
  // Server handled it
  if (serverResult.error) {
    console.error(serverResult.error);
    process.exit(1);
  }
  console.log(serverResult.output);
  process.exit(0);
}
// else: fall through to existing switch/case (direct connect)
```

### Phase 3: Lifecycle management

```
browser-ctl serve              # Start server (foreground, for debugging)
browser-ctl serve --daemon     # Start server (background, detached)
browser-ctl serve --stop       # Stop running server
browser-ctl serve --status     # Check if server is running
```

Optionally, auto-start the server on first command if not running (like how `browser-open` auto-starts the log collector). But this adds startup latency to the first call, so maybe keep it explicit.

## Commands that need special handling

| Command | Notes |
|---------|-------|
| `logs` | Reads from log file, doesn't use CDP. Can bypass server entirely. |
| `record` | Spawns frame-collector.js subprocess. Server can manage this, but the subprocess lifecycle needs thought. Keep as direct-connect for now. |
| `test` | Long-running, manages its own connection loop. Keep as direct-connect for now. |
| `do` | Redundant if server exists. Could still work (server executes steps sequentially). |
| `tabs` / `tab` | Must update the server's active page reference. |
| `snapshot` / `snap` | Must cache refs on the server side (already in-page via `window.__browserCtlRefs`). |

Everything else (screenshot, click, type, goto, text, eval, etc.) works without modification — the exec* functions are stateless given a `page`.

## Socket protocol

Newline-delimited JSON over Unix socket. Simple, no HTTP overhead.

**Request:**
```json
{"command": "screenshot", "args": ["--full"]}
```

**Response:**
```json
{"ok": true, "output": "Screenshot saved: /tmp/browser-ctl/ss-2026-03-05-...", "data": {"path": "..."}}
```

**Error:**
```json
{"ok": false, "error": "Element not found: #missing"}
```

Binary data (screenshots saved to disk, not streamed) — no binary protocol needed.

## File changes

| File | Change |
|------|--------|
| `browser-ctl` | Add `tryServerDispatch()` (~30 lines) + call it in `main()` before switch. Add `serve` case to switch. |
| `browser-ctl-server.js` (new) | Server daemon (~150 lines). Imports exec* functions from browser-ctl or shared module. |

**Problem:** browser-ctl is a single 3,774-line script, not a module. The exec* functions aren't exported.

**Options:**
1. **Extract exec* into a shared module** — Clean but big refactor.
2. **Server imports browser-ctl as a child process** — Defeats the purpose (Node startup overhead).
3. **Server lives inside browser-ctl** — Add `serve` as another case in main(). Server holds the connection and dispatches to exec* functions directly. No module extraction needed.

**Recommendation:** Option 3. Keep everything in one file. The `serve` command starts an event loop on the Unix socket and never exits. All exec* functions are already in scope. This is the smallest change.

## Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Stale CDP connection | Health check before each dispatch + auto-reconnect |
| Server crashes | Client falls back to direct connect (zero impact) |
| Socket file left behind after crash | Client checks if PID is alive before connecting; `serve` cleans stale socket on startup |
| Multiple commands at once | Serialize on the server (queue requests). CDP isn't thread-safe anyway. |
| Tab changes not reflected | `tab` command updates server's active page ref |
| Snapshot refs stale after navigation | Refs live in `window.__browserCtlRefs` in the page — already handled by existing logic |

## Estimated scope

- Phase 1 (server): ~150 lines added to browser-ctl
- Phase 2 (client): ~30 lines added to main()
- Phase 3 (lifecycle): ~40 lines (pid file, --stop, --status, --daemon)

Total: ~220 lines. No dependencies added. No refactoring of existing commands.
