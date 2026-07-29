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
         --port $T3CODE_INSTANCE_PORT
  port 3780+ ->  reached only through the Caddy gateway on 127.0.0.1:8880
```

- Each user gets a fully isolated T3 base dir at
  `/home/dev/services/lateshift/users/<user>` (all state under `userdata/`).
- Local HTTP ports are allocated sequentially from **3780**. Port **3773** is
  reserved for production and is guarded against in both the launcher and the
  registry.
- LateShift makes **no** use of Tailscale. `tailscaled` still runs on the box
  for production's `tailscale serve` 443 mapping only; nothing here touches it.

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
      "baseDir": "/home/dev/services/lateshift/users/<name>",
      "projectLimit": 3,
      "admin": false,
      "githubLogin": "alice",
      "createdAt": "2026-07-27T00:00:00Z"
    }
  },
  "nextLocalPort": 3781
}
```

- `localPort` — 127.0.0.1 HTTP port the instance binds.
- `baseDir` — the instance's `--base-dir`.
- `projectLimit` — mirrored into `instance.env` as `T3CODE_MAX_PROJECTS`.
- `admin` — portal admin flag.
- `githubLogin` — the GitHub OAuth login mapped to this workspace (the sole
  identity system).
- `nextLocalPort` — allocator cursor. Allocation starts at the cursor and skips
  ports that are reserved (3773), already in registry entries, or currently
  listening (`ss -ltn`); the cursor only advances past committed ports, so
  ports of removed users are not reused. Port values are numerically
  normalized (leading zeros/`+` stripped, 1-65535 enforced) before any
  comparison or use.

## `instance.env`

Consumed by `t3code@<name>.service` via `EnvironmentFile=`:

```
T3CODE_INSTANCE_PORT=3780   # local HTTP port
T3CODE_MAX_PROJECTS=3       # per-user project limit (unset/0/invalid = unlimited)
T3CODE_SERVER_ROOT=...      # optional: override the server build checkout
LSC_USER_NAME=alice         # the user's name (written on add)
```

The CLI takes flags rather than env vars, so `run-instance.sh` translates
`T3CODE_INSTANCE_PORT` into `--port` and execs node. `t3user` rewrites
`T3CODE_MAX_PROJECTS` atomically on `set`; restart the instance to apply.

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

| Column                        | Type    | Notes                                                        |
| ----------------------------- | ------- | ------------------------------------------------------------ |
| `row_id`                      | INTEGER | primary key, autoincrement                                   |
| `event_id`                    | TEXT    | runtime event id; not null, UNIQUE (dedupes replayed events) |
| `thread_id`                   | TEXT    | not null                                                     |
| `project_id`                  | TEXT    | resolved from the thread projection; nullable                |
| `turn_id`                     | TEXT    | nullable (not every provider reports it)                     |
| `provider_name`               | TEXT    | e.g. `claude`, `codex`; nullable                             |
| `model`                       | TEXT    | comma-joined keys of the provider `modelUsage` map; nullable |
| `total_cost_usd`              | REAL    | nullable (claude reports it; codex does not)                 |
| `input_tokens`                | INTEGER | nullable, best-effort parse of provider usage                |
| `output_tokens`               | INTEGER | nullable                                                     |
| `cached_input_tokens`         | INTEGER | nullable; cache _reads_                                      |
| `cache_creation_input_tokens` | INTEGER | nullable; cache _writes_ (LateShift migration 036)           |
| `reasoning_output_tokens`     | INTEGER | nullable                                                     |
| `duration_ms`                 | INTEGER | nullable                                                     |
| `usage_json`                  | TEXT    | raw `{usage, modelUsage}` JSON from the provider; nullable   |
| `completed_at`                | TEXT    | ISO timestamp, not null; indexed                             |

Indexes: `idx_turn_usage_event_id` (UNIQUE), `idx_turn_usage_completed_at`,
`idx_turn_usage_thread_id`, `idx_turn_usage_project_id`. Inserts are
`INSERT OR IGNORE` keyed on `event_id`, so duplicate/stale completion events
never double-count. Ledger writes are fail-open: an insert failure is
logged and never breaks turn ingestion, so gaps are possible if the DB is
unhealthy.

Codex turns: upstream's `turn.completed` for Codex carries no usage at all, so
every Codex row would be all NULLs. The fork folds Codex's
`thread/tokenUsage/updated` notification into the completing turn
(`apps/server/src/lateshift/codexTurnUsage.ts`) so the token columns populate.
`total_cost_usd` stays NULL for Codex: Codex reports no dollar figure and we do
not invent one.

