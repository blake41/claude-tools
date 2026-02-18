#!/usr/bin/env node
/**
 * log-collector.js - Background daemon that captures browser console logs
 * 
 * Connects to Chrome via CDP and writes all console output to a JSONL file.
 * Started automatically by browser-open, runs until Chrome closes.
 * 
 * Usage (usually not run directly):
 *   node log-collector.js [--port 9222] [--output /tmp/browser-logs.jsonl]
 */

const CDP = require('chrome-remote-interface');
const fs = require('fs');
const path = require('path');

// Config (pidFile set after parsing port)
const config = {
  port: parseInt(process.env.CDP_PORT) || 9222,
  host: process.env.CDP_HOST || 'localhost',
  output: process.env.BROWSER_LOG_FILE || '/tmp/browser-ctl-logs.jsonl',
  maxSize: 10 * 1024 * 1024, // 10MB max file size, then rotate
  pidFile: null, // Set after port is known
};

// Parse args
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' || args[i] === '-p') config.port = parseInt(args[++i]);
  if (args[i] === '--output' || args[i] === '-o') config.output = args[++i];
  if (args[i] === '--host') config.host = args[++i];
}

// Set PID file based on port (matches browser-open expectations)
config.pidFile = `/tmp/browser-log-collector-${config.port}.pid`;

// Write PID file
fs.writeFileSync(config.pidFile, process.pid.toString());

// Rotate log file if too large
function rotateIfNeeded() {
  try {
    const stats = fs.statSync(config.output);
    if (stats.size > config.maxSize) {
      const backup = config.output + '.old';
      if (fs.existsSync(backup)) fs.unlinkSync(backup);
      fs.renameSync(config.output, backup);
    }
  } catch (e) {
    // File doesn't exist yet, that's fine
  }
}

// Append log entry
function writeLog(entry) {
  const line = JSON.stringify(entry) + '\n';
  fs.appendFileSync(config.output, line);
}

// Map CDP log types to levels
function normalizeLevel(type) {
  const map = {
    'log': 'log', 'info': 'info', 'warning': 'warn', 'warn': 'warn',
    'error': 'error', 'debug': 'debug', 'trace': 'debug',
    'dir': 'log', 'table': 'log', 'assert': 'error', 'exception': 'error',
  };
  return map[type] || 'log';
}

// Extract message from CDP args
function extractMessage(args) {
  if (!args || args.length === 0) return '';
  
  return args.map(arg => {
    if (arg.type === 'string') return arg.value;
    if (arg.type === 'number') return String(arg.value);
    if (arg.type === 'boolean') return String(arg.value);
    if (arg.type === 'undefined') return 'undefined';
    if (arg.type === 'object') {
      if (arg.subtype === 'null') return 'null';
      if (arg.preview) {
        if (arg.preview.type === 'array') {
          const items = arg.preview.properties.map(p => p.value).join(', ');
          return `[${items}${arg.preview.overflow ? ', ...' : ''}]`;
        }
        const props = arg.preview.properties.map(p => `${p.name}: ${p.value}`).join(', ');
        return `{${props}${arg.preview.overflow ? ', ...' : ''}}`;
      }
      return arg.description || '[object]';
    }
    if (arg.type === 'function') return arg.description || '[function]';
    return arg.description || arg.value || String(arg.type);
  }).join(' ');
}

// Setup listeners for a CDP client
async function setupListeners(client, tabInfo) {
  const { Runtime, Log, Network } = client;

  await Promise.all([
    Runtime.enable(),
    Log.enable(),
    Network.enable().catch(() => {}), // Network might fail on some pages
  ]);

  // Console API calls
  Runtime.consoleAPICalled(({ type, args, stackTrace }) => {
    const location = stackTrace?.callFrames?.[0];
    writeLog({
      ts: new Date().toISOString(),
      level: normalizeLevel(type),
      message: extractMessage(args),
      url: location?.url,
      line: location?.lineNumber,
      tab: tabInfo?.title || tabInfo?.url,
    });
  });

  // Exceptions
  Runtime.exceptionThrown(({ exceptionDetails }) => {
    const { text, exception, url, lineNumber } = exceptionDetails;
    writeLog({
      ts: new Date().toISOString(),
      level: 'error',
      type: 'exception',
      message: exception?.description || exception?.value || text,
      url,
      line: lineNumber,
      tab: tabInfo?.title || tabInfo?.url,
    });
  });

  // Browser log entries
  Log.entryAdded(({ entry }) => {
    writeLog({
      ts: new Date().toISOString(),
      level: normalizeLevel(entry.level),
      message: entry.text,
      source: entry.source,
      url: entry.url,
      line: entry.lineNumber,
    });
  });

  // Network errors
  Network.loadingFailed(({ errorText, type }) => {
    if (errorText === 'net::ERR_ABORTED') return;
    writeLog({
      ts: new Date().toISOString(),
      level: 'error',
      type: 'network',
      message: `${errorText} (${type})`,
    });
  });

  // HTTP errors
  Network.responseReceived(({ response }) => {
    if (response.status >= 400) {
      writeLog({
        ts: new Date().toISOString(),
        level: 'error',
        type: 'http',
        message: `HTTP ${response.status}: ${response.url.split('?')[0]}`,
        status: response.status,
      });
    }
  });
}

