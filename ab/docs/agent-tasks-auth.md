# Agent Tasks Auth Flow

How `ab` authenticates browser sessions against Terra dev and staging. No Google OAuth, no cookie stealing, no Terra endpoint: `ab` mints a [Clerk Agent Task](https://clerk.com/docs) directly against the **development** Clerk instance.

## How It Works

```
Agent calls: ab reauth
    │
    ▼
ab CLI  ── reads CLERK_SECRET_KEY from its own env
    │      sends it to the daemon inside the login RPC body only
    ▼
ab-server daemon
    │
    ├─ Already on the app origin and not on /sign-in? → done (skip)
    │
    ├─ Guards (pure function, checkAgentTaskGuards):
    │     key must start with sk_test_   (development instance)
    │     app host must not be terra.clay.com
    │
    ├─ clerk.agentTasks.create({
    │     onBehalfOf: { identifier: <email> },
    │     permissions: '*', agentName: 'ab', taskDescription: 'ab reauth',
    │     redirectUrl: <appBaseUrl>/, sessionMaxDurationInSeconds: 3600 })
    │   → { agentId, taskId, url }   url = one-time Clerk-hosted URL
    │
    ├─ Open url in headless Chrome, wait networkidle
    │   → Clerk sets the session and redirects to the app origin
    │
    ├─ Poll until the browser URL is on the app origin, off /sign-in, AND
    │   `agent-browser cookies get --json` shows a Clerk session cookie for the
    │   app host (`__session`, or `__client_uat` other than "0"), up to 15s
    │
    └─ Done. Browser has a real Clerk session for 1 hour.
```

The minted URL and the ticket in it are one-time and secret. `ab` never logs them, and never logs or persists the secret key.

## When Auth Happens

- **First `ab open`** for a session: if the browser is not already on an authenticated page, run `ab reauth`.
- **`ab reauth`**: explicit re-authentication. Use when a session expires (Agent Task sessions last 1 hour) or you switch users.
- **Chrome restart**: the daemon invalidates auth state when Chrome crashes and restarts. Run `ab reauth` again.

## Configuration

| Env Var | Default | Purpose |
|---------|---------|---------|
| `CLERK_SECRET_KEY` | (none, required) | Development-instance Clerk secret key (`sk_test_...`). Read from the **`ab` CLI process** env (direnv in Terra) and passed to the daemon per request. The daemon never reads its own env for it: the launchd daemon does not have the variable. |
| `AB_AUTH_EMAIL` | `blake.johnson@clay.com` | Email of the user to sign in as. Must already have a Clerk account in this instance. |
| `AB_APP_BASE_URL` | `http://localhost:5173` (or auto-detected) | App origin the session must land on, and the Agent Task `redirectUrl`. |

For staging:

```bash
ab reauth --staging     # preset: https://slack-feedback-staging.onrender.com
```

## Safety Guards

All in `checkAgentTaskGuards` (`src/auth.ts`), unit-tested:

- No key, or a key that is not `sk_test_`: refused. Production (`sk_live_`) keys are never used.
- App host `terra.clay.com`: refused, even with a test key.
- `ab reauth --prod`: errors out. Production uses `ab import` (headed Google login).

The already-authenticated-on-same-origin shortcut runs before the guards. `ab import` relies on it: after you log in by hand, `ab import` reads the browser's current URL and sends its origin as `appBaseUrl`, so the daemon sees an authenticated page on the same origin and never mints (and never needs a key). If the browser is on `/sign-in` or a non-app page, `ab import` says so and exits 1 without calling the daemon. This works for any origin, production included.

A `sk_test_` key from a different Clerk project passes the guards but mints on the wrong instance. The final cookie check catches it: the browser lands on the app origin with no Clerk session, and `ab reauth` fails with "has no Clerk session" instead of reporting success.

## Prerequisites

1. `CLERK_SECRET_KEY` (development instance) exported in the shell that runs `ab`.
2. The user must have logged in via Google OAuth at least once in this environment. Clerk needs an existing account. Otherwise `ab` reports "has no Clerk account in this environment".
3. Terra needs no special endpoint. `POST /auth/dev-login` and the `/dev-login` page no longer exist.

## Troubleshooting

**"CLERK_SECRET_KEY is not set"**
Export the development key in the shell running `ab` (direnv does this inside the Terra repo). The `ab` CLI sends it with each request. Setting it in the daemon's environment has no effect. If this appears after `ab import`, you are on an old CLI or daemon (see Upgrading).

**"has no Clerk session"**
The browser reached the app but holds no Clerk session cookie. `CLERK_SECRET_KEY` is probably the development key of a different Clerk project (for example from another repo's direnv). Use the key for this app's Clerk instance.

**"Refusing to mint: ... not a development-instance key"**
The key does not start with `sk_test_`. Use the development key. For production use `ab import`.

**"has no Clerk account in this environment"**
Log in via Google OAuth once at the app URL, then retry.

**"Auth exchange timed out"**
The browser did not land on the app origin within 15s. Causes: the dev server is down, the Agent Task `redirectUrl` origin is not allowed by Clerk, or the one-time URL was already used. Retry `ab reauth` (each run mints a fresh task). Check `ab console-tail`.

**Auth works but pages show sign-in**
The 1 hour session expired. Run `ab reauth`.

## Upgrading

The daemon is long-lived under launchd (`com.clay.ab-server`). After pulling this change:

1. `bun install` in `tools/ab` (adds `@clerk/backend`).
2. Restart the daemon: `launchctl kickstart -k gui/$(id -u)/com.clay.ab-server`.

Skip the restart and the old daemon keeps running its old code. It strips the unknown `clerkSecretKey` field and still calls Terra's removed `/auth/dev-login`, so `ab reauth` fails.

## Code References

| File | Purpose |
|------|---------|
| `src/auth.ts` | `authenticate()` flow (runs inside a `LoginBudget`: abort signal + deadline from the route), `authenticateJoined` (one shared login per port and app base), `checkAgentTaskGuards`, `loginTimedOutError`, injectable Clerk client seam |
| `src/server.ts` | `POST /auth/login` (`handleAuthLogin`: 60 s budget; an expired budget answers 400 with the login-timeout error) and `GET /auth/status` |
| `src/cli.ts` | `cmdReauth` (forwards `CLERK_SECRET_KEY`), `cmdImport` (pins `appBaseUrl` to the browser origin) |
| `src/app-origins.ts` | `resolveReauthBaseUrls`, `REAUTH_ENV_PRESETS`, worktree and auto-auth origin rules |
| `src/login-request.ts` | `loginRequest()`, the `AuthLoginRequest` body the CLI sends (default email, optional key) |
| `src/auto-auth.ts` | `autoAuthAfterOpen`, the auto-auth step after `ab open` on a dev app origin |
| `src/types.ts` | `AuthLoginRequest.clerkSecretKey` |
| `src/__tests__/auth.test.ts`, `auth-guards.test.ts`, `auth-single-flight.test.ts` | Tests (fake Clerk client, no network) |