## Provider rate limits: `state/rate-limits/`

Two different things, deliberately never blended:

- **Pool remaining** — provider truth. What Anthropic/OpenAI say is left of the
  shared subscription.
- **Share of consumption** — our attribution, from the `turn_usage` ledger
  above. Who used it, according to us.

Pool remaining comes from the `account.rate-limits.updated` runtime event that
both adapters already emit (Claude's Agent SDK `rate_limit_event`, Codex's
`account/rateLimits/updated`); upstream has no consumer for it. The fork
normalises it in `apps/server/src/lateshift/` and writes one JSON file per
provider:

    /home/dev/services/lateshift/state/rate-limits/claude.json
    /home/dev/services/lateshift/state/rate-limits/codex.json

The directory is shared by every instance and is last-writer-wins: rate limits
describe the subscription, not the user, so every instance observes the same
facts. Storing them per-instance would mean N copies of one fact and the portal
guessing which is freshest. Create the directory once — the unit deliberately
does not:

    sudo install -d -o dev -g dev -m 0755 /home/dev/services/lateshift/state/rate-limits

Operational notes:

- Enabled only by `T3CODE_RATE_LIMIT_SNAPSHOT_DIR` in `t3code@.service`. Unset
  (desktop, upstream dev) the store is a no-op, so this cannot affect upstream.
- `ReadWritePaths=-...` in the unit is prefixed with `-` on purpose: a missing
  telemetry directory must never stop a workspace from starting. It degrades to
  a logged warning and the portal shows "unknown".
- Writes are write-tmp-then-rename, so a reader never sees a torn file.
- Window labels are the providers' own (`five_hour`, `seven_day`, `primary`,
  `secondary`). Do **not** rename them in any UI: both providers' reset
  behaviour is inconsistent with their own labels. `resetsAt` is stored raw
  alongside a best-effort ISO rendering.
- Nothing is ever extrapolated. A window not reported in the last hour renders
  as "unknown", never as a stale percentage.
- Any dollar figure in the portal is an API-equivalent estimate and is labelled
  as such. It is never spend against a cap; the subscription is a flat fee.

## `/home/dev/shared`

`/home/dev/shared/` still holds the collaboration repos that were placed there
under the previous design, but **there is no sharing mechanism in this tree
any more**: the `sharedProjects` registry grants, `t3user share/unshare`, the
shared owner-identity git config, the shared PAT at `.lsc-git-credentials` and
the portal's share manager are all deleted, and `/home/dev/shared` is no longer
a `ReadWritePaths` carve-out in the instance sandbox. Shared workspaces are
re-introduced by W6 (see `docs/architecture-v2.md` §5) as per-project UNIX
accounts and groups. The data under `/home/dev/shared` was left untouched.

## Sandbox

Worker instances run as the `dev` user and spawn agent CLIs (`claude`,
`codex`) that historically had passwordless `sudo` and full write access to the
box. The `t3code@.service` **template** is hardened with systemd sandboxing so
an instance — and every process it spawns — is confined to its own area. The
production `t3code.service` is a separate unit and is **not** affected.

### What is blocked (verified)

| Attempt                                           | Result  | Mechanism                                                                          |
| ------------------------------------------------- | ------- | ---------------------------------------------------------------------------------- |
| `sudo` / any setuid escalation                    | blocked | `NoNewPrivileges=yes`                                                              |
| write to `/etc`                                   | EROFS   | `ProtectSystem=strict`                                                             |
| write to `/home/dev/projects`, other users' data  | EROFS   | `ProtectSystem=strict` + `ProtectHome=read-only`                                   |
| write to `/home/dev/services/t3code-production`   | EROFS   | `ProtectSystem=strict`                                                             |
| read host `dev` GitHub token / gitconfig          | EACCES  | `InaccessiblePaths=/home/dev/.config/gh`, `InaccessiblePaths=/home/dev/.gitconfig` |
| mount / new user namespace / kernel module load   | EPERM   | `RestrictNamespaces`, `SystemCallFilter=@system-service`, `ProtectKernelModules`   |
| clock / hostname / cgroup / kernel-tunable writes | blocked | `ProtectClock`, `ProtectHostname`, `ProtectControlGroups`, `ProtectKernelTunables` |

### What is allowed (writable carve-outs)

