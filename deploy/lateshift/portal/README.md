# LateShift Cloud — admin portal

Zero-dependency, server-rendered Node ESM app. Runs on `127.0.0.1:$PORT`
(default 3790) behind the public Caddy gateway. Identity is the signed
`lsc_session` cookie minted by GitHub OAuth — there is no second identity
system. See the top of `server.mjs` for the security model (CSRF on every
POST, `execFile`-only shell-outs, `assertSafeUnit`).

## Files

- `server.mjs`    — HTTP routing, request context, admin/dashboard data assembly.
- `views.mjs`     — all HTML (every dynamic value passes through `esc()`).
- `lib/registry.mjs` — read-only registry + `portal.config.json` loader.
- `lib/actions.mjs`  — validated shell-outs (`t3user`, `systemctl`).
- `lib/history.mjs`  — read-only usage/history readers over each instance's
  `state.sqlite` (`turn_usage`), including provider bucketing.
- `lib/paths.mjs`    — the reserved URL root (`/~lsc`) and the prefix-stripping
  helper every route goes through.
- `lib/profiles.mjs` — GitHub avatar + display-name cache (`profiles.json`),
  captured at the OAuth callback. Contains no secrets.
- `lib/usage.mjs`    — the account page's usage seam: the interface W3's
  rate-limit collector must satisfy (pool state), plus the turn_usage-derived
  share-of-consumption that exists today.
- `test/w4-smoke.mjs` — dependency-free assertions over paths, OAuth scope /
  state-intent handling, avatar-URL sanitising and view escaping.
  Run: `node test/w4-smoke.mjs`.

## Reserved URL root — `/~lsc`

Under the v2 single-origin design the apex serves the *workspace*, not the
portal, so every portal-owned URL lives under one reserved root:

```
/~lsc/account                       account page (identity, GitHub, usage, sign out)
/~lsc/admin, /~lsc/admin/*          admin console (GET + all POSTs)
/~lsc/auth/github/login|connect|callback, /~lsc/auth/logout
/~lsc/authz                         forward_auth target (loopback only)
/~lsc/static/logo.png, /~lsc/healthz
```

Spike W0-C established why one odd root beats several plausible top-level
names: the T3 server's `GET *` catch-all never 404s and its
`/$environmentId/$threadId` client route claims every two-segment path, so a
future upstream `/account` would silently render the chat SPA instead of the
portal page. `'~'` is a character upstream will never start a route with.

`lib/paths.mjs` strips the prefix, so the route table in `server.mjs` is still
written in bare form and **unprefixed paths keep working**. Those bare aliases
are transitional — they exist because the deployed gateway and the GitHub OAuth
app's registered `redirect_uri` still point at `/auth/github/callback`. Delete
them once W7's gateway and the OAuth app both use the prefix.

`/favicon.ico` is **no longer served by the portal**: under a single origin it
belongs to T3, whose `index.html` links it (W0-C finding 1). Portal branding
lives at `/~lsc/static/logo.png`.

Every link out of the T3 shell into `/~lsc/*` must be a real document
navigation (a plain `<a>`, not a TanStack `<Link>`) and every admin form a real
form POST — otherwise the SPA router swallows it. That constraint belongs to
the fork work, not to this app.

## Admin portal

Master/detail: left = every registered user plus the admin's own account
(status dot + Edit affordance); selecting one (`/admin?u=<name>` or `?u=@self`)
shows settings (project limit, admin flag), GitHub connection status, and
remove. Sharing and budgets were removed in the v2 deletion sweep; team
workspaces arrive in W6.

Light/dark theme toggle is a pure client-side preference persisted in the
`lsc_theme` cookie (no server mutation, so no CSRF needed); dark is the default.

## portal.config.json

All fields optional. Read-only to the portal; edit the file directly.

```jsonc
{
  // --- Public sign-in via GitHub OAuth (all OPTIONAL; absence tolerated) ---
  "githubClientId":     "…",                    // GitHub OAuth app client id
  "githubClientSecret": "…",                    // GitHub OAuth app client secret
  "sessionSecret":      "<32-byte hex>",        // HMAC key for the lsc_session cookie
  "publicBaseUrl":      "https://lateshiftcloud.com",
  "cookieDomain":       ".lateshiftcloud.com",  // session-cookie Domain on the public host
  "adminGithubLogins":  ["you"]                 // GitHub logins that are admins
}
```

