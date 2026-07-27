# LateShift Cloud — per-user T3 Code instances

This directory is the source of truth for the multi-instance ("LateShift Cloud")
deployment on host `t3cloud`. The installed copies live under `/etc/systemd/system/`
and `/home/dev/services/lateshift/`; changes should be made here first, then
re-installed (see "Installing" below).

## Architecture

```
t3code.service                     production instance (DO NOT TOUCH)
  port 3773  ->  tailscale serve HTTPS 443

t3code@<user>.service              one templated unit per LateShift user
  runs: bin/run-instance.sh <user>
    -> node .../bin.mjs serve --base-dir /home/dev/services/lateshift/users/<user>
         --port $T3CODE_INSTANCE_PORT --tailscale-serve --tailscale-serve-port $TS_SERVE_PORT
  port 3780+ ->  tailscale serve HTTPS 8460+
```

- Each user gets a fully isolated T3 base dir at
  `/home/dev/services/lateshift/users/<user>` (all state under `userdata/`).
- Local HTTP ports are allocated sequentially from **3780**; tailnet HTTPS
  ports from **8460**. Port **3773** and HTTPS **443** are reserved for
  production and are guarded against in both the launcher and the registry.
- The server itself configures `tailscale serve` for its HTTPS port on startup
  (via `--tailscale-serve --tailscale-serve-port`). One HTTPS port maps to one
  backend, root path only.
- Tailnet hostname: `t3cloud.taild7c97b.ts.net`.

## Files

| Repo file          | Installed at                                        |
|--------------------|-----------------------------------------------------|
| `t3code@.service`  | `/etc/systemd/system/t3code@.service`               |
| `run-instance.sh`  | `/home/dev/services/lateshift/bin/run-instance.sh`  |
| `t3user`           | `/home/dev/services/lateshift/bin/t3user`           |
| `README.md`        | `/home/dev/services/lateshift/README.md`            |

Runtime-only paths (not in the repo):

- `/home/dev/services/lateshift/users.json` — the user/port registry (schema below)
- `/home/dev/services/lateshift/users/<name>/` — per-user base dirs
- `/home/dev/services/lateshift/users/<name>/instance.env` — per-instance config
- `/home/dev/services/lateshift/archive/` — archived data of removed users

## Registry: `users.json`

This file is the contract the LateShift portal reads. `t3user` is its only
writer (mutations are serialized with an flock).

```json
{
  "users": {
    "<name>": {
      "localPort": 3780,
      "tsPort": 8460,
      "baseDir": "/home/dev/services/lateshift/users/<name>",
      "projectLimit": 3,
      "sharedAccess": false,
      "admin": false,
      "createdAt": "2026-07-27T00:00:00Z"
    }
  },
  "nextLocalPort": 3781,
  "nextTsPort": 8461
}
```

- `localPort` — 127.0.0.1 HTTP port the instance binds.
- `tsPort` — HTTPS port on the tailnet (`https://t3cloud.taild7c97b.ts.net:<tsPort>/`).
- `baseDir` — the instance's `--base-dir`.
- `projectLimit` — mirrored into `instance.env` as `T3CODE_MAX_PROJECTS`
  (enforcement lands in a later phase).
- `sharedAccess` — reserved: whether the user can see shared Roblox project dirs.
- `admin` — reserved: portal admin flag.
- `nextLocalPort` / `nextTsPort` — monotonic allocators; ports of removed users
  are intentionally not reused.

## `instance.env`

Consumed by `t3code@<name>.service` via `EnvironmentFile=`:

```
T3CODE_INSTANCE_PORT=3780   # local HTTP port
TS_SERVE_PORT=8460          # tailnet HTTPS port
T3CODE_MAX_PROJECTS=3       # reserved for the project-limit phase
```

The CLI takes flags rather than env vars, so `run-instance.sh` translates these
into `--port` / `--tailscale-serve-port` and execs node.

## `t3user` CLI

```
t3user add <name> [--project-limit N] [--admin]  # provision + enable + start + health-wait
t3user remove <name>                             # stop+disable unit, archive base dir (no rm -rf)
t3user list                                      # table of registered users
t3user pair <name> [--ttl 1h]                    # one-time pairing URL for the instance
```

- Names must match `[a-z0-9-]{2,20}`; `add` refuses existing users.
- `remove` archives to `/home/dev/services/lateshift/archive/<name>-<utc-ts>` and
  clears the instance's `tailscale serve` HTTPS mapping (guarded to never touch 443).
- `pair` uses `t3 auth pairing create` with
  `--base-url https://t3cloud.taild7c97b.ts.net:<tsPort>` (works via direct
  SQLite access while the instance runs).

## Resource caps

Box: 7.6 GiB RAM, 4 cores; each instance idles around 1 GiB. Per instance:
`MemoryHigh=1G`, `MemoryMax=1536M`, `CPUQuota=150%`, `TasksMax=512`.
That leaves room for the production instance plus roughly 4–5 user instances.

## Installing / updating

```sh
sudo install -m 644 deploy/lateshift/t3code@.service /etc/systemd/system/t3code@.service
sudo systemctl daemon-reload   # safe: does not restart running units
install -m 755 deploy/lateshift/run-instance.sh /home/dev/services/lateshift/bin/run-instance.sh
install -m 755 deploy/lateshift/t3user          /home/dev/services/lateshift/bin/t3user
install -m 644 deploy/lateshift/README.md       /home/dev/services/lateshift/README.md
```

Restart individual user instances (`sudo systemctl restart t3code@<name>`) to
pick up launcher changes. **Never restart `t3code.service` itself.**

## Environment / secrets

Production's `EnvironmentFile=/home/dev/.t3-env` is currently empty; no shared
secrets are required by instances. Provider credentials are configured per user
inside each instance's own `userdata`. If shared keys are ever introduced, add a
second `EnvironmentFile=` line to the template.
