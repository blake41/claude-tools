/**
 * background.js — Service Worker for Badge Updates + Cross-Profile Snapshot
 *
 * Two jobs:
 *   1. Keep the toolbar badge showing the current open tab count.
 *   2. Push a snapshot of this profile's open tabs to ~/.tab-out/snapshots/
 *      whenever tabs change, via the native messaging host. Other profiles
 *      read those snapshots when their new-tab page renders.
 *
 * Snapshot writes are debounced (1.5s) — onUpdated fires constantly during
 * navigation, but Chrome will spawn the host once per debounced call.
 *
 * Color coding gives a quick at-a-glance health signal:
 *   Green  (#3d7a4a) → 1–10 tabs  (focused, manageable)
 *   Amber  (#b8892e) → 11–20 tabs (getting busy)
 *   Red    (#b35a5a) → 21+ tabs   (time to cull!)
 */

importScripts('cross_profile.js');

// ─── Badge updater ────────────────────────────────────────────────────────────

/**
 * updateBadge()
 *
 * Counts open real-web tabs and updates the extension's toolbar badge.
 * "Real" tabs = not chrome://, not extension pages, not about:blank.
 */
async function updateBadge() {
  try {
    const tabs = await chrome.tabs.query({});

    // Only count actual web pages — skip browser internals and extension pages
    const count = tabs.filter(t => {
      const url = t.url || '';
      return (
        !url.startsWith('chrome://') &&
        !url.startsWith('chrome-extension://') &&
        !url.startsWith('about:') &&
        !url.startsWith('edge://') &&
        !url.startsWith('brave://')
      );
    }).length;

    // Don't show "0" — an empty badge is cleaner
    await chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });

    if (count === 0) return;

    // Pick badge color based on workload level
    let color;
    if (count <= 10) {
      color = '#3d7a4a'; // Green — you're in control
    } else if (count <= 20) {
      color = '#b8892e'; // Amber — things are piling up
    } else {
      color = '#b35a5a'; // Red — time to focus and close some tabs
    }

    await chrome.action.setBadgeBackgroundColor({ color });

  } catch {
    // If something goes wrong, clear the badge rather than show stale data
    chrome.action.setBadgeText({ text: '' });
  }
}

// ─── Cross-profile snapshot writer ────────────────────────────────────────────

let snapshotWriteTimer = null;

/**
 * Debounced snapshot push. Tab events fire many times during navigation
 * (especially onUpdated); we only need the last state ~1.5s after the
 * dust settles. If the native host isn't installed, sendNativeMessage
 * fails silently — that's fine, cross-profile is opt-in.
 */
function scheduleSnapshotWrite() {
  if (snapshotWriteTimer) clearTimeout(snapshotWriteTimer);
  snapshotWriteTimer = setTimeout(async () => {
    snapshotWriteTimer = null;
    try {
      const tabs = await chrome.tabs.query({});
      await writeOwnSnapshot(tabs);
    } catch {
      // Native host probably not installed yet — see native-host/install.sh.
    }
  }, 1500);
}

// ─── Event listeners ──────────────────────────────────────────────────────────

function onTabsChanged() {
  updateBadge();
  scheduleSnapshotWrite();
}

// Update badge when the extension is first installed
chrome.runtime.onInstalled.addListener(onTabsChanged);

// Update badge when Chrome starts up
chrome.runtime.onStartup.addListener(onTabsChanged);

// Update badge whenever a tab is opened
chrome.tabs.onCreated.addListener(onTabsChanged);

// Update badge whenever a tab is closed
chrome.tabs.onRemoved.addListener(onTabsChanged);

// Update badge when a tab's URL changes (e.g. navigating to/from chrome://)
chrome.tabs.onUpdated.addListener((_id, changeInfo) => {
  // Skip noisy intermediate updates (status: 'loading' fires on every nav step).
  // We care about URL/title changes — those affect the snapshot.
  if (changeInfo.url || changeInfo.title) {
    onTabsChanged();
  } else {
    updateBadge();
  }
});

// ─── Initial run ─────────────────────────────────────────────────────────────

// Run once immediately when the service worker first loads
onTabsChanged();
