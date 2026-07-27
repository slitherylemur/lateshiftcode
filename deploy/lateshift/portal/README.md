# LateShift Cloud — admin portal

Zero-dependency, server-rendered Node ESM app. Runs on `127.0.0.1:$PORT`
(default 3790) behind Tailscale Serve, which injects the caller's tailnet
identity via `Tailscale-User-*` headers. See the top of `server.mjs` for the
security model (CSRF on every POST, `execFile`-only shell-outs, `assertSafeUnit`).

## Files

- `server.mjs`    — HTTP routing, request context, admin/dashboard data assembly.
- `views.mjs`     — all HTML (every dynamic value passes through `esc()`).
- `lib/registry.mjs` — read-only registry + `portal.config.json` loader.
- `lib/actions.mjs`  — validated shell-outs (`t3user`, `systemctl`, pairing).
- `lib/history.mjs`  — read-only usage/history readers over each instance's
  `state.sqlite` (`turn_usage`), including provider bucketing and the fleet-wide
  5-hour session-window math.

## Admin portal

Master/detail: left = every registered user plus the admin's own account
(status dot + Edit affordance); selecting one (`/admin?u=<name>` or `?u=@self`)
shows settings (project limit, budget, tailnet login, admin/shared flags),
pairing link, remove, and a **share manager** listing every directory under the
single share root `/home/dev/shared/` with an on/off switch reflecting the
user's registry `sharedProjects` grant. Toggling calls the existing
`share` / `unshare` actions. The admin's own detail always shows a "workspace"
card that mints a shared production-workspace pairing, and their share list is
read-only (admins implicitly see every shared project).

Light/dark theme toggle is a pure client-side preference persisted in the
`lsc_theme` cookie (no server mutation, so no CSRF needed); dark is the default.

## portal.config.json

All fields optional. Read-only to the portal; edit the file directly.

```jsonc
{
  "adminLogins": ["you@example.com"],          // tailnet logins that are admins
  "sharedWorkspaceUrl": "https://…/",          // shared production workspace origin
  "sharedStateDb": "/home/dev/.t3/userdata/state.sqlite",
  "subscriptionLimits": {                       // OPTIONAL — tolerated if absent
    "claude":   200,   // USD/month cap for Claude-backed usage
    "codex":    100,   // USD/month cap for Codex/OpenAI usage
    "claude5h":  20,   // USD cap per 5-hour session window (Claude)
    "codex5h":   10    // USD cap per 5-hour session window (Codex)
  },

  // --- Public sign-in via GitHub OAuth (all OPTIONAL; absence tolerated) ---
  "githubClientId":     "…",                    // GitHub OAuth app client id
  "githubClientSecret": "…",                    // GitHub OAuth app client secret
  "sessionSecret":      "<32-byte hex>",        // HMAC key for the lsc_session cookie
  "publicBaseUrl":      "https://lateshiftcloud.com",
  "cookieDomain":       ".lateshiftcloud.com",  // session-cookie Domain on the public host
  "adminGithubLogins":  ["you"],                // GitHub logins that are admins
  "resendApiKey":       "…",                    // OPTIONAL — signup-notification email
  "notifyEmail":        "you@example.com"        // where signup requests are emailed
}
```

Each key above is read on every request and tolerated absent (→ `null`/`[]`).
`portal.config.json` holds the OAuth secret + `sessionSecret`, so it is
`chmod 600`.

The admin **Subscription usage** panel sums `turn_usage.total_cost_usd`
(bucketed by `provider_name` into claude / codex / other) across every user
instance and shows, per provider:

- **Month-to-date** total as a percentage ring against `subscriptionLimits.<provider>`.
- **Current 5-hour window** usage as a bar against `subscriptionLimits.<provider>5h>`,
  with the window reset time.

5-hour windows are **approximate**: fixed 5-hour blocks re-anchored at the
first turn following ≥5 hours of provider inactivity across all instances
combined; usage = cost since the current block start; reset = block start + 5h.
When a cap is absent the ring/bar renders without a percentage.

A **Usage leaderboard** ranks users by month-to-date total cost with an inline
per-provider (Claude / Codex / other) breakdown.

## Public sign-in (GitHub OAuth)

The portal is reached on the tailnet via Tailscale Serve (identity headers,
unchanged) **and** publicly as `https://lateshiftcloud.com` via a Cloudflare
Tunnel → local gateway that forwards to `127.0.0.1:3790` with
`X-Forwarded-Host` / `X-Forwarded-Proto` set. Public requests carry no
Tailscale headers and authenticate with a signed session cookie instead.

- `lib/auth.mjs` — GitHub OAuth (standard web flow, no libraries), the
  HMAC-SHA256-signed `lsc_session` cookie, the signed OAuth-`state` cookie,
  and the JSON pending-approval store. All crypto via `node:crypto`, all
  outbound HTTP via the Node global `fetch`.

**OAuth flow.** `GET /auth/github/login` → 302 to `github.com/login/oauth/authorize`
(`scope=read:user`, `state` = signed random nonce in a short-lived HttpOnly
cookie). `GET /auth/github/callback` verifies `state` (constant-time + signature),
exchanges the code for a token (`Accept: application/json`), fetches
`api.github.com/user`, then mints the session and routes: known+approved user →
dashboard, admin → `/admin`, unknown login → recorded in `pending.json` and an
awaiting-approval page. `GET /auth/logout` clears the session.

**Session cookie.** `lsc_session = base64url(payload).sig`, payload
`{v:1, gh:<login>, iat, exp}` (7 days). `Secure; HttpOnly; SameSite=Lax`;
`Domain=cookieDomain` only when the request arrived via the public host
(`X-Forwarded-Host` under `lateshiftcloud.com`), host-only otherwise.
Signature verification is constant-time.

**Identity.** `resolveIdentity` accepts a tailnet login (preferred, unchanged)
or a GitHub login from the session. A registry user matches when its optional
`githubLogin` field equals the session login (case-insensitive); admins are the
existing tailnet rules **or** a login in `adminGithubLogins`.

**Approvals.** The admin panel gains a **Pending requests** card (avatar, login,
requested time) with CSRF-protected **Approve** (workspace name `[a-z0-9-]{2,20}`
prefilled from the login + project limit) and **Deny** actions. Approve runs
`actions.addUser` then `t3user set <name> githubLogin <login>` and removes the
entry from `pending.json`; Deny moves it to the store's `denied[]` (honoured on
future signups). If `resendApiKey` is set, a notification email is sent via
Resend (failures never break signup; skipped silently when unconfigured).

**Gateway authz endpoint.** `GET /authz` is loopback-only (called by the
gateway). It reads the forwarded `Cookie` and `X-Authz-Host: <public hostname>`:

- apex host → `200` (portal self-authenticates)
- subdomain label = a registry user name, session resolves to that user (or an
  admin) → `200` + `X-Lsc-User: <name>`
- label `prod` → admins only → `200`
- no/invalid session → `401` + `X-Authz-Redirect: <publicBaseUrl>/auth/github/login`
- valid session, wrong user → `403`; unknown label → `404`

> **Note / known limitation.** Setting `githubLogin` requires the `t3user` CLI
> to allow that key; the installed `t3user` currently rejects unknown keys, so
> the Approve step provisions the user but reports that `githubLogin` could not
> be set (owned by another agent — do not edit `t3user` here). Until `t3user`
> accepts `githubLogin`, public GitHub sign-in cannot match an approved user by
> login. The `/authz` matrix, sessions, and OAuth flow are otherwise complete.
