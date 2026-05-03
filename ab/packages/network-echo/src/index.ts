// @ab/network-echo — dev-only fetch interceptor.
//
// Wraps window.fetch so each call prints a one-line summary tagged [network],
// which ab console-tail picks up for free. Intended for dev only; guard the
// import with import.meta.env.DEV or equivalent in your app.
//
//   import { install } from "@ab/network-echo";
//   if (import.meta.env.DEV) install({ urlMatch: /\/api\// });
//
// Output shape:
//   [network] POST /api/foo 200 142ms { req: {...}, res: {...} }
//   [network] GET  /api/bar 500 89ms  ERROR { req: {...}, res: {...} }

export type UrlMatcher = RegExp | ((url: string) => boolean);

export interface NetworkEchoOptions {
  /** Only echo requests whose URL matches. Default: all requests. */
  urlMatch?: UrlMatcher;
  /** Include request/response bodies. Default: true. */
  bodies?: boolean;
  /** Truncate each body to this many characters. Default: 2048. */
  bodyMaxBytes?: number;
  /** Only echo these HTTP methods (uppercase). Default: all. */
  methods?: string[];
  /** Override the console method used. Default: console.log. */
  log?: (line: string) => void;
}

interface Resolved {
  urlMatch: (url: string) => boolean;
  bodies: boolean;
  bodyMaxBytes: number;
  methods: Set<string> | null;
  log: (line: string) => void;
}

let installed = false;

export function install(opts: NetworkEchoOptions = {}): () => void {
  if (typeof window === "undefined" || typeof window.fetch !== "function") {
    return () => {};
  }
  if (installed) return () => {};
  installed = true;

  const resolved: Resolved = {
    urlMatch:
      opts.urlMatch instanceof RegExp
        ? (u: string) => (opts.urlMatch as RegExp).test(u)
        : typeof opts.urlMatch === "function"
          ? opts.urlMatch
          : () => true,
    bodies: opts.bodies ?? true,
    bodyMaxBytes: opts.bodyMaxBytes ?? 2048,
    methods: opts.methods ? new Set(opts.methods.map((m) => m.toUpperCase())) : null,
    log: opts.log ?? ((line) => console.log(line)),
  };

  const originalFetch = window.fetch.bind(window);

  const patchedFetch = async function patchedFetch(
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> {
    const start = performance.now();
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET") ?? "GET").toUpperCase();

    const shouldEcho =
      resolved.urlMatch(url) && (!resolved.methods || resolved.methods.has(method));

    if (!shouldEcho) return originalFetch(input, init);

    const reqBody = resolved.bodies ? readRequestBody(init) : undefined;

    let res: Response;
    try {
      res = await originalFetch(input, init);
    } catch (err) {
      const ms = Math.round(performance.now() - start);
      resolved.log(
        `[network] ${method} ${shortUrl(url)} NETWORK_ERROR ${ms}ms ` +
          stringify({ req: reqBody, err: String(err) }, resolved.bodyMaxBytes)
      );
      throw err;
    }

    const ms = Math.round(performance.now() - start);
    const clone = res.clone();
    let resBody: unknown = undefined;
    if (resolved.bodies) {
      try {
        const text = await clone.text();
        resBody = parseMaybeJson(text);
      } catch {
        resBody = "[unreadable body]";
      }
    }
    const errTag = res.ok ? "" : " ERROR";
    resolved.log(
      `[network] ${method} ${shortUrl(url)} ${res.status}${errTag} ${ms}ms ` +
        stringify({ req: reqBody, res: resBody }, resolved.bodyMaxBytes)
    );
    return res;
  };

  // Preserve static properties like fetch.preconnect by copying them across.
  window.fetch = Object.assign(patchedFetch, window.fetch);

  return function uninstall() {
    window.fetch = originalFetch as typeof window.fetch;
    installed = false;
  };
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url, typeof window !== "undefined" ? window.location.href : "http://localhost");
    return u.pathname + (u.search || "");
  } catch {
    return url;
  }
}

function readRequestBody(init: RequestInit | undefined): unknown {
  if (!init || init.body == null) return undefined;
  const b = init.body;
  if (typeof b === "string") return parseMaybeJson(b);
  if (b instanceof URLSearchParams) return Object.fromEntries(b.entries());
  if (b instanceof FormData) {
    const out: Record<string, unknown> = {};
    b.forEach((v, k) => {
      out[k] = v instanceof File ? `[File ${v.name} ${v.size}b]` : v;
    });
    return out;
  }
  if (b instanceof Blob) return `[Blob ${b.size}b]`;
  if (b instanceof ArrayBuffer) return `[ArrayBuffer ${b.byteLength}b]`;
  return "[unreadable body]";
}

function parseMaybeJson(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {}
  }
  return text;
}

function stringify(obj: unknown, maxBytes: number): string {
  let s: string;
  try {
    s = JSON.stringify(obj);
  } catch {
    s = "[unserializable]";
  }
  if (s.length > maxBytes) s = s.slice(0, maxBytes) + "…";
  return s;
}
