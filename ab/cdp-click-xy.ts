#!/usr/bin/env bun
/**
 * cdp-click-xy — Compositor-level click at pixel coordinates via CDP Input.dispatchMouseEvent.
 *
 * Escape hatch for elements that neither `ab click @ref` nor `ab click-js <selector>` can
 * reach: cross-origin iframes, closed shadow DOM, canvas/WebGL surfaces, and elements
 * occluded by stacking contexts that confuse JS-based hit-testing. The compositor sees
 * the composited frame, so it clicks whatever is visually on top at (x, y).
 *
 * Usage:
 *   bun run cdp-click-xy.ts <port> <x> <y> [--button left|right|middle] [--clicks N]
 *
 * Workflow:
 *   ab screenshot --annotate       # pick pixel coordinates from the labeled image
 *   ab click-xy 420 180
 */

async function findPageWs(port: number): Promise<string> {
  const res = await fetch(`http://localhost:${port}/json`);
  const tabs = (await res.json()) as { type: string; webSocketDebuggerUrl: string }[];
  const pages = tabs.filter((t) => t.type === "page");
  if (pages.length === 0) throw new Error("No page tabs found");
  return pages[0].webSocketDebuggerUrl;
}

let msgId = 0;
function cdpCall(ws: WebSocket, method: string, params?: any): Promise<any> {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    const handler = (event: MessageEvent) => {
      const data = JSON.parse(event.data as string);
      if (data.id === id) {
        ws.removeEventListener("message", handler);
        if (data.error) reject(new Error(`CDP error: ${JSON.stringify(data.error)}`));
        else resolve(data.result);
      }
    };
    ws.addEventListener("message", handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

function connectCDP(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => resolve(ws));
    ws.addEventListener("error", (e) => reject(new Error(`CDP connect failed: ${e}`)));
  });
}

const argv = process.argv.slice(2);
const port = Number(argv[0]);
const x = Number(argv[1]);
const y = Number(argv[2]);

if (!port || !Number.isFinite(x) || !Number.isFinite(y)) {
  console.error("Usage: cdp-click-xy <port> <x> <y> [--button left|right|middle] [--clicks N]");
  process.exit(1);
}

let button: "left" | "right" | "middle" = "left";
let clickCount = 1;
for (let i = 3; i < argv.length; i++) {
  if (argv[i] === "--button") {
    const b = argv[++i];
    if (b !== "left" && b !== "right" && b !== "middle") {
      console.error(`Invalid --button: ${b}`);
      process.exit(1);
    }
    button = b;
  } else if (argv[i] === "--clicks") {
    clickCount = Number(argv[++i]);
    if (!Number.isInteger(clickCount) || clickCount < 1) {
      console.error(`Invalid --clicks: must be a positive integer`);
      process.exit(1);
    }
  } else {
    console.error(`Unknown arg: ${argv[i]}`);
    process.exit(1);
  }
}

try {
  const wsUrl = await findPageWs(port);
  const ws = await connectCDP(wsUrl);
  try {
    // Move first so hover/focus handlers fire before mousedown — matches real-user ordering.
    await cdpCall(ws, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x, y, button: "none", buttons: 0,
    });
    await cdpCall(ws, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x, y, button, buttons: 1, clickCount,
    });
    await cdpCall(ws, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x, y, button, buttons: 0, clickCount,
    });
    console.log(`✓ Clicked (${x}, ${y}) button=${button} clicks=${clickCount}`);
  } finally {
    ws.close();
  }
} catch (e: any) {
  console.error(`✗ ${e.message}`);
  process.exit(1);
}

export {};
