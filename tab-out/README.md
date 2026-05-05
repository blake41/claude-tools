# Tab Out (customised)

A Chrome extension that turns the new-tab page into a tab dashboard, with two
local additions on top of [zarazhangrui/tab-out](https://github.com/zarazhangrui/tab-out):

1. **Group-by mode toggle** — Window / Window → Host / Host. Default is Window.
2. **Cross-profile snapshots** — see (read-only) the tabs open in your other
   Chrome profiles, via a tiny native messaging host that reads/writes JSON
   files in `~/.tab-out/snapshots/`.

## Install

```bash
cd /Users/blake/Documents/Development/tools/tab-out
./install.sh
```

The script walks you through:

1. Copying the extension folder path to your clipboard.
2. Opening `chrome://extensions` so you can **Load unpacked** and paste the path.
3. Pasting back the extension ID from the Tab Out tile (32 chars, `a-p`).
4. Installing the native messaging host manifest.

After it finishes, reload Tab Out and open a new tab.

### Multi-profile setup

The cross-profile feature only does anything if Tab Out is loaded in more than
one profile. Per profile:

1. Switch to that Chrome profile.
2. `chrome://extensions` → Developer mode → Load unpacked → point to
   `tools/tab-out/extension/`.
3. Reload Tab Out.

The extension ID is derived from the folder path, so all profiles end up with
the same ID — one native host manifest covers them all. You only need to run
`./install.sh` once per machine.

## What's in here

```
tab-out/
├── install.sh                  # Top-level interactive installer
├── extension/                  # The Chrome extension itself
│   ├── manifest.json
│   ├── background.js           # Service worker — badge + snapshot writer
│   ├── cross_profile.js        # Snapshot client (shared by background + app)
│   ├── app.js                  # Dashboard logic
│   ├── index.html
│   ├── style.css
│   └── icons/
└── native-host/
    ├── snapshots-host.py       # Native messaging host (~80 LOC, Python stdlib)
    └── install.sh              # Copies host to ~/.tab-out/bin/ + installs manifest
```

After install, runtime state lives outside the repo:

```
~/.tab-out/
├── bin/snapshots-host.py       # Where Chrome actually executes from
└── snapshots/                  # One <profileId>.json per profile
```

The host script is **deployed out of `~/.tab-out/bin/`** rather than run in
place from the repo because macOS TCC blocks Chrome from spawning scripts
under `~/Documents/` without explicit user consent — and there's no API for
an extension to prompt for it. Living under `~/.tab-out/` sidesteps it.

## Group-by modes

Toggle is in the section header next to "Open tabs":

| Mode | What you see |
|---|---|
| **Window** (default) | One card per Chrome window, titled `Window 1`, `Window 2`… The window the new-tab page lives in is tagged `current`. |
| **Window → Host** | Same window cards, with sub-sections per hostname inside each. Hosts sorted by tab count. |
| **Host** | Original Tab Out behaviour — one card per domain, with the special "Homepages" group and `config.local.js` custom-group rules. |

The choice persists in `chrome.storage.local` under `groupMode`.

## Cross-profile architecture

Why a native messaging host: Chrome extensions are sandboxed per profile.
There is no extension API to read tabs in another profile. The only way out
is a small native binary that the extension talks to via stdin/stdout. The
host can write to a directory both profiles can read.

```
┌─────────────────┐                  ┌─────────────────┐
│ Profile: Work   │                  │ Profile: Personal│
│ Tab Out (svc-w) │                  │ Tab Out (svc-w) │
└────────┬────────┘                  └────────┬────────┘
         │ chrome.runtime.sendNativeMessage   │
         ▼                                    ▼
   ┌─────────────────────────────────────────────┐
   │ snapshots-host.py (one process per request) │
   │                                             │
   │   write → ~/.tab-out/snapshots/<uuid>.json  │
   │   read  → returns all snapshots             │
   └─────────────────────────────────────────────┘
```

### Why one-shot, not a long-lived port

Manifest V3 service workers can be killed at any time. A long-lived native
messaging port (`chrome.runtime.connectNative`) living in `background.js`
needs reconnect logic, dropped-message handling, and dies when the worker
sleeps. One-shot `sendNativeMessage` calls survive worker restarts because
each call spawns a fresh process and exits in milliseconds. Snapshots on
disk also survive Chrome restarts.

### Write path (background.js)

Tab Out's service worker subscribes to `chrome.tabs.onCreated/onRemoved/
onUpdated` and `chrome.windows.onCreated/onRemoved`. A debounced (1.5s)
write fires after the dust settles, sending a snapshot like:

```json
{
  "profileId": "5a2b3c…",
  "profileLabel": "Work",
  "updatedAt": "2026-05-05T15:30:00.000Z",
  "tabs": [
    { "url": "...", "title": "...", "windowId": 12 }
  ]
}
```

Browser-internal pages (`chrome://`, `chrome-extension://`, `about:`) are
filtered before sending.

### Read path (app.js)

The new-tab page calls `readOtherSnapshots()` on every render. The host
returns every snapshot file in `~/.tab-out/snapshots/` whose `profileId`
isn't ours. Each becomes a card showing tab count, host count, "X minutes
ago" since last write, and up to 8 tab rows. Clicking a tab opens the URL
in *this* profile (Chrome can't focus tabs across profiles).

### Profile labels

Each profile auto-generates a UUID on first run (stored in
`chrome.storage.local`). Click the dashed underline next to "this profile:"
in the cross-profile section header to give it a human name (Enter or
click-away saves; the next snapshot push includes the new label).

### Native host protocol

Native messaging uses a 4-byte little-endian length prefix + UTF-8 JSON,
both directions. The host accepts:

```jsonc
// Request
{ "cmd": "write", "snapshot": { "profileId": "...", ... } }
// Response
{ "ok": true }
```

```jsonc
// Request
{ "cmd": "read", "excludeProfileId": "..." }
// Response
{ "ok": true, "snapshots": [ { "profileId": "...", ... }, ... ] }
```

Path traversal is blocked: `profileId` is sanitised to `[A-Za-z0-9_-]{1,64}`
before becoming a filename.

## Debugging

```bash
# See your snapshots
ls -la ~/.tab-out/snapshots/
cat ~/.tab-out/snapshots/<uuid>.json | jq .

# Re-run native host install if you reloaded the extension and got a new ID
./native-host/install.sh <new-id>

# Watch tab events live
# In Chrome: chrome://extensions → Tab Out → "service worker (inspect)"
# Look for snapshot-write logs in the Console tab.

# If cross-profile section never appears
# - Check at least 2 profiles have Tab Out loaded
# - Check ~/.tab-out/snapshots/ has more than one .json
# - Check ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/
#   contains com.zarazhangrui.tab_out_snapshots.json with your extension ID
# - Open the service worker console (chrome://extensions → "service worker"
#   under Tab Out) and look for [tab-out] log lines. "Native host has exited"
#   means TCC is blocking the host script — re-run native-host/install.sh,
#   which deploys to ~/.tab-out/bin/ (outside ~/Documents/).
```

## Source provenance

Upstream: https://github.com/zarazhangrui/tab-out (Zara Zhang, MIT-licensed —
see `LICENSE`). The Window-grouping toggle and the cross-profile native-host
plumbing are local additions and not yet upstreamed.