Each key above is read on every request and tolerated absent (→ `null`/`[]`).
`portal.config.json` holds the OAuth secret + `sessionSecret`, so it is
`chmod 600`.

A **Usage leaderboard** ranks users by month-to-date total cost with an inline
per-provider (Claude / Codex / other) breakdown.

## Public sign-in (GitHub OAuth)

The portal is reached publicly as `https://lateshiftcloud.com` via a Cloudflare
Tunnel → local gateway that forwards to `127.0.0.1:3790` with
`X-Forwarded-Host` / `X-Forwarded-Proto` set. Requests authenticate with the
signed session cookie; there is no other identity path.

- `lib/auth.mjs` — GitHub OAuth (standard web flow, no libraries), the
  HMAC-SHA256-signed `lsc_session` cookie, the signed OAuth-`state` cookie,
  and the JSON pending-approval store. All crypto via `node:crypto`, all
  outbound HTTP via the Node global `fetch`.

**OAuth flow.** `GET /~lsc/auth/github/login` → 302 to
`github.com/login/oauth/authorize` with **`scope=read:user`** and a signed
`state` (random nonce **plus the intent**, HMAC'd, mirrored in a short-lived
HttpOnly cookie). `GET /~lsc/auth/github/callback` verifies `state`
(constant-time + signature), exchanges the code for a token
(`Accept: application/json`), fetches `api.github.com/user`, persists the
avatar + display name to `profiles.json`, then mints the session and routes:
known+approved user → workspace, admin → `/~lsc/admin`, unknown login →
recorded in `pending.json` + an awaiting-approval page. `GET /~lsc/auth/logout`
clears the session; the account page signs out with a **CSRF-protected POST** to
the same path.

**Two scopes, two consents.** Sign-in used to request
`read:user repo workflow` — repo *write* access, taken at first contact from a
stranger the admin had not yet approved. It is now split:

| Flow | Route | Scope |
|---|---|---|
| Sign in | `/~lsc/auth/github/login` | `read:user` |
| Connect push access | `/~lsc/auth/github/connect` | `read:user repo workflow` |

`/…/connect` requires an existing session and is reachable only from the
account page's GitHub card. The callback reads the **granted** scopes off the
token response (never what we asked for) and installs a credential into a
workspace's `gh` store **only** when `repo` was actually granted — so a narrow
sign-in token can never masquerade as, or overwrite, a connected store.
Credentials installed before this change are untouched and keep working; the
intent is optional in the signed state, so sign-ins already in flight across a
deploy still verify.

**Account page** (`/~lsc/account`): avatar + name + `@login`, GitHub connection,
workspace memberships, usage, and sign out. The header control on every page is
an avatar + GitHub display name linking here — no GitHub mark (that stays on
the signed-out hero button only). Internal short names do not appear on any
user-visible surface; they survive as UNIX account and systemd unit names, and
in the admin panel where the admin acts on the unit.

**Usage on the account page** shows the two §4 displays and never blends them:
*Pool remaining* is provider truth from W3's rate-limit collector — currently
`null`, which renders as **"unknown"**, and must never be an estimate; *your
share* is our own `turn_usage` attribution, as a percentage of the fleet's
month-to-date recorded consumption. The interface W3 must satisfy is documented
at the top of `lib/usage.mjs`.

**Session cookie.** `lsc_session = base64url(payload).sig`, payload
`{v:1, gh:<login>, iat, exp}` (7 days). `Secure; HttpOnly; SameSite=Lax`;
`Domain=cookieDomain` only when the request arrived via the public host
(`X-Forwarded-Host` under `lateshiftcloud.com`), host-only otherwise.
Signature verification is constant-time.

**Identity.** `resolveIdentity` takes the GitHub login from the session. A
registry user matches when its `githubLogin` field equals the session login
(case-insensitive); admins are users with `admin: true` or a login in
`adminGithubLogins`.

**Approvals.** The admin panel gains a **Pending requests** card (avatar, login,
requested time) with CSRF-protected **Approve** (workspace name `[a-z0-9-]{2,20}`
prefilled from the login + project limit) and **Deny** actions. Approve runs
`actions.addUser` then `t3user set <name> githubLogin <login>` and removes the
entry from `pending.json`; Deny moves it to the store's `denied[]` (honoured on
future signups).

