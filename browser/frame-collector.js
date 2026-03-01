#!/usr/bin/env node
/**
 * frame-collector.js - Background daemon for CDP screencast frame capture
 *
 * Connects to Chrome via chrome-remote-interface, starts a Page.startScreencast
 * session, and writes numbered JPEG frames to a temp directory. Updates a state
 * file with the current frame count so browser-ctl can report progress.
 *
 * Usage (spawned by browser-ctl record start):
 *   node frame-collector.js --port 9222 --fps 2 --quality 80 \
 *     --frames-dir /tmp/browser-ctl/frames-xxx --state-file /tmp/browser-ctl-recording-default.json
 */

const CDP = require('chrome-remote-interface');
const fs = require('fs');
const path = require('path');

// Config
const config = {
  port: 9222,
  host: 'localhost',
  fps: 2,
  quality: 80,
  framesDir: null,
  stateFile: null,
  maxDuration: 10 * 60 * 1000, // 10 minutes
};

// Parse args
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case '--port': config.port = parseInt(args[++i]); break;
    case '--host': config.host = args[++i]; break;
    case '--fps': config.fps = parseInt(args[++i]); break;
    case '--quality': config.quality = parseInt(args[++i]); break;
    case '--frames-dir': config.framesDir = args[++i]; break;
    case '--state-file': config.stateFile = args[++i]; break;
    case '--max-duration': config.maxDuration = parseInt(args[++i]) * 1000; break;
  }
}

if (!config.framesDir || !config.stateFile) {
  console.error('Required: --frames-dir and --state-file');
  process.exit(1);
}

// Ensure frames directory exists
if (!fs.existsSync(config.framesDir)) {
  fs.mkdirSync(config.framesDir, { recursive: true });
}

let frameCount = 0;
let client = null;
let stopping = false;

function updateState(updates) {
  try {
    let state = {};
    if (fs.existsSync(config.stateFile)) {
      state = JSON.parse(fs.readFileSync(config.stateFile, 'utf8'));
    }
    Object.assign(state, updates);
    fs.writeFileSync(config.stateFile, JSON.stringify(state, null, 2));
  } catch (e) {
    // State file may have been cleared by cancel
  }
}

async function shutdown(reason) {
  if (stopping) return;
  stopping = true;

  try {
    if (client) {
      const { Page } = client;
      await Page.stopScreencast().catch(() => {});
      await client.close().catch(() => {});
    }
  } catch (e) {
    // Best effort cleanup
  }

  updateState({ stoppedAt: new Date().toISOString(), stopReason: reason, frameCount });
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('sigterm'));
process.on('SIGINT', () => shutdown('sigint'));

async function main() {
  try {
    // Connect to Chrome
    const targets = await CDP.List({ port: config.port, host: config.host });
    const pageTarget = targets.find(t => t.type === 'page');
    if (!pageTarget) {
      console.error('No page target found');
      process.exit(1);
    }

    client = await CDP({
      target: pageTarget.id,
      port: config.port,
      host: config.host,
    });

    const { Page } = client;
    await Page.enable();

    // Handle screencast frames
    Page.screencastFrame(async ({ data, metadata, sessionId }) => {
      if (stopping) return;

      // Acknowledge the frame immediately so Chrome keeps sending
      try {
        await Page.screencastFrameAck({ sessionId });
      } catch (e) {
        // Session may have ended
      }

      // Write frame as JPEG
      const frameNum = String(frameCount).padStart(6, '0');
      const framePath = path.join(config.framesDir, `frame-${frameNum}.jpg`);
      try {
        fs.writeFileSync(framePath, Buffer.from(data, 'base64'));
        frameCount++;
        updateState({ frameCount });
      } catch (e) {
        // Frames dir may have been deleted by cancel
        if (!stopping) {
          await shutdown('write-error');
        }
      }
    });

    // Start screencast
    await Page.startScreencast({
      format: 'jpeg',
      quality: config.quality,
      maxWidth: 1280,
      maxHeight: 800,
      everyNthFrame: Math.max(1, Math.round(60 / config.fps)),
    });

    updateState({ pid: process.pid, frameCount: 0, collectorStarted: new Date().toISOString() });

    // Auto-stop after max duration
    setTimeout(() => {
      shutdown('max-duration');
    }, config.maxDuration);

    // Periodic health check - if Chrome disconnects, stop
    const healthCheck = setInterval(async () => {
      try {
        await CDP.Version({ port: config.port, host: config.host });
      } catch (e) {
        clearInterval(healthCheck);
        await shutdown('chrome-disconnected');
      }
    }, 5000);

    // Handle client disconnect
    client.on('disconnect', () => {
      if (!stopping) {
        shutdown('client-disconnected');
      }
    });

  } catch (err) {
    console.error('Frame collector error:', err.message);
    updateState({ error: err.message });
    process.exit(1);
  }
}

main();
