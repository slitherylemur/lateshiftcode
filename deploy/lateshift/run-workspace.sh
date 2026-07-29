#!/usr/bin/env bash
# LateShift Cloud workspace launcher.
# Invoked by the t3ws@.service systemd template as: run-workspace.sh <workspace>
#
# Successor to run-instance.sh. Differences:
#   * runs as the workspace's own UNIX account, not as `dev`
#   * binds a UNIX domain socket, not a loopback TCP port -- so there is no port
#     to normalize and no reserved-3773/443 guard to get wrong
#   * the per-workspace GitHub identity home moves under the base dir as before
#
# Config comes from the unit's EnvironmentFile
# (.../lateshift/workspaces/<workspace>/instance.env), which must define:
#   LSC_WORKSPACE          workspace id (must equal $1)
# Optional:
#   T3CODE_MAX_PROJECTS    per-workspace project limit (enforced by the patched
#                          server build; unset/0 = unlimited)
#   T3CODE_SERVER_ROOT     monorepo checkout whose apps/server/dist/bin.mjs is
#                          executed (defaults to the LateShift build checkout;
#                          workspaces must NOT run the production build, which
#                          lacks the LateShift patches)
set -euo pipefail

name="${1:?usage: run-workspace.sh <workspace>}"

# The unit template interpolates %i into User=, RuntimeDirectory= and the
# EnvironmentFile path. If the argument and the env file disagree, something has
# been hand-edited; refuse rather than serve one workspace's data as another's.
if [[ -n "${LSC_WORKSPACE:-}" && "${LSC_WORKSPACE}" != "${name}" ]]; then
    echo "refusing to start: LSC_WORKSPACE='${LSC_WORKSPACE}' does not match argument '${name}'" >&2
    exit 1
fi

[[ "${name}" =~ ^[a-z0-9-]{2,30}$ ]] || {
    echo "refusing to start: invalid workspace id '${name}'" >&2
    exit 1
}

lateshift_root="/home/dev/services/lateshift"
base_dir="${lateshift_root}/workspaces/${name}"
runtime_dir="/run/lsc/${name}"
socket_path="${runtime_dir}/http.sock"
server_root="${T3CODE_SERVER_ROOT:-${lateshift_root}/checkout}"
server_bin="${server_root}/apps/server/dist/bin.mjs"

if [[ ! -f "${server_bin}" ]]; then
    echo "refusing to start: server bundle not found at ${server_bin}" >&2
    exit 1
fi
if [[ ! -d "${base_dir}" ]]; then
    echo "refusing to start: base dir ${base_dir} not found (provision with 'lsw')" >&2
    exit 1
fi
if [[ ! -d "${runtime_dir}" ]]; then
    echo "refusing to start: ${runtime_dir} missing (RuntimeDirectory= should have created it)" >&2
    exit 1
fi

# Node's listen({path}) fails EADDRINUSE if the path already exists. systemd
# removes RuntimeDirectory on stop so this should never fire, but a crash with
# RuntimeDirectoryPreserve accidentally enabled, or a manual run, would leave a
# stale socket and wedge every restart. Unlinking is safe: we own the directory
# and nothing else may create entries in it.
if [[ -e "${socket_path}" ]]; then
    echo "removing stale socket ${socket_path}" >&2
    rm -f "${socket_path}"
fi

# --- Per-workspace GitHub identity -------------------------------------------
# Each workspace gets its OWN gh/git credential home under its base dir. The
# unit's ProtectHome=tmpfs means the host dev user's ~/.config/gh and ~/.gitconfig
# do not exist in this namespace at all, so nothing can fall back to them.
identity_dir="${base_dir}/identity"
export GH_CONFIG_DIR="${identity_dir}/gh"
export GIT_CONFIG_GLOBAL="${identity_dir}/gitconfig"

# First-run scaffolding (idempotent; owned by the workspace account).
[ -d "${identity_dir}" ] || mkdir "${identity_dir}"
[ -d "${GH_CONFIG_DIR}" ] || mkdir "${GH_CONFIG_DIR}"
chmod 700 "${identity_dir}" "${GH_CONFIG_DIR}"

if [[ ! -f "${GIT_CONFIG_GLOBAL}" ]]; then
    cat > "${GIT_CONFIG_GLOBAL}" <<EOF
[user]
	name = ${LSC_GIT_NAME:-${name}}
	email = ${LSC_GIT_EMAIL:-${name}@users.noreply.lateshiftcloud.com}
[credential "https://github.com"]
	helper =
	helper = !/usr/bin/gh auth git-credential
[credential "https://gist.github.com"]
	helper =
	helper = !/usr/bin/gh auth git-credential
EOF
    chmod 600 "${GIT_CONFIG_GLOBAL}"
fi

# Expose the per-workspace onboarding helper (lsc-github-login) on PATH for
# terminals the instance spawns. This dedicated dir holds ONLY user-facing
# tools; the admin bin/ (lsw) is deliberately NOT on PATH.
export PATH="${lateshift_root}/instance-bin:${PATH}"

# The agent CLIs key their config off $HOME. The unit sets HOME=<base>/home,
# a directory this account owns, into which the SHARED /home/dev/.claude,
# ~/.claude.json and /home/dev/.codex are bind-mounted at their conventional
# names. Set the explicit overrides too so a future HOME change cannot silently
# point them at an empty directory and trigger a re-login prompt.
: "${HOME:?run-workspace.sh requires HOME (set by t3ws@.service)}"
export CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-${HOME}/.claude}"
export CODEX_HOME="${CODEX_HOME:-${HOME}/.codex}"
if [[ ! -w "${HOME}" ]]; then
    echo "refusing to start: HOME=${HOME} is not writable by $(id -un)" >&2
    exit 1
fi

# Bind the unix socket. `--socket` wins over `--port`; no port is allocated,
# nothing listens on TCP, and the only path to this process is through Caddy,
# which is what makes the X-Lsc-User attribution header trustworthy.
exec /usr/bin/node "${server_bin}" serve \
    --base-dir "${base_dir}" \
    --socket "${socket_path}"
