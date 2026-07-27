# LateShift Cloud — public gateway (Caddy)

Public front door for `lateshiftcloud.com`. Cloudflare terminates TLS and the
`lateshift` cloudflared tunnel forwards `lateshiftcloud.com` and
`*.lateshiftcloud.com` to `http://127.0.0.1:8880`, where Caddy routes:

| Host                          | Behaviour                                                        |
| ----------------------------- | --------------------------------------------------------------- |
| `lateshiftcloud.com`, `www.`  | reverse_proxy to the portal (`127.0.0.1:3790`), no authz        |
| `<user>.lateshiftcloud.com`   | `forward_auth` /authz then reverse_proxy to that user's port    |
| `prod.lateshiftcloud.com`     | `forward_auth` /authz (admin-only per portal) then proxy `3773` |
| any other `*.lateshiftcloud.com` | 404 page                                                     |

Caddy listens **only** on `127.0.0.1:8880`, plain HTTP (`auto_https off`,
`default_bind 127.0.0.1`). It never binds a public interface and never touches
ports 80/443 — TLS is Cloudflare's job. WebSockets pass through natively
(`reverse_proxy` upgrades).

## Files

- `Caddyfile` — main config. Installed to `/etc/caddy/Caddyfile`. Defines the
  `lsc_gated` snippet (forward_auth + reverse_proxy), the apex/www/prod/404
  blocks, and `import /etc/caddy/lsc-users.caddy`.
- `render-gateway` — regenerates the per-user site blocks. Installed to
  `/home/dev/services/lateshift/bin/render-gateway`.

## Authz contract (portal `GET /authz` on 127.0.0.1:3790)

The gateway sends the original `Cookie` header (forwarded automatically) plus
`X-Authz-Host: <public hostname>`. Expected responses:

- **200** — allow. Portal returns `X-Lsc-User`, which Caddy copies onto the
  upstream request before proxying.
- **401** — not signed in. Portal returns `X-Authz-Redirect: <login URL>`;
  Caddy 302-redirects the browser there.
- **403** — signed in but forbidden. Caddy serves a small forbidden page.

The apex host is proxied straight to the portal with no authz call.

## Per-user mapping: `render-gateway`

Reads `/home/dev/services/lateshift/users.json` and writes
`/etc/caddy/lsc-users.caddy` (atomic, idempotent), one block per active user:

```
<name>.lateshiftcloud.com {
	import lsc_gated <localPort>
}
```

Then `systemctl reload caddy` (skip with `--no-reload`). Must run as root;
safe on an empty or missing registry. It is invoked best-effort at the tail of
`t3user add` / `t3user remove` so the gateway tracks the registry
automatically. Run it manually after hand-editing users.json:

```
sudo /home/dev/services/lateshift/bin/render-gateway
```

## Install / cutover

```sh
# Caddy from the official apt repo (one-time)
sudo apt-get install -y caddy

sudo install -m 644 Caddyfile /etc/caddy/Caddyfile
sudo install -m 755 render-gateway /home/dev/services/lateshift/bin/render-gateway
sudo /home/dev/services/lateshift/bin/render-gateway --no-reload   # seed lsc-users.caddy
caddy validate --config /etc/caddy/Caddyfile

# cutover from the placeholder to Caddy on 8880
sudo systemctl disable --now lsc-gateway-placeholder
sudo systemctl enable --now caddy
```

Nothing here affects the tailnet paths (portal `:8450`, instances `:8460+`,
production `:443` via `tailscale serve`) — those are independent of Caddy.
