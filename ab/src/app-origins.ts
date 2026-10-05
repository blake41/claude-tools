import { DEFAULT_AUTH_APP_BASE } from "./auth";

// Environment presets for `ab reauth`. Terra-specific: reauth mints a Clerk
// Agent Task against the development Clerk instance, so only non-production
// app hosts are valid targets (production is refused; use `ab import`).
export const REAUTH_ENV_PRESETS: Record<string, string> = {
  staging: "https://slack-feedback-staging.onrender.com",
  dev: "https://slack-feedback-development.onrender.com",
};

/**
 * Detect whether a browser URL is a Terra worktree origin (*.terra.localhost
 * or terra.localhost itself) and return the portless HTTPS base URL if so.
 * Returns undefined for non-Terra URLs.
 */
export function detectWorktreeOrigin(browserUrl: string | undefined): string | undefined {
  if (!browserUrl) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(browserUrl);
  } catch {
    return undefined;
  }
  const hostname = parsed.hostname;
  // Match terra.localhost itself or any *.terra.localhost subdomain
  if (hostname === "terra.localhost" || hostname.endsWith(".terra.localhost")) {
    // Use the browser's actual origin verbatim — portless serves standard
    // HTTPS (:443), so a bare https origin is correct and any non-standard
    // port the browser used is preserved.
    return parsed.origin;
  }
  return undefined;
}

/** App origin that `ab open` may auto-authenticate against, or undefined for any other URL. */
export function autoAuthOrigin(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const origin = parsed.origin;
  if (origin === DEFAULT_AUTH_APP_BASE) return origin;
  if (Object.values(REAUTH_ENV_PRESETS).includes(origin)) return origin;
  if (parsed.protocol === "https:") return detectWorktreeOrigin(url);
  return undefined;
}

export function resolveReauthBaseUrls(
  args: string[],
  env: { AB_APP_BASE_URL?: string },
  browserUrl?: string,
): { appBaseUrl: string | undefined; error?: string } {
  let preset: string | undefined;
  let host: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) continue;

    // --host <value> or --host=<value>
    if (arg === "--host" || arg.startsWith("--host=")) {
      let hostValue: string | undefined;
      if (arg === "--host") {
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          hostValue = next;
          i++;
        }
      } else {
        hostValue = arg.slice("--host=".length);
      }
      if (!hostValue) {
        return { appBaseUrl: undefined, error: "--host requires a hostname" };
      }
      if (host && host !== hostValue) {
        return { appBaseUrl: undefined, error: `Conflicting --host values: ${host} and ${hostValue}` };
      }
      host = hostValue;
      continue;
    }

    const name = arg.slice(2);
    if (name in REAUTH_ENV_PRESETS) {
      if (preset && preset !== name) {
        return { appBaseUrl: undefined, error: `Conflicting env flags: --${preset} and --${name}` };
      }
      preset = name;
    } else if (name === "prod" || name === "production") {
      return {
          appBaseUrl: undefined,
        error: "--prod is not supported: reauth only mints against the development Clerk instance. Production uses `ab import` (headed Google login).",
      };
    } else if (name === "local") {
      // Explicit no-op: use defaults (localhost) from auth.ts.
      preset = "local";
    }
  }
  if (host && preset && preset !== "local") {
    return {
      appBaseUrl: undefined,
      error: `Cannot combine --host with --${preset}`,
    };
  }
  // --host wins over presets. For bare hostnames, pick the right scheme:
  //   - `*.localhost` subdomains → portless serves standard HTTPS (:443);
  //     :80 only redirects, so address https directly.
  //   - bare `localhost` → plain HTTP on the default port (no portless).
  const hostUrl = host
    ? host.startsWith("http://") || host.startsWith("https://")
      ? host
      : host.endsWith(".localhost")
        ? `https://${host}`
        : `http://${host}`
    : undefined;
  const presetUrl = preset && preset !== "local" ? REAUTH_ENV_PRESETS[preset] : undefined;
  // Auto-detect from browser URL when no explicit flag/preset was given.
  // Explicit flags (--host, --staging, --dev, --local) always win over auto-detect.
  const autoDetected = (hostUrl === undefined && presetUrl === undefined)
    ? detectWorktreeOrigin(browserUrl)
    : undefined;
  const resolved = hostUrl ?? presetUrl ?? autoDetected;
  // Env vars win over flags, flags win over auto-detect, auto-detect wins over undefined (→ auth.ts localhost defaults).
  return {
    appBaseUrl: env.AB_APP_BASE_URL ?? resolved,
  };
}
