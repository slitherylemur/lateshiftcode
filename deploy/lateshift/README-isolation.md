# W5 — Provisioning and per-workspace isolation (architecture-v2 §3, §5)

This is the v2 isolation model. It **replaces** `t3user`, `run-instance.sh` and
`t3code@.service`, all three of which are deleted on this branch. `README.md` in
this directory still describes the v1 stack for the cutover window; treat
anything it says about **local port allocation** as gone.

## What changed, in one paragraph

Every instance used to run as the single UNIX account `dev`, listening on an
allocated loopback port, with `/home/dev` readable and a shared writable
carve-out. A "share" was therefore a UI listing filter, not access control: any
instance could read and write any other's data because they were all the same
uid. Now each workspace is its own UNIX account, its base dir is `0750` owned by
that account, and it listens on a UNIX socket in a directory only Caddy's group
can traverse. Isolation is kernel-enforced.

## Files

| File | Installs to | Purpose |
| --- | --- | --- |
| `lsw` | `/home/dev/services/lateshift/bin/lsw` | provisioning CLI (registry + accounts + units) |
| `t3ws@.service` | `/etc/systemd/system/t3ws@.service` | per-workspace unit template |
| `run-workspace.sh` | `/home/dev/services/lateshift/bin/run-workspace.sh` | launcher (`ExecStart`) |
| `tmpfiles-lsc.conf` | `/etc/tmpfiles.d/lsc.conf` | pre-creates `/run/lsc` root-owned |

W8 owns installation. Nothing here has been installed or started.

## Identities

| Thing | Personal workspace | Team workspace |
| --- | --- | --- |
| workspace id (`%i`) | `u-<login>` | `t-<project>` |
| UNIX account | `u-<login>` | `t-<project>` |
| primary group | same as account | same as account |
| members group | (none, single user) | `w-t-<project>` |
| base dir | `workspaces/u-<login>` | `workspaces/t-<project>` |
| socket | `/run/lsc/u-<login>/http.sock` | `/run/lsc/t-<project>/http.sock` |
| unit | `t3ws@u-<login>.service` | `t3ws@t-<project>.service` |

GitHub logins may be 39 characters but `useradd` caps names at 32, so
`unix_user_for_login()` truncates to 21 characters and appends 6 hex characters
of `sha256(login)`. Two logins sharing a long prefix therefore still get
different accounts. The slug is stored in the registry and never shown to users.

## Filesystem layout and modes

```
workspaces/<ws>/            0750 <ws>:dev      base dir; dev = the portal, which
                                               reads state.sqlite for usage
workspaces/<ws>/home/       0700 <ws>:<ws>     $HOME (agent CLIs write temp files here)
        home/.claude        bind mount <- /home/dev/.claude      (SHARED, rw)
        home/.claude.json   bind mount <- /home/dev/.claude.json (SHARED, rw)
        home/.codex         bind mount <- /home/dev/.codex       (SHARED, rw)
        home/.cache         per-workspace, NOT shared
workspaces/<ws>/identity/   0700 <ws>:<ws>     gh config + gitconfig for this workspace
workspaces/<ws>/userdata/   0750 <ws>:dev      threads, state.sqlite
workspaces/<ws>/projects/   2750 <ws>:w-t-<p>  team only: the shared surface
workspaces/<ws>/instance.env 0640 root:<ws>    read by the unit; instance cannot
                                               rewrite its own project limit
/run/lsc                    0755 root:root     tmpfiles; MUST NOT be workspace-owned
/run/lsc/<ws>               0750 <ws>:caddy    RuntimeDirectory
/run/lsc/<ws>/http.sock     created by node    reachable only via the caddy group
```

For a team, `projects/` is group `w-t-<project>` setgid, but `userdata/` and
`identity/` are not: a member reaches team threads by connecting to the team
INSTANCE through the gateway, never by reading the DB from their own instance.
That keeps the team's PAT and thread DB out of every member's reach.