- `/home/dev/services/lateshift/users/%i` — the instance's own base dir (all
  its state: `userdata`, `projects`, `worktrees`, `caches`).
- `/home/dev/.claude`, `/home/dev/.claude.json`, `/home/dev/.codex`,
  `/home/dev/.cache` — agent credential/state dirs (see tradeoffs).
- Network is unrestricted; `/tmp` and `/var/tmp` are private per instance
  (`PrivateTmp=yes`).

Everything else on the box is **readable but read-only**. Resource caps
(`MemoryHigh`/`MemoryMax`/`CPUQuota`/`TasksMax`) are unchanged. `node`'s JIT
needs W^X memory, so `MemoryDenyWriteExecute` is deliberately **not** set.

### Credential exposure — tradeoffs

All instances currently share **one** `dev`-level identity for each external
service; the sandbox protects the _box_, not these shared secrets from an agent
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
- **GitHub auth is now per-instance** (no longer shared). The host `dev`
  user's `~/.config/gh` and `~/.gitconfig` are made **inaccessible** inside the
  sandbox (`InaccessiblePaths` in the unit), and `run-instance.sh` points
  `GH_CONFIG_DIR` and `GIT_CONFIG_GLOBAL` at `<base>/identity/{gh,gitconfig}`
  (mode 700/600, under the instance's own writable base dir). Each workspace
  therefore holds its **own** `gh` OAuth token and git author identity; one
  instance can neither read nor push as another, and none can reach
  `slitherylemur`'s credentials. Users onboard by running `lsc-github-login`
  once (see **Per-workspace GitHub onboarding** below). Commits are authored as
  the user's real GitHub account via its `ID+login@users.noreply.github.com`
  no-reply email. The Claude/Codex tradeoff above still applies to those
  services; only GitHub is per-user today.

### Per-workspace GitHub onboarding

Each workspace uses its **own** GitHub account. To connect one, open a terminal
in the T3 workspace and run **once**:

```sh
lsc-github-login
```

It runs GitHub's device/web sign-in (`gh auth login -h github.com -p https -w`)
— a one-time code you paste at <https://github.com/login/device> — then
`gh auth setup-git`, then stamps your GitHub name + no-reply email into the
workspace's git author identity. After that, `git clone`/`push` and the `gh`
CLI work against your own repos, and commits are authored as you. The helper is
exposed on every instance's `PATH` from
`/home/dev/services/lateshift/instance-bin/` (a dedicated dir holding only
user-facing tools; the admin `bin/` with `t3user` is **not** on the instance
PATH).

> **Migration caveat (one-time).** The previous shared `slitherylemur` identity
> is gone: after this change, **existing instances (`slither`, `testuser`) can
> no longer push to GitHub until their user runs `lsc-github-login`.** This is
> intentional — `dev`'s token is deliberately **not** copied into any instance.
> Until a workspace authenticates, `gh auth status` inside it reports "not
> logged in" and authenticated git operations fail; public `git clone` still
> works unauthenticated.

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
t3user add <name> [--project-limit N] [--admin]
                                                 # provision + enable + start + health-wait
t3user remove <name> [--force]                   # stop+disable unit, archive base dir (no rm -rf of live data)
t3user list                                      # table of registered users
t3user set <name> <key> <value>                  # update a registry field (see below)
t3user pair <name> [--ttl 1h]                    # one-time pairing URL for the instance (admin/debug only)
```

`set` keys: `projectLimit`, `admin`, `githubLogin`. `projectLimit` rewrites
`instance.env` atomically; restart the instance to apply.

- Names must match `[a-z0-9-]{2,20}`; `add` refuses existing users; extra
  positional arguments are rejected on every subcommand.
- `add` only commits to `users.json` after the instance is healthy: unit
  `is-active`, local HTTP 200, and the listening PID confirmed inside the
  unit's cgroup. On any failure it stops/disables the unit, deletes the
  just-created dir, and exits nonzero with the registry untouched (the flock
  held across the whole `add` keeps the port reserved meanwhile).
- `remove` aborts before archiving/deregistering if `systemctl disable --now`
  fails, unless `--force` is given. It archives to
  `/home/dev/services/lateshift/archive/<name>-<utc-ts>-<nanos>` (fails rather
  than overwrite an existing destination).
- `pair` uses `t3 auth pairing create` with
  `--base-url https://<name>.lateshiftcloud.com`. Pairing is no longer part of
  any user-facing flow — sign-in is GitHub OAuth through the portal.

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
