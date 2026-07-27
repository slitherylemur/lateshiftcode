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
      "tsLogin": "alice@github",
      "monthlyBudgetUsd": 0,
      "providerBudgets": { "claude": 20, "codex": { "monthly": 30, "fiveHour": 8 } },
      "sharedProjects": ["/home/dev/shared/demo-shared"],
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
- `projectLimit` — mirrored into `instance.env` as `T3CODE_MAX_PROJECTS`.
- `sharedAccess` — reserved: whether the user can see shared Roblox project dirs.
- `admin` — portal admin flag.
- `tsLogin` — tailnet identity mapped to this instance (unique across users).
- `monthlyBudgetUsd` — total monthly USD cap enforced by `bin/budget-check`
  (0 = unlimited; see "Budgets" below). Mirrored to `instance.env` as
  `LSC_LIMIT_TOTAL_USD`.
- `providerBudgets` — per-provider USD caps (see "Budgets"). Each provider
  value is **either** a number (monthly cap, legacy shape) **or**
  `{ "monthly": X, "fiveHour": Y }`. Absent/0 = unlimited. Mirrored to
  `instance.env` as `LSC_LIMIT_{CLAUDE,CODEX}_USD` and `LSC_LIMIT_{CLAUDE,CODEX}_5H_USD`.