## Transport (W0-A held)

The server binds a UNIX socket; **nothing listens on TCP**. Two non-obvious
points, both from spike W0-A:

1. **Never gate on the socket's own mode.** Node creates the socket with a
   umask-derived mode (`0775` was observed), so between `listen()` and any
   `chmod` it is world-connectable. The gate is the **directory**: `0750`
   `<ws>:caddy`, set by `RuntimeDirectory=` plus two `+`-prefixed
   `ExecStartPre=` lines that fix the group to `caddy`.
2. **`/run/lsc` must pre-exist root-owned.** If systemd creates it as part of
   `RuntimeDirectory=lsc/<ws>`, it is owned by the first workspace to start,
   which could then create `/run/lsc/<other>/http.sock` and impersonate another
   workspace to the gateway. `tmpfiles-lsc.conf` closes this.

Stale sockets: `RuntimeDirectory=` is removed on stop, and `run-workspace.sh`
unlinks defensively, because `listen({path})` fails `EADDRINUSE` if the path
exists.

Server-side the change is `--socket` / `T3CODE_SOCKET`
(`apps/server/src/config.ts`, `cli/config.ts`, `server.ts`). `--port` still works
and is unchanged for desktop and dev use; `--socket` simply wins. When a socket
is set, the free-port probe is skipped entirely.

**Derived value fixed here:** the session cookie name used to be keyed on the
listening port (`auth/utils.ts`). Under single-origin there is no port and every
workspace shares one cookie jar, so it is now keyed on the socket basename, i.e.
the workspace id.

**Known gap, not fixed here:** `server.ts` does not write `serverRuntimeState`
when the address is a UNIX address (it early-returns on non-`port` addresses).
Nothing under `deploy/` reads that file (grepped), but the check was limited to
this repo -- whoever owns the portal/ops broker should confirm for the installed
tree too.

## The credential limit — READ THIS

`SupplementaryGroups=lsc-agents`, and `/home/dev/.claude`, `~/.claude.json` and
`/home/dev/.codex` are `lsc-agents`-group **writable** by every workspace,
because the CLIs refresh OAuth tokens in place and a read-only mount breaks
refresh.

**Credential isolation is therefore NOT achieved.** Any agent in any workspace
can read the shared Claude/Codex subscription token, because it must be able to
use it. What per-workspace accounts buy is **box isolation**: workspace A cannot
read workspace B's code, threads, DB, or GitHub token. This is the known,
accepted limit recorded as architecture-v2 R3. It is the single largest residual
risk in this design and it is not closable without per-user subscriptions.

## What is genuinely isolated now

- Another workspace's base dir: `0750` and a different uid — EACCES.
- `/home/dev/projects`, `~/.config/gh`, `~/.gitconfig`, `~/.ssh`: absent from
  the namespace entirely (`ProtectHome=tmpfs` plus an allowlist of `BindPaths`),
  not merely denied. The v1 unit used `ProtectHome=read-only` plus
  `InaccessiblePaths=`, i.e. a denylist over a readable `/home/dev`; the
  `InaccessiblePaths=` lines are kept only as defence against a future careless
  `BindPaths=`.
- The npm/pnpm/uv cache. v1 shared one writable `/home/dev/.cache` across every
  instance, which is a cross-workspace code-execution path (poison a cached
  package in A, get executed in B). Each workspace now has its own.
- Another workspace's socket: `/run/lsc/<other>` is `0750 <other>:caddy` and no
  workspace account is in the `caddy` group.

## Hardening properties

