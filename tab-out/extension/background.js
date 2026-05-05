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

/**
 * Snapshot push. Originally debounced via setTimeout, but MV3 service workers
 * can be killed before a pending timer fires — so we write immediately on
 * each event instead and rate-limit with a 300ms guard. sendNativeMessage
 * spawns a fresh process per call (~10ms), so per-event writes are cheap.
 *
 * Errors are LOGGED, not swallowed — open the service worker DevTools
 * (chrome://extensions → "service worker") to see them.
 */
let lastSnapshotWriteAt = 0;

async function pushSnapshotNow() {
  const now = Date.now();
  if (now - lastSnapshotWriteAt < 300) return;  // coalesce bursts
  lastSnapshotWriteAt = now;
  try {
    const tabs = await chrome.tabs.query({});
    const result = await writeOwnSnapshot(tabs);
    console.log('[tab-out] snapshot written:', result, '(', tabs.length, 'tabs )');
  } catch (err) {
    console.error('[tab-out] snapshot write failed:', err && err.message ? err.message : err);
  }
}

// ─── Event listeners ──────────────────────────────────────────────────────────

function onTabsChanged() {
  updateBadge();
  pushSnapshotNow();
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
