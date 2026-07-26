#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
branch="${DEPLOY_BRANCH:-main}"
remote="${DEPLOY_REMOTE:-origin}"
service_name="${T3CODE_SYSTEMD_SERVICE:-t3code}"

cd "$repo_root"

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Refusing to deploy from a dirty checkout: $repo_root" >&2
  exit 1
fi

git fetch "$remote" "$branch"
git checkout "$branch"
git pull --ff-only "$remote" "$branch"

corepack pnpm install --frozen-lockfile
corepack pnpm build

sudo systemctl restart "$service_name"
sudo systemctl --no-pager --full status "$service_name" | sed -n '1,25p'
