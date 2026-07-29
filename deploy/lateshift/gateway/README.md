# LateShift Cloud — v2 single-origin gateway (Caddy)

One origin: `https://lateshiftcloud.com`. Cloudflare terminates TLS and the
`lateshift` cloudflared tunnel forwards to Caddy on loopback. Caddy routes by
PATH, not by host:

| Path                     | Behaviour                                                          |
| ------------------------ | ------------------------------------------------------------------ |
| `/~lsc/authz*`           | hard 404 (Caddy-internal endpoint, never public)                    |
| `/~lsc`, `/~lsc/*`       | reverse_proxy to the portal                                         |
| everything else          | `forward_auth` portal `/authz` → reverse_proxy to the workspace unix socket named by `X-Lsc-Upstream` |
| any non-apex host        | 302 to `https://lateshiftcloud.com{uri}` (www + retired subdomains) |

There are no per-user subdomains, no `lsc-users.caddy`, and no
`render-gateway` — all deleted in W7-C. The workspace IS the site; the portal
owns only the reserved root `/~lsc` (spike W0-C).

## Authz contract (portal `GET /authz`, forward_auth target)

The gateway forwards the original `Cookie` header. The portal resolves
session → user → selected workspace (`lsc_ws` cookie, validated against
registry membership on EVERY request; absent → personal workspace) and
answers:

- **200** + `X-Lsc-Upstream: unix//run/lsc/<ws>/http.sock` + `X-Lsc-User:
  <github login>` — Caddy `copy_headers` both onto the request and proxies to
  that socket. The portal never returns 200 without `X-Lsc-Upstream`.
- **401** + `X-Authz-Redirect` — Caddy 302s the browser to sign-in.
- **403** — forbidden page (non-member, unknown user, disabled user, corrupt
  registry, any error at all: /authz fails CLOSED — architecture-v2 R2).
- **503** — valid member but the workspace socket is not up; Caddy serves a
  self-refreshing "starting" page instead of a bare 502.

Resolution logic: `portal/lib/workspaces.mjs` (single decision table).

## Load-bearing facts (also in the Caddyfile header — do not "clean up")

1. The `route { }` wrapper is mandatory: Caddy's default directive order runs
   `request_header` AFTER `forward_auth`'s `copy_headers`, which wipes
   `X-Lsc-Upstream` and 502s every request (spike W0-B, caddy v2.11.4).
2. The inbound strip of `X-Lsc-User` / `X-Lsc-Upstream` / `X-Ops-Token` /
   `X-Authz-Host` / `Tailscale-User-*` stays even though `copy_headers`
   already replaces: it covers any future path that bypasses forward_auth.
3. Dynamic upstream from a forward_auth response header works on the stock
   caddy v2.11.4 with unix-socket dial addresses and WebSocket upgrade, and
   fails closed (2xx without the header dials the empty address → 502, never
   a client-chosen host).
4. Caddy normalizes `%7E`: the `/~lsc` matcher also catches `/%7Elsc/...`.
5. NOT yet proven: sustained SSE / large-frame WS throughput through the
   dynamic upstream (`flush_interval -1` is set; look there first).

## Paths the portal must never claim (T3 owns them)

`/`, `/assets/*`, `/api/*`, `/oauth/*`, `/.well-known/*`, `/ws`, `/mcp`,
`/favicon*.ico`, `/favicon-*.png`, `/apple-touch-icon.png`,
`/mockServiceWorker.js`, `/settings*`, `/pair`, `/connect*`, `/draft/*`, and
every two-segment path (`/$environmentId/$threadId` catches them all).
Links from inside the T3 shell to `/~lsc/*` must be real document
navigations, never SPA `<Link>`s.

## Installation / shadow run

`tools/install.sh` deliberately does NOT install this Caddyfile: copying it to
`/etc/caddy/Caddyfile` retires the live v1 subdomain gateway and IS the W8
cutover. Shadow run alongside the live stack (nothing shared):

```sh
sudo LSC_HTTP_PORT=8881 LSC_PORTAL_UPSTREAM=127.0.0.1:3791 \
  caddy run --config deploy/lateshift/gateway/Caddyfile --adapter caddyfile
```

The process needs the `caddy` group (or root) to traverse
`/run/lsc/<ws>/` (`0750 <ws>:caddy`).

## Tests

- `sudo node gateway/smoke-gateway.mjs` — boots the real portal + this real
  Caddyfile on shadow ports (8881/3798) and asserts the whole table above,
  including the WebSocket upgrade and the forged-header overwrite. 10 checks.
- `node portal/test/authz-matrix.mjs` — the exhaustive 26-case /authz matrix
  (W7-D), every deny row asserted.