Every property from `t3code@.service` is carried over unchanged:
`NoNewPrivileges`, `ProtectSystem=strict`, `PrivateTmp`, `RestrictNamespaces`,
`SystemCallFilter=@system-service` plus `SystemCallErrorNumber=EPERM` plus
`SystemCallArchitectures=native`, the whole `Protect*` family,
`RestrictSUIDSGID`, `RestrictRealtime`, `LockPersonality`, `MemoryHigh=1G`,
`MemoryMax=1536M`, `CPUQuota=150%`, `TasksMax=512`, `RemoveIPC=no`,
`SuccessExitStatus=130`. `MemoryDenyWriteExecute` stays **off** — node's JIT
needs W^X-writable memory. Two changes only: `ProtectHome` goes
`read-only` -> `tmpfs`, and `ReadWritePaths=` becomes `BindPaths=` (required,
because with a tmpfs `/home` there is nothing to make writable — the paths have
to be mounted in).

## `lsw`

Renamed from `t3user` because it no longer provisions *users* — it provisions
*workspaces*, of which users are one input — and because the two tools had to
coexist on the box during the cutover window without either shadowing the other.

```
lsw init                                   shared groups + dirs (idempotent)
lsw migrate [--from PATH]                  seed registry.json from legacy users.json
lsw list
lsw user add <github-login> [--project-limit N] [--admin]
lsw user remove <github-login> [--force]
lsw team add <project> [--project-limit N] [--member LOGIN]...
lsw team remove <project> [--force]
lsw member add|remove <project> <github-login>
lsw set <github-login> projectLimit|admin|status <value>
```

Every subcommand takes `--dry-run`, which prints the exact privileged commands
and writes nothing. `LSW_ROOT` / `LSW_RUNTIME_ROOT` retarget it at a scratch
tree for testing.

Discipline carried over from `t3user`, deliberately:

- **Exclusive `flock`** on `.registry-v2.lock` for the whole command.
- **Crash-safe registry writes**: temp file in the same directory, `fsync`,
  atomic `rename`, then `fsync` of the directory.
- **Registry commit is last.** Accounts, dirs and the unit are created first and
  the instance must reach health (HTTP 200 over its own socket *and* the unit
  `active`); only then is the registry written. Any failure runs
  `rollback_provision`, which unwinds only what this invocation created.
- **Archive, never `rm -rf`** on removal: the base dir is `mv`d to
  `archive/<ws>-<utc>-<ns>` and `chown`ed to `root:dev` *before* the account is
  deleted — otherwise the archive is left owned by a dangling uid that a future
  `useradd` could reuse, silently handing a new workspace read access to a
  removed one's data.
- **Name validation** for both GitHub logins and project names, with a reserved
  list.

New: `verify_socket_ownership()` replaces v1's `verify_unit_owns_port()`. The
port question ("is the thing answering here really our unit?") becomes a
filesystem question: the socket is a socket, in the workspace's own runtime dir,
owned by the workspace account, the dir is `0750 <ws>:caddy`, and the unit's
main PID is live in `system.slice/system-t3ws.slice/t3ws@<ws>.service`.

New: `assert_membership_consistent()`. Membership has three representations:
registry, UNIX group, and the instance's project list. v1 had two unreconciled
sources of truth and an unshare path that cleared the grant even when the
instance operation failed. `lsw member` refuses to act unless the two
representations it owns already agree, changes both with rollback on either
failure, then re-verifies. It does **not** yet reconcile the instance-side
project list (W6-B) and prints exactly what remains manual, including that a
supplementary-group change only affects processes started after it, so the team
unit must be restarted.

## Migration from `users.json`

`lsw migrate` is **read-only against `users.json`** — the shadow stack is seeded
from the live registry, never migrated in place. Per legacy user it provisions a
personal workspace with the same `projectLimit` and `admin` flag. Three things
it deliberately cannot carry over, each reported rather than silently dropped:

- **Share grants** -> a share is now a team workspace, born empty and cloned
  fresh from GitHub (architecture-v2 D9). There is no promotion path from a
  personal workspace's checkout, so these must be recreated deliberately with
  `lsw team add <project> --member <login>`.
- **Budgets** -> deleted (D5).
- **Users with no `githubLogin`** (e.g. the `testuser` canary) -> provisioned
  under a placeholder and loudly flagged, because the new model keys everything
  on the GitHub login and one cannot be invented.
