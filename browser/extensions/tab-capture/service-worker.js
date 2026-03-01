/**
 * service-worker.js - Extension background script for tab capture recording
 *
 * Handles startCapture/stopCapture messages from browser-ctl via CDP.
 * Uses chrome.tabCapture.getMediaStreamId() and delegates actual recording
 * to an offscreen document with MediaRecorder.
 */

let recording = false;
let offscreenReady = false;

// Ensure offscreen document exists
async function ensureOffscreen() {
  if (offscreenReady) return;

  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });

  if (existingContexts.length > 0) {
    offscreenReady = true;
    return;
  }

  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Tab capture recording for browser-ctl',
  });
  offscreenReady = true;
}

// Handle messages from browser-ctl (via CDP runtime.evaluate -> chrome.runtime.sendMessage)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'startCapture') {
    handleStartCapture(message).then(sendResponse).catch(err => {
      sendResponse({ ok: false, error: err.message });
    });
    return true; // async response
  }

  if (message.action === 'stopCapture') {
    handleStopCapture().then(sendResponse).catch(err => {
      sendResponse({ ok: false, error: err.message });
    });
    return true; // async response
  }

  if (message.action === 'getStatus') {
    sendResponse({ ok: true, recording });
    return false;
  }

  // Messages from offscreen document
  if (message.action === 'recordingStopped') {
    recording = false;
    return false;
  }
});

async function handleStartCapture(message) {
  if (recording) {
    return { ok: false, error: 'Already recording' };
  }

  await ensureOffscreen();

  // Get active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    return { ok: false, error: 'No active tab found' };
  }

  // Get media stream ID for the tab
  const streamId = await chrome.tabCapture.getMediaStreamId({
    targetTabId: tab.id,
  });

  // Tell offscreen document to start recording
  const response = await chrome.runtime.sendMessage({
    action: 'offscreen-startRecording',
    streamId,
    tabId: tab.id,
  });

  if (response && response.ok) {
    recording = true;
    return { ok: true, tabId: tab.id, tabUrl: tab.url, tabTitle: tab.title };
  }

  return response || { ok: false, error: 'No response from offscreen' };
}

async function handleStopCapture() {
  if (!recording) {
    return { ok: false, error: 'Not recording' };
  }

  await ensureOffscreen();

  // Tell offscreen document to stop and get data
  const response = await chrome.runtime.sendMessage({
    action: 'offscreen-stopRecording',
  });

  recording = false;
  return response || { ok: false, error: 'No response from offscreen' };
}
