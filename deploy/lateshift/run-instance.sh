#!/usr/bin/env bash
# LateShift Cloud instance launcher.
# Invoked by the t3code@.service systemd template as: run-instance.sh <username>
# Port configuration comes from the unit's EnvironmentFile
# (/home/dev/services/lateshift/users/<username>/instance.env), which must define:
#   T3CODE_INSTANCE_PORT  local HTTP port the server binds on 127.0.0.1
#   TS_SERVE_PORT         HTTPS port exposed on the tailnet via `tailscale serve`
# Optional:
#   T3CODE_MAX_PROJECTS   per-user project limit (enforced by the patched
#                         server build; unset/0 = unlimited)
#   T3CODE_SERVER_ROOT    monorepo checkout whose apps/server/dist/bin.mjs is
#                         executed (defaults to the LateShift build checkout;
#                         user instances must NOT run the production build,
#                         which lacks the LateShift patches)
set -euo pipefail

name="${1:?usage: run-instance.sh <username>}"
base_dir="/home/dev/services/lateshift/users/${name}"
server_root="${T3CODE_SERVER_ROOT:-/home/dev/services/lateshift/checkout}"
server_bin="${server_root}/apps/server/dist/bin.mjs"

if [[ ! -f "${server_bin}" ]]; then
    echo "refusing to start: server bundle not found at ${server_bin}" >&2
    exit 1
fi

# Normalize a port to a canonical decimal integer: strips one leading '+' and
# leading zeros, requires digits only, range 1-65535. Prints the normalized
# value; fails otherwise. All comparisons below use the normalized value so
# strings like "0443" or "+443" cannot slip past the reserved-port guards.
normalize_port() {
    local raw="$1" v
    v="${raw#+}"                            # strip a single leading '+'
    [[ "${v}" =~ ^[0-9]+$ ]] || { echo "invalid port '${raw}': not a positive integer" >&2; return 1; }
    v=$((10#${v}))                          # force base-10, strips leading zeros
    (( v >= 1 && v <= 65535 )) || { echo "invalid port '${raw}': out of range 1-65535" >&2; return 1; }
    echo "${v}"
}

: "${T3CODE_INSTANCE_PORT:?T3CODE_INSTANCE_PORT missing from instance.env}"
: "${TS_SERVE_PORT:?TS_SERVE_PORT missing from instance.env}"

local_port=$(normalize_port "${T3CODE_INSTANCE_PORT}") || exit 1
ts_port=$(normalize_port "${TS_SERVE_PORT}") || exit 1

if (( ts_port == 443 )); then
    echo "refusing to start: TS_SERVE_PORT 443 is reserved for the production instance" >&2
    exit 1
fi
if (( local_port == 3773 )); then
    echo "refusing to start: local port 3773 is reserved for the production instance" >&2
    exit 1
fi

exec /usr/bin/node "${server_bin}" serve \
    --base-dir "${base_dir}" \
    --port "${local_port}" \
    --tailscale-serve \
    --tailscale-serve-port "${ts_port}"