// Wait for Chrome to be available (retries with backoff)
async function waitForChrome(maxAttempts = 30, initialDelay = 1000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await CDP.Version({ port: config.port, host: config.host });
      return true;
    } catch (e) {
      const delay = Math.min(initialDelay * attempt, 5000); // Cap at 5s
      console.log(`Waiting for Chrome (attempt ${attempt}/${maxAttempts})...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  return false;
}

async function main() {
  rotateIfNeeded();

  // Wait for Chrome before proceeding
  const chromeReady = await waitForChrome();
  if (!chromeReady) {
    console.error(`Chrome not available on ${config.host}:${config.port} after retries`);
    process.exit(1);
  }

  // Write startup marker
  writeLog({
    ts: new Date().toISOString(),
    level: 'info',
    type: 'collector',
    message: `Log collector started (port ${config.port})`,
  });

  const clients = [];
  let discoveryClient = null;

  async function connectToTarget(targetInfo) {
    try {
      const client = await CDP({ 
        target: targetInfo.targetId || targetInfo.id, 
        port: config.port, 
        host: config.host 
      });
      clients.push(client);
      await setupListeners(client, targetInfo);
      
      client.on('disconnect', () => {
        const idx = clients.indexOf(client);
        if (idx > -1) clients.splice(idx, 1);
      });
      
      return client;
    } catch (e) {
      // Some targets can't be connected to
      return null;
    }
  }

  try {
    // Get initial targets
    const targets = await CDP.List({ port: config.port, host: config.host });
    const pages = targets.filter(t => t.type === 'page');
    
    if (pages.length === 0) {
      console.error('No browser pages found');
      process.exit(1);
    }

    // Connect to existing pages
    for (const target of pages) {
      await connectToTarget(target);
    }

    // Listen for new pages
    discoveryClient = await CDP({ port: config.port, host: config.host });
    const { Target } = discoveryClient;
    await Target.setDiscoverTargets({ discover: true });

    Target.targetCreated(async ({ targetInfo }) => {
      if (targetInfo.type === 'page') {
        await connectToTarget(targetInfo);
        writeLog({
          ts: new Date().toISOString(),
          level: 'info',
          type: 'collector',
          message: `New tab: ${targetInfo.title || targetInfo.url}`,
        });
      }
    });

    Target.targetDestroyed(({ targetId }) => {
      writeLog({
        ts: new Date().toISOString(),
        level: 'info', 
        type: 'collector',
        message: `Tab closed: ${targetId}`,
      });
    });

    // Handle shutdown
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    
    async function shutdown() {
      writeLog({
        ts: new Date().toISOString(),
        level: 'info',
        type: 'collector', 
        message: 'Log collector stopped',
      });
      
      for (const c of clients) {
        try { await c.close(); } catch (e) {}
      }
      if (discoveryClient) {
        try { await discoveryClient.close(); } catch (e) {}
      }
      
      try { fs.unlinkSync(config.pidFile); } catch (e) {}
      process.exit(0);
    }

    // Keep alive - check if Chrome is still running
    setInterval(async () => {
      try {
        await CDP.Version({ port: config.port, host: config.host });
      } catch (e) {
        // Chrome closed
        writeLog({
          ts: new Date().toISOString(),
          level: 'info',
          type: 'collector',
          message: 'Chrome disconnected, shutting down',
        });
        try { fs.unlinkSync(config.pidFile); } catch (e) {}
        process.exit(0);
      }
    }, 5000);

  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      console.error(`Cannot connect to Chrome on ${config.host}:${config.port}`);
    } else {
      console.error('Error:', err.message);
    }
    try { fs.unlinkSync(config.pidFile); } catch (e) {}
    process.exit(1);
  }
}

main();
