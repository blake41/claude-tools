/* ----------------------------------------------------------------
   CROSS-PROFILE SNAPSHOTS — client side

   Shared by background.js (writes its own snapshot on tab events)
   and app.js (reads other profiles' snapshots when rendering the
   new-tab page). Talks to the native messaging host installed by
   native-host/install.sh.

   Profile identity: a UUID generated on first run and stored in
   chrome.storage.local. profileLabel is a user-editable display name.
   ---------------------------------------------------------------- */

const CROSS_PROFILE_HOST = 'com.zarazhangrui.tab_out_snapshots';

async function getOrCreateProfileId() {
  const { profileId } = await chrome.storage.local.get('profileId');
  if (profileId) return profileId;
  const fresh = (self.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  await chrome.storage.local.set({ profileId: fresh });
  return fresh;
}

async function getProfileLabel() {
  const { profileLabel } = await chrome.storage.local.get('profileLabel');
  return profileLabel || '';
}

async function setProfileLabel(label) {
  const trimmed = String(label || '').trim().slice(0, 40);
  await chrome.storage.local.set({ profileLabel: trimmed });
}

function sendNative(msg) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendNativeMessage(CROSS_PROFILE_HOST, msg, response => {
        const err = chrome.runtime.lastError;
        if (err) { reject(new Error(err.message)); return; }
        resolve(response);
      });
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * writeOwnSnapshot(rawTabs)
 *
 * Persists the current profile's tab list so other profiles can read it.
 * rawTabs comes from chrome.tabs.query({}) — this function filters out
 * browser-internal pages and trims the payload before sending.
 */
async function writeOwnSnapshot(rawTabs) {
  const profileId    = await getOrCreateProfileId();
  const profileLabel = await getProfileLabel();
  const tabs = (rawTabs || [])
    .filter(t => {
      const url = t.url || '';
      return url
        && !url.startsWith('chrome://')
        && !url.startsWith('chrome-extension://')
        && !url.startsWith('about:')
        && !url.startsWith('edge://')
        && !url.startsWith('brave://');
    })
    .map(t => ({
      url:      t.url,
      title:    t.title || '',
      windowId: t.windowId,
    }));

  return sendNative({
    cmd: 'write',
    snapshot: {
      profileId,
      profileLabel,
      updatedAt: new Date().toISOString(),
      tabs,
    },
  });
}

/**
 * readOtherSnapshots()
 *
 * Returns an array of { profileId, profileLabel, updatedAt, tabs } for
 * every OTHER profile that's written a snapshot. The current profile is
 * excluded so the new-tab page doesn't double-count its own tabs.
 *
 * Returns [] on any failure (host not installed, manifest mismatch, etc.)
 * — cross-profile is additive, must not break the regular dashboard.
 */
async function readOtherSnapshots() {
  try {
    const profileId = await getOrCreateProfileId();
    const response = await sendNative({ cmd: 'read', excludeProfileId: profileId });
    if (!response || !response.ok) return [];
    return Array.isArray(response.snapshots) ? response.snapshots : [];
  } catch {
    return [];
  }
}