- `sharedProjects` — absolute paths granted to this user via `t3user share`
  (registered as projects on the user's own instance).
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
# Budget limits (USD; 0 = unlimited). Written by t3user on add and on any
# budget `set`; the patched fork reads them for per-provider enforcement.
LSC_USER_NAME=alice         # the user's name (always written)
LSC_LIMIT_TOTAL_USD=0       # = monthlyBudgetUsd (always written)
LSC_LIMIT_CLAUDE_USD=0      # claude monthly cap
LSC_LIMIT_CODEX_USD=0       # codex monthly cap
LSC_LIMIT_CLAUDE_5H_USD=0   # claude 5-hour rolling-window cap
LSC_LIMIT_CODEX_5H_USD=0    # codex 5-hour rolling-window cap
```

The CLI takes flags rather than env vars, so `run-instance.sh` translates the
port/limit vars into `--port` / `--tailscale-serve-port` and execs node. The
`LSC_*` budget vars are consumed by the patched fork (not by `run-instance.sh`).
`t3user` rewrites only the `LSC_*` block (and, separately, `T3CODE_MAX_PROJECTS`)
atomically; restart the instance to apply changes.

## Server build (patched fork)

User instances run the **LateShift build**, not the production bundle:
`run-instance.sh` execs `${T3CODE_SERVER_ROOT:-/home/dev/services/lateshift/checkout}/apps/server/dist/bin.mjs`.
The checkout tracks branch `lateshift-cloud` and carries two patches on top of
the production server:

1. **Project limit** — `T3CODE_MAX_PROJECTS` is read by the orchestration
   decider on every `project.create` command; once the count of live
   (non-deleted) projects reaches the limit, the command is rejected with
   `Project limit reached (N). Ask your admin to raise it.` (surfaced as a
   normal command error in the UI). The value must be a plain positive
   decimal integer; anything else (unset, empty, `0`, negative, `1.5`,
   `2junk`, `1e2`, ...) means unlimited. Restart the instance after changing
   it.
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
| `event_id`                | TEXT    | runtime event id; not null, UNIQUE (dedupes replayed events) |
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

Indexes: `idx_turn_usage_event_id` (UNIQUE), `idx_turn_usage_completed_at`,
`idx_turn_usage_thread_id`, `idx_turn_usage_project_id`. Inserts are
`INSERT OR IGNORE` keyed on `event_id`, so duplicate/stale completion events
never double-count. Ledger writes are fail-open: an insert failure is
logged and never breaks turn ingestion, so gaps are possible if the DB is
unhealthy.

## Shared projects

`/home/dev/shared/` is the single **share root** — the one place shared
collaboration project dirs live (it is a writable carve-out inside every
instance's sandbox). `t3user share <name> <abs-path>` grants a directory to a
user by running `t3 project add <path> --base-dir <their base dir>` on their own
instance and recording the grant in `sharedProjects`; `unshare` reverses it.
Grants are **per-user** — sharing a dir with one user never exposes it to
another. Paths must resolve (via `realpath`) under `/home/dev/shared/` or
`/home/dev/projects/`.

Notable contents:

- `/home/dev/shared/skyjourney-cloud` — relocated here from
  `/home/dev/projects/`; still a normal git repo (remote
  `github.com/slitherylemur/skyjourney-cloud`). Its production registration was
  re-pointed to this path via `t3 project add`/`delete`. Granted to `slither`
  only.
- `/home/dev/shared/demo-shared` — demo shared dir.

The admin's personal scratch area is simply their own instance's default
project area (nothing extra is provisioned for it).

## Budgets

Two independent budget mechanisms:

1. **Total monthly cap** (`monthlyBudgetUsd`) — enforced by `bin/budget-check`
   (runs every 10 min from `lateshift-budget.timer`). Over budget → the whole
   instance is **paused** (`systemctl stop` + a `BUDGET_PAUSED` marker); back
   under budget → resumed. This is a hard stop of the instance and is unchanged
   by the per-provider work below.
2. **Per-provider caps** (`providerBudgets`) — a monthly cap and/or a 5-hour
   rolling-window cap per provider (`claude`, `codex`). These are **enforced
   inside the patched fork**, not by stopping the instance (the underlying
   subscriptions throttle in 5-hour windows, so a soft per-provider cap is more
   useful than a box-wide pause). `budget-check` never reads these.

`t3user` mirrors every budget value into the user's `instance.env` on `add` and
on any budget `set`, then you restart the instance to apply:

| instance.env var          | source                                    |
| ------------------------- | ----------------------------------------- |
| `LSC_USER_NAME`           | the user name (always)                    |
| `LSC_LIMIT_TOTAL_USD`     | `monthlyBudgetUsd` (always)               |
| `LSC_LIMIT_CLAUDE_USD`    | `providerBudgets.claude` monthly          |
| `LSC_LIMIT_CODEX_USD`     | `providerBudgets.codex` monthly           |
| `LSC_LIMIT_CLAUDE_5H_USD` | `providerBudgets.claude` fiveHour         |
| `LSC_LIMIT_CODEX_5H_USD`  | `providerBudgets.codex` fiveHour          |

All values are USD; `0` (or absent) means unlimited.

### Setting per-provider budgets

The registry value for a provider is **either** a bare number (monthly cap,
backward-compatible shape) **or** an object `{"monthly": X, "fiveHour": Y}`.
`t3user set` accepts all of these paths (validated in the CLI):

```sh
t3user set alice providerBudgets.claude 20             # claude monthly = $20
t3user set alice providerBudgets.claude.monthly 20     # same, explicit
t3user set alice providerBudgets.claude.fiveHour 5     # claude 5-hour window = $5
t3user set alice providerBudgets.codex '{"monthly":30,"fiveHour":8}'
t3user set alice providerBudgets '{"claude":20,"codex":{"monthly":30,"fiveHour":8}}'
```

- Providers are limited to `claude` and `codex`; sub-fields to `monthly` /
  `fiveHour`; amounts to `0`-`100000`. A provider whose `fiveHour` is `0`
  stores as the compact bare-number form (so the legacy shape round-trips).
- Each accepted `set` rewrites the `LSC_*` block in `instance.env`; **restart
  the instance** (`sudo systemctl restart t3code@<name>`) to apply.

## Sandbox

Worker instances run as the `dev` user and spawn agent CLIs (`claude`,
`codex`) that historically had passwordless `sudo` and full write access to the
box. The `t3code@.service` **template** is hardened with systemd sandboxing so
an instance — and every process it spawns — is confined to its own area. The
production `t3code.service` is a separate unit and is **not** affected.

### What is blocked (verified)

| Attempt                                             | Result   | Mechanism                         |
| --------------------------------------------------- | -------- | --------------------------------- |
| `sudo` / any setuid escalation                      | blocked  | `NoNewPrivileges=yes`             |
| write to `/etc`                                     | EROFS    | `ProtectSystem=strict`            |
| write to `/home/dev/projects`, other users' data    | EROFS    | `ProtectSystem=strict` + `ProtectHome=read-only` |
| write to `/home/dev/services/t3code-production`     | EROFS    | `ProtectSystem=strict`            |
| mount / new user namespace / kernel module load     | EPERM    | `RestrictNamespaces`, `SystemCallFilter=@system-service`, `ProtectKernelModules` |
| clock / hostname / cgroup / kernel-tunable writes   | blocked  | `ProtectClock`, `ProtectHostname`, `ProtectControlGroups`, `ProtectKernelTunables` |

### What is allowed (writable carve-outs)

- `/home/dev/services/lateshift/users/%i` — the instance's own base dir (all
  its state: `userdata`, `projects`, `worktrees`, `caches`).
- `/home/dev/shared` — the shared collaboration root.
- `/home/dev/.claude`, `/home/dev/.claude.json`, `/home/dev/.codex`,
  `/home/dev/.cache` — agent credential/state dirs (see tradeoffs).
- `/run/tailscale` — so the server can (re)configure `tailscale serve`.
- Network is unrestricted; `/tmp` and `/var/tmp` are private per instance
  (`PrivateTmp=yes`).

Everything else on the box is **readable but read-only**. Resource caps
(`MemoryHigh`/`MemoryMax`/`CPUQuota`/`TasksMax`) are unchanged. `node`'s JIT
needs W^X memory, so `MemoryDenyWriteExecute` is deliberately **not** set.

### Credential exposure — tradeoffs

All instances currently share **one** `dev`-level identity for each external
service; the sandbox protects the *box*, not these shared secrets from an agent
that is already using them:

- **Claude / Codex auth** (`~/.claude`, `~/.codex`) is exposed **read-write**,
  not read-only, because the CLIs write sessions/caches and refresh OAuth
  tokens in place — a read-only mount would break token refresh for a
  long-lived service. Consequence: an in-instance agent can read (and rewrite)
  the shared subscription credentials, and one instance's token refresh is
  visible to all. Acceptable today because every instance already bills the
  same Claude Max / ChatGPT subscription. `HOME` is left as `/home/dev` and the
  config dirs are **not** remapped (via `CLAUDE_CONFIG_DIR`/`CODEX_HOME`),
  because per-instance copies of a single upstream account would fight over
  refresh-token rotation. Recommended future hardening: per-user provider
  tokens, each bind-mounted read-only into a per-instance config dir.
- **GitHub auth** flows through the shared `gh` token via the git credential
  helper (`gh auth git-credential`). `~/.config/gh` and `~/.gitconfig` are
  exposed **read-only** (readable, not writable), so git pushes succeed as
  `slitherylemur` but the token can't be rewritten. An agent can still read the
  token and push as that identity to any repo the account can reach — the
  chosen tradeoff over provisioning per-user tokens (deferred). Instances push
  "as themselves" only in the sense that they all share this one identity.

### Verifying the sandbox

```sh
# Applied settings on a live instance:
systemctl show t3code@<name> -p NoNewPrivileges -p ProtectSystem -p ReadWritePaths

# Filesystem blocks, inside the running instance's mount namespace:
PID=$(systemctl show -p MainPID --value t3code@<name>)
sudo nsenter -t "$PID" -m -p -- sh -c 'echo x > /etc/probe; echo x > /home/dev/projects/probe'

# sudo block (mirror the unit's key credential):
systemd-run --uid=dev -p NoNewPrivileges=yes --pipe --wait /bin/sh -c 'sudo -n id'
```

## Headless test client

`tools/t3client.mjs` is a dependency-free Node client used to smoke-test
instances end to end (pairing-token exchange → wsTicket → WebSocket RPC). See
`node tools/t3client.mjs --help`; pairing tokens are one-time, mint with
`t3user pair <name>`.

## `t3user` CLI

```
t3user add <name> [--project-limit N] [--admin] [--ts-login LOGIN]
                                                 # provision + enable + start + health-wait
t3user remove <name> [--force]                   # stop+disable unit, archive base dir (no rm -rf of live data)
t3user list                                      # table of registered users
t3user set <name> <key> <value>                  # update a registry field (see below)
t3user share <name> <abs-path>                   # grant a shared project dir (t3 project add on their instance)
t3user unshare <name> <abs-path>                 # revoke a shared project dir
t3user pair <name> [--ttl 1h]                    # one-time pairing URL for the instance
```

`set` keys: `projectLimit`, `sharedAccess`, `admin`, `tsLogin`,
`monthlyBudgetUsd`, and `providerBudgets[.<provider>[.monthly|.fiveHour]]`
(see "Budgets"). `projectLimit` and any budget key rewrite `instance.env`
atomically; restart the instance to apply.

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
