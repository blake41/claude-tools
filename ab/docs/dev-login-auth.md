# Dev-Login Auth Flow

How `ab` authenticates browser sessions in dev and staging environments — no Google OAuth, no cookie stealing.

## How It Works

```
Agent calls: ab reauth
    │
    ▼
ab-server daemon
    │
    ├─ POST /auth/dev-login { email: "blake.johnson@clay.com" }
    │   → Terra backend mints a Clerk sign-in token (5 min TTL)
    │   → Returns { token: "sts_xxx...", exchangeUrl: "/dev-login?ticket=sts_xxx" }
    │
    ├─ Navigate headless Chrome to /dev-login?ticket=sts_xxx
    │   → React component calls signIn.create({ strategy: 'ticket', ticket })
    │   → Clerk exchanges ticket for a real __session cookie
    │   → Browser redirects to /
    │
    ├─ Poll URL until redirect completes (up to 15s)
    │
    └─ Done. Browser has a real Clerk session.
        All subsequent pages are authenticated.
```

The resulting session is identical to logging in via Google OAuth — same cookies, same JWT, same everything. Every downstream system (RequireAuth, getToken, useAuth) works without changes.

## When Auth Happens

- **First `ab open`** for a session — the CLI checks if the browser is already on an authenticated page. If not, it triggers `reauth` automatically.
- **`ab reauth`** — explicit re-authentication. Use when a session expires or you switch users.
- **Chrome restart** — the daemon invalidates auth state when Chrome crashes and restarts. The next command triggers fresh auth.

## Configuration

| Env Var | Default | Purpose |
|---------|---------|---------|
| `AB_AUTH_EMAIL` | `blake.johnson@clay.com` | Email for dev-login. Must have a Clerk account. |
| `AB_SLACK_USER_ID` | `U08M03CDY73` | Alternative: Slack user ID instead of email. |
| `AB_API_BASE_URL` | `http://localhost:8000` | Where to POST /auth/dev-login. |
| `AB_APP_BASE_URL` | `http://localhost:5173` | Where to navigate the ticket exchange URL. |

For staging, set both to `https://slack-feedback-staging.onrender.com`:

```bash
AB_API_BASE_URL=https://slack-feedback-staging.onrender.com \
AB_APP_BASE_URL=https://slack-feedback-staging.onrender.com \
ab reauth
```

## Prerequisites

1. **The user must have logged in via Google OAuth at least once** — Clerk needs an account to mint tokens against. If you get "No Clerk account for X", log in manually once, then dev-login works forever after.

2. **The dev-login endpoint must exist** — `POST /auth/dev-login` is mounted in `src/app/routes.ts` on non-production environments only. It does not exist on production.

3. **The DevLogin page must exist** — `/dev-login` is a React route in `web/app-home/src/AppRouter.tsx` that exchanges the ticket for a session.

## Local Dev vs Staging

| | Local Dev | Staging |
|---|---|---|
| API URL | `http://localhost:8000` | `https://slack-feedback-staging.onrender.com` |
| App URL | `http://localhost:5173` | `https://slack-feedback-staging.onrender.com` |
| Dev server required | Yes (`pm2 restart slack-dev`) | No (always running on Render) |
| Clerk instance | Dev (Clerk Dashboard → Development) | Staging (same Clerk instance as dev) |

## What Replaced What

The old `ab` used **cookie stealing** — grabbing 6,698 cookies from your personal Chrome via CDP, filtering to 158 terra-relevant ones, replicating Clerk JWTs across domains, and injecting them into headless Chrome. This was:

- Fragile (broke when personal Chrome wasn't running or cookies expired)
- Slow (CDP WebSocket operations, polling every 5 minutes)
- Complex (232 lines of cookie management code)

Dev-login replaces all of that with a single HTTP POST + page navigation. The Clerk session is real (not copied cookies), so there are no expiry or domain replication issues.

## Troubleshooting

**"No Clerk account for X"**
The user has never logged in via Google OAuth in this environment. Open `http://localhost:5173` in a regular browser, log in via Google once, then retry.

**"Dev server unreachable"**
The local dev server isn't running. `pm2 restart slack-dev` and retry.

**"Auth exchange timed out"**
The DevLogin React component didn't redirect within 15s. Common causes:
- Vite cache is stale — `pm2 restart slack-dev`
- Clerk JS failed to load — check browser console with `ab console-tail`
- The ticket expired (5 min TTL) — retry `ab reauth`

**Auth works but pages show sign-in**
The session may have expired. Run `ab reauth` to get a fresh one.

## Code References

| File | Purpose |
|------|---------|
| `src/api/dev-login.ts` | Backend endpoint — mints Clerk sign-in tokens |
| `web/app-home/src/DevLogin.tsx` | Frontend — exchanges ticket for session |
| `~/Documents/Development/tools/ab/src/auth.ts` | ab-server auth flow |
| `~/Documents/Development/tools/ab/src/cli.ts` | CLI reauth command |
