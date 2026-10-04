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
    ├─ Poll the browser URL until it is on the app origin and off /sign-in
    │   (up to 15s)
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
| `CLERK_SECRET_KEY` | (none, required) | Development-instance Clerk secret key (`sk_test_...`). Read from the **`ab` CLI process** env (direnv in Terra) and passed to the daemon per request. If the request omits it, the daemon's own env is used. |
| `AB_AUTH_EMAIL` | `blake.johnson@clay.com` | Email of the user to sign in as. Must already have a Clerk account in this instance. |
| `AB_SLACK_USER_ID` | `U08M03CDY73` | Display only. A Slack ID alone is rejected: mapping Slack ID to email needs Terra's DB, which `ab` does not read. |
| `AB_APP_BASE_URL` | `http://localhost:5173` (or auto-detected) | App origin the session must land on, and the Agent Task `redirectUrl`. |
| `AB_API_BASE_URL` | unused | Kept for compatibility. Reauth no longer calls Terra's API. |

For staging:

```bash
ab reauth --staging     # preset: https://slack-feedback-staging.onrender.com
```

## Safety Guards

All in `checkAgentTaskGuards` (`src/auth.ts`), unit-tested:

- No key, or a key that is not `sk_test_`: refused. Production (`sk_live_`) keys are never used.
- App host `terra.clay.com`: refused, even with a test key.
- `ab reauth --prod`: errors out. Production uses `ab import` (headed Google login).

The already-authenticated-on-same-origin shortcut runs before the guards, so `ab import` followed by the daemon's auth grab still works against any origin.

## Prerequisites

1. `CLERK_SECRET_KEY` (development instance) exported in the shell that runs `ab`.
2. The user must have logged in via Google OAuth at least once in this environment. Clerk needs an existing account. Otherwise `ab` reports "has no Clerk account in this environment".
3. Terra needs no special endpoint. `POST /auth/dev-login` and the `/dev-login` page no longer exist.

## Troubleshooting

**"CLERK_SECRET_KEY is not set"**
Export the development key in the shell running `ab` (direnv does this inside the Terra repo). The daemon does not need it in its own env.

**"Refusing to mint: ... not a development-instance key"**
The key does not start with `sk_test_`. Use the development key. For production use `ab import`.

**"has no Clerk account in this environment"**
Log in via Google OAuth once at the app URL, then retry.

**"slackUserId login is not supported"**
Set `AB_AUTH_EMAIL`. `ab` cannot map a Slack ID to an email.

**"Auth exchange timed out"**
The browser did not land on the app origin within 15s. Causes: the dev server is down, the Agent Task `redirectUrl` origin is not allowed by Clerk, or the one-time URL was already used. Retry `ab reauth` (each run mints a fresh task). Check `ab console-tail`.

**Auth works but pages show sign-in**
The 1 hour session expired. Run `ab reauth`.

## What Replaced What

1. Cookie stealing from personal Chrome (fragile, slow).
2. `POST /auth/dev-login` on Terra plus a `/dev-login?ticket=` page. Removed with Terra's credential-less mint.
3. Now: direct Clerk Agent Task, development instance only.

## Code References

| File | Purpose |
|------|---------|
| `src/auth.ts` | `authenticate()` flow, `checkAgentTaskGuards`, injectable Clerk client seam |
| `src/cli.ts` | `cmdReauth` (forwards `CLERK_SECRET_KEY`), `resolveReauthBaseUrls` |
| `src/types.ts` | `AuthLoginRequest.clerkSecretKey` |
| `src/__tests__/auth.test.ts`, `auth-guards.test.ts` | Tests (fake Clerk client, no network) |
