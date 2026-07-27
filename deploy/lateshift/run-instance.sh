#!/usr/bin/env bash
# LateShift Cloud instance launcher.
# Invoked by the t3code@.service systemd template as: run-instance.sh <username>
# Port configuration comes from the unit's EnvironmentFile
# (/home/dev/services/lateshift/users/<username>/instance.env), which must define:
#   T3CODE_INSTANCE_PORT  local HTTP port the server binds on 127.0.0.1
#   TS_SERVE_PORT         HTTPS port exposed on the tailnet via `tailscale serve`
# Optional (reserved for later phases):
#   T3CODE_MAX_PROJECTS   per-user project limit
set -euo pipefail

name="${1:?usage: run-instance.sh <username>}"
base_dir="/home/dev/services/lateshift/users/${name}"
server_bin="/home/dev/services/t3code-production/apps/server/dist/bin.mjs"

: "${T3CODE_INSTANCE_PORT:?T3CODE_INSTANCE_PORT missing from instance.env}"
: "${TS_SERVE_PORT:?TS_SERVE_PORT missing from instance.env}"

if [[ "${TS_SERVE_PORT}" == "443" ]]; then
    echo "refusing to start: TS_SERVE_PORT 443 is reserved for the production instance" >&2
    exit 1
fi

exec /usr/bin/node "${server_bin}" serve \
    --base-dir "${base_dir}" \
    --port "${T3CODE_INSTANCE_PORT}" \
    --tailscale-serve \
    --tailscale-serve-port "${TS_SERVE_PORT}"