**Gateway authz endpoint.** `GET /authz` is loopback-only (called by the
gateway). It reads the forwarded `Cookie` and `X-Authz-Host: <public hostname>`:

- apex host → `200` (portal self-authenticates)
- subdomain label = a registry user name, session resolves to that user (or an
  admin) → `200` + `X-Lsc-User: <name>`
- label `prod` → admins only → `200`
- no/invalid session → `401` + `X-Authz-Redirect: <publicBaseUrl>/auth/github/login`
- valid session, wrong user → `403`; unknown label → `404`

## Ops broker (`/internal/ops/<action>`) — lib/ops.mjs

A loopback-only, **CSRF-exempt** machine RPC that lets the admin's *sandboxed*
T3 workspace modify and redeploy the LateShift Cloud system it runs inside,
while being structurally **incapable of touching production** (`t3code.service`,
port 3773 / 443, `/home/dev/.t3`, cloudflared). Same posture as
`/internal/roblox-create`.

**Auth.** Every request must carry `X-Ops-Token` matching the secret stored two
places by design:

- `…/users/slither/identity/ops-token` — inside the admin's base dir, readable
  by their sandbox (its own identity copy).
- `…/secrets/ops-token` — the copy the portal validates against
  (constant-time). This dir is `InaccessiblePaths=` for every instance sandbox,
  so no sandbox can read the validating secret.

Both are `600 dev:dev`, 32-byte hex. Any request bearing `X-Forwarded-Host` is
rejected `403` (the public gateway can never reach this route). Bad/absent token
→ `401`.

**Safety.** `assertOpsUnit()` builds systemctl/journalctl targets only for
`t3code@<name>` template instances or a fixed whitelist; the bare production
unit can never be named (`PRODUCTION_UNITS` guard). Production appears **only**
as a read-only health bit in `status`. All shell-outs are `execFile` (argv
arrays). Every action appends one line — action, params minus secrets, outcome —
to `…/ops-audit.log` (append, 600). Secrets are never logged.

**Actions** (all `POST http://127.0.0.1:3790/internal/ops/<action>`, JSON in/out
`{ok, …}`):

1. `status` `{}` → instance states, portal/caddy states, production
   health bit, checkout branch+commit, portal branch+commit.
2. `rebuild-checkout` `{branch}` (`[A-Za-z0-9._/-]{1,80}`) → in the build
   checkout: fetch origin `<branch>`, `reset --hard`, `pnpm install
   --prefer-offline`, `vp pack` (apps/server), web build, branding. The heavy stages run in a transient `systemd-run`
   unit as dev (OUTSIDE the portal cgroup, whose `MemoryMax=256M` would
   otherwise OOM-kill the build). Synchronous
   with generous timeouts; returns per-stage tail output; stops at first failure.
3. `restart-instance` `{name, delaySeconds?}` → only `t3code@<name>`. For the
   **calling workspace** (`slither`) a bare call is refused; pass
   `delaySeconds` (10-300) to schedule a delayed self-restart via
   `systemd-run --on-active=<N>s --unit=lsc-delayed-restart-<name>` (refused if
   one is already pending) so the instance restarts *after* the turn. Other
   instances: immediate restart + health-poll of `localPort` (200 within 60s).
4. `deploy-portal` `{}` → the portal redeploys **itself**. In-process (as dev) it
   backs up the installed dir to `portal.bak-<ts>` and rsyncs the source over it
   (`static/` preserved), then hands restart + `/healthz` poll + **auto-rollback**
   to a **detached `systemd-run` supervisor** (`lsc-portal-redeploy`) that is
   independent of the portal process — so the HTTP response is sent *before* the
   restart. On failed healthz the supervisor restores the backup and restarts
   again, recording the final outcome to the audit log. Verify via
   `status`/`healthz`.
5. `update-gateway` `{}` → runs `render-gateway` (reloads caddy).
6. `logs` `{unit, lines<=200}` → `journalctl` for whitelisted units only
   (`t3code@*`, `lateshift-portal`, `caddy`) — never
   production `t3code.service`.
7. `pull-infra` `{}` → `git fetch origin` + ahead/behind of `lateshift-cloud`
   vs origin (read-only; no merge).
