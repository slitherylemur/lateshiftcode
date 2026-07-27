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

| Repo file         | Installed at                                       |
| ----------------- | -------------------------------------------------- |
| `t3code@.service` | `/etc/systemd/system/t3code@.service`              |
| `run-instance.sh` | `/home/dev/services/lateshift/bin/run-instance.sh` |
| `t3user`          | `/home/dev/services/lateshift/bin/t3user`          |
| `README.md`       | `/home/dev/services/lateshift/README.md`           |

Runtime-only paths (not in the repo):

- `/home/dev/services/lateshift/users.json` — the user/port registry (schema below)
- `/home/dev/services/lateshift/users/<name>/` — per-user base dirs
- `/home/dev/services/lateshift/users/<name>/instance.env` — per-instance config
- `/home/dev/services/lateshift/archive/` — archived data of removed users

## Registry: `users.json`

This file is the contract the LateShift portal reads. `t3user` is its only
writer. All subcommands (including `list`) take an exclusive flock on
`.registry.lock` before touching the file, and every write is crash-safe:
temp file in the same directory, `fsync`, atomic rename.

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
- `nextLocalPort` / `nextTsPort` — allocator cursors. Allocation starts at the
  cursor and skips ports that are reserved (3773/443), already in registry
  entries, currently listening (`ss -ltn`), or mapped by `tailscale serve`;
  cursors only advance past committed ports, so ports of removed users are
  not reused. All port values are numerically normalized (leading zeros/`+`
  stripped, 1-65535 enforced) before any comparison or use.

## `instance.env`

Consumed by `t3code@<name>.service` via `EnvironmentFile=`:

```
T3CODE_INSTANCE_PORT=3780   # local HTTP port
TS_SERVE_PORT=8460          # tailnet HTTPS port
T3CODE_MAX_PROJECTS=3       # per-user project limit (unset/0/invalid = unlimited)
T3CODE_SERVER_ROOT=...      # optional: override the server build checkout
```

The CLI takes flags rather than env vars, so `run-instance.sh` translates these
into `--port` / `--tailscale-serve-port` and execs node.

## Server build (patched fork)

User instances run the **LateShift build**, not the production bundle:
`run-instance.sh` execs `${T3CODE_SERVER_ROOT:-/home/dev/services/lateshift/checkout}/apps/server/dist/bin.mjs`.
The checkout tracks branch `lateshift-cloud` and carries two patches on top of
the production server:

1. **Project limit** — `T3CODE_MAX_PROJECTS` is read by the orchestration
   decider on every `project.create` command; once the count of live
   (non-deleted) projects reaches the limit, the command is rejected with
   `Project limit reached (N). Ask your admin to raise it.` (surfaced as a
   normal command error in the UI). Unset, empty, `0`, negative, or
   non-numeric values mean unlimited. Restart the instance after changing it.
2. **Usage ledger** — every accepted provider `turn.completed` event appends a
   row to the `turn_usage` table (migration `035_TurnUsageLedger`).

To update the build:

```sh
cd /home/dev/services/lateshift/checkout
git pull origin lateshift-cloud
corepack pnpm install --frozen-lockfile
corepack pnpm build          # produces apps/server/dist/bin.mjs
# then: sudo systemctl restart t3code@<user>   (NEVER t3code.service)
```

## Usage ledger: `turn_usage` table

Read directly from each instance's `userdata/state.sqlite` by the portal
(no API surface). One row per completed agent turn; append-only.

| Column                    | Type    | Notes                                                        |
| ------------------------- | ------- | ------------------------------------------------------------ |
| `row_id`                  | INTEGER | primary key, autoincrement                                   |
| `thread_id`               | TEXT    | not null                                                     |
| `project_id`              | TEXT    | resolved from the thread projection; nullable                |
| `turn_id`                 | TEXT    | nullable (not every provider reports it)                     |
| `provider_name`           | TEXT    | e.g. `claude`, `codex`; nullable                             |
| `model`                   | TEXT    | comma-joined keys of the provider `modelUsage` map; nullable |
| `total_cost_usd`          | REAL    | nullable (claude reports it; codex does not)                 |
| `input_tokens`            | INTEGER | nullable, best-effort parse of provider usage                |
| `output_tokens`           | INTEGER | nullable                                                     |
| `cached_input_tokens`     | INTEGER | nullable                                                     |
| `reasoning_output_tokens` | INTEGER | nullable                                                     |
| `duration_ms`             | INTEGER | nullable                                                     |
| `usage_json`              | TEXT    | raw `{usage, modelUsage}` JSON from the provider; nullable   |
| `completed_at`            | TEXT    | ISO timestamp, not null; indexed                             |

Indexes: `idx_turn_usage_completed_at`, `idx_turn_usage_thread_id`,
`idx_turn_usage_project_id`. Ledger writes are fail-open: an insert failure is
logged and never breaks turn ingestion, so gaps are possible if the DB is
unhealthy.

## Headless test client

`tools/t3client.mjs` is a dependency-free Node client used to smoke-test
instances end to end (pairing-token exchange → wsTicket → WebSocket RPC). See
`node tools/t3client.mjs --help`; pairing tokens are one-time, mint with
`t3user pair <name>`.

## `t3user` CLI

```
t3user add <name> [--project-limit N] [--admin]  # provision + enable + start + health-wait
t3user remove <name> [--force]                   # stop+disable unit, archive base dir (no rm -rf of live data)
t3user list                                      # table of registered users
t3user pair <name> [--ttl 1h]                    # one-time pairing URL for the instance
```

- Names must match `[a-z0-9-]{2,20}`; `add` refuses existing users; extra
  positional arguments are rejected on every subcommand.
- `add` only commits to `users.json` after the instance is healthy: unit
  `is-active`, local HTTP 200, and the listening PID confirmed inside the
  unit's cgroup. On any failure it stops/disables the unit, clears the serve
  mapping, deletes the just-created dir, and exits nonzero with the registry
  untouched (the flock held across the whole `add` keeps the port pair
  reserved meanwhile). After commit it also probes the tailnet HTTPS URL and
  warns (does not fail) if unreachable.
- `remove` aborts before archiving/deregistering if `systemctl disable --now`
  fails, unless `--force` is given. It archives to
  `/home/dev/services/lateshift/archive/<name>-<utc-ts>-<nanos>` (fails rather
  than overwrite an existing destination) and clears the instance's
  `tailscale serve` HTTPS mapping (numerically guarded to never touch 443).
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
