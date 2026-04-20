#!/usr/bin/env bun
/**
 * cdp-click — Click a DOM element via CDP Runtime.evaluate.
 * Bypasses Input.dispatchMouseEvent coordinate issues with transformed/virtualized elements.
 *
 * Usage:
 *   bun run cdp-click.ts <port> <selector>      # Click by CSS selector
 *   bun run cdp-click.ts <port> --text <text>    # Click first button/link matching text
 *   bun run cdp-click.ts <port> --nth <n> <sel>  # Click nth match of selector
 *
 * Examples:
 *   bun run cdp-click.ts 9333 'button[data-action="dismiss"]'
 *   bun run cdp-click.ts 9333 --text "Dismiss"
 *   bun run cdp-click.ts 9444 --nth 2 'button.primary'
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

// --- Parse args ---
const argv = process.argv.slice(2);
const port = Number(argv[0]);
if (!port) {
  console.error("Usage: cdp-click <port> [--text <text>] [--nth <n>] [selector]");
  process.exit(1);
}

let selector: string | null = null;
let text: string | null = null;
let nth = 0;

for (let i = 1; i < argv.length; i++) {
  if (argv[i] === "--text") {
    text = argv[++i];
  } else if (argv[i] === "--nth") {
    nth = Number(argv[++i]) - 1; // 1-indexed to 0-indexed
  } else {
    selector = argv[i];
  }
}

if (!selector && !text) {
  console.error("Provide a selector or --text");
  process.exit(1);
}

// --- Build JS expression ---
let js: string;
if (text) {
  js = `(() => {
    const els = [...document.querySelectorAll('button, a, [role="button"]')];
    const matches = els.filter(el => el.textContent.trim() === ${JSON.stringify(text)});
    const el = matches[${nth}];
    if (!el) return { ok: false, error: 'No element with text ' + ${JSON.stringify(text)} + ' (found ' + matches.length + ' matches)' };
    el.scrollIntoView({ block: 'center' });
    el.click();
    return { ok: true, tag: el.tagName, text: el.textContent.trim().slice(0, 50) };
  })()`;
} else {
  js = `(() => {
    const els = document.querySelectorAll(${JSON.stringify(selector)});
    const el = els[${nth}];
    if (!el) return { ok: false, error: 'No element matching ' + ${JSON.stringify(selector)} + ' (found ' + els.length + ' matches)' };
    el.scrollIntoView({ block: 'center' });
    el.click();
    return { ok: true, tag: el.tagName, text: el.textContent.trim().slice(0, 50) };
  })()`;
}

// --- Execute ---
try {
  const wsUrl = await findPageWs(port);
  const ws = await connectCDP(wsUrl);
  try {
    const result = await cdpCall(ws, "Runtime.evaluate", {
      expression: js,
      returnByValue: true,
      userGesture: true,
    });

    const value = result?.result?.value;
    if (typeof value === "object" && value !== null) {
      if (value.ok) {
        console.log(`✓ Clicked <${value.tag ?? "?"}> "${value.text ?? ""}"`);
      } else {
        console.error(`✗ ${value.error ?? "Unknown error"}`);
        process.exit(1);
      }
    } else {
      console.error(`? Unexpected result: ${JSON.stringify(value)}`);
      process.exit(1);
    }
  } finally {
    ws.close();
  }
} catch (e: any) {
  console.error(`✗ ${e.message}`);
  process.exit(1);
}

export {};
