import { watch } from 'fs';
import { readFileSync, existsSync } from 'fs';
import { resolve, join } from 'path';
import { parseBreadboard } from './parser.ts';
import { computeLayout } from './layout.ts';
import type { LayoutResult } from './types.ts';

const filePath = resolve(process.argv[2] ?? '');
if (!filePath || !existsSync(filePath)) {
  console.error(`Usage: bun server.ts <breadboard.md>`);
  process.exit(1);
}

const PORT = 5555;
const WEB_DIST = join(import.meta.dir, 'web', 'dist');

// Kill any stale process on our port
try {
  const result = Bun.spawnSync(['lsof', '-ti', `:${PORT}`]);
  const pids = result.stdout.toString().trim();
  if (pids) {
    for (const pid of pids.split('\n')) {
      if (pid && pid !== String(process.pid)) {
        process.kill(Number(pid), 9);
        console.log(`Killed stale process ${pid} on port ${PORT}`);
      }
    }
    // Brief pause to let the port release
    Bun.sleepSync(200);
  }
} catch {
  // Ignore — no stale process
}

function loadAndLayout(): LayoutResult {
  const markdown = readFileSync(filePath, 'utf-8');
  const breadboard = parseBreadboard(markdown);
  console.log(
    `Parsed: ${breadboard.nodes.length} nodes, ${breadboard.wires.length} wires`
  );
  return computeLayout(breadboard);
}

let currentLayout = loadAndLayout();

const clients = new Set<any>();

const server = Bun.serve({
  port: PORT,
  fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket upgrade
    if (url.pathname === '/ws') {
      if (server.upgrade(req)) return;
      return new Response('WebSocket upgrade failed', { status: 500 });
    }

    // Serve static files from web/dist
    let path = url.pathname === '/' ? '/index.html' : url.pathname;
    const filePath = join(WEB_DIST, path);

    if (existsSync(filePath)) {
      return new Response(Bun.file(filePath));
    }

    return new Response('Not found', { status: 404 });
  },
  websocket: {
    open(ws) {
      clients.add(ws);
      ws.send(JSON.stringify(currentLayout));
    },
    close(ws) {
      clients.delete(ws);
    },
    message() {
      // No client-to-server messages expected
    },
  },
});

console.log(`beam server running at http://localhost:${PORT}`);
console.log(`Watching: ${filePath}`);

// Watch file for changes
watch(filePath, (eventType) => {
  if (eventType === 'change') {
    console.log('File changed, re-parsing...');
    try {
      currentLayout = loadAndLayout();
      const json = JSON.stringify(currentLayout);
      for (const ws of clients) {
        ws.send(json);
      }
    } catch (err) {
      console.error('Parse error:', err);
    }
  }
});
