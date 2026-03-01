/**
 * offscreen.js - Offscreen document for MediaRecorder-based tab capture
 *
 * Receives a stream ID from the service worker, creates a MediaRecorder,
 * accumulates WebM chunks, and returns base64-encoded data on stop.
 */

let mediaRecorder = null;
let recordedChunks = [];
let stream = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'offscreen-startRecording') {
    startRecording(message.streamId)
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.action === 'offscreen-stopRecording') {
    stopRecording()
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});

async function startRecording(streamId) {
  // Get the media stream from the stream ID
  stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
    video: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
  });

  recordedChunks = [];

  // Use VP8 for broad compatibility
  const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
    ? 'video/webm;codecs=vp9,opus'
    : 'video/webm';

  mediaRecorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: 2500000,
  });

  mediaRecorder.ondataavailable = (event) => {
    if (event.data.size > 0) {
      recordedChunks.push(event.data);
    }
  };

  mediaRecorder.onstop = () => {
    // Notify service worker that recording has stopped
    chrome.runtime.sendMessage({ action: 'recordingStopped' });
  };

  // Request data every second for incremental capture
  mediaRecorder.start(1000);
}

async function stopRecording() {
  if (!mediaRecorder || mediaRecorder.state === 'inactive') {
    return { ok: false, error: 'No active recording' };
  }

  return new Promise((resolve) => {
    mediaRecorder.onstop = async () => {
      // Combine chunks into a single blob
      const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType });
      recordedChunks = [];

      // Convert to base64
      const arrayBuffer = await blob.arrayBuffer();
      const uint8Array = new Uint8Array(arrayBuffer);
      let binary = '';
      const chunkSize = 32768;
      for (let i = 0; i < uint8Array.length; i += chunkSize) {
        const chunk = uint8Array.subarray(i, i + chunkSize);
        binary += String.fromCharCode.apply(null, chunk);
      }
      const base64 = btoa(binary);

      // Clean up stream
      if (stream) {
        stream.getTracks().forEach(track => track.stop());
        stream = null;
      }
      mediaRecorder = null;

      chrome.runtime.sendMessage({ action: 'recordingStopped' });
      resolve({ ok: true, data: base64, mimeType: blob.type, size: blob.size });
    };

    mediaRecorder.stop();
  });
}
