#!/usr/bin/env bash
# update-from-upstream.sh — bring the LateShift fork up to date with pingdotgg/t3code
# and roll the per-user instances onto the rebuilt code. PRODUCTION IS NEVER TOUCHED.
#
# Steps:
#   1. Rebase branch lateshift-cloud onto upstream/main in /home/dev/projects/t3code.
#      On conflict the rebase is aborted and this script exits with instructions.
#   2. Sync /home/dev/services/lateshift/checkout to the rebased branch.
#   3. pnpm install + vp pack (apps/server) to rebuild dist/bin.mjs.
#   4. Restart every t3code@<user> instance (skipping budget-paused ones) and
#      health-check each on its local port.
#
# Run as dev:  bash /home/dev/services/lateshift/tools/update-from-upstream.sh
set -euo pipefail

REPO=/home/dev/projects/t3code
CHECKOUT=/home/dev/services/lateshift/checkout
REGISTRY=/home/dev/services/lateshift/users.json
UPSTREAM_URL=https://github.com/pingdotgg/t3code.git
BRANCH=lateshift-cloud

die() { echo "update-from-upstream: $*" >&2; exit 1; }

[[ "$(id -un)" == "dev" ]] || die "run as the dev user"

echo "== 1/4 rebase ${BRANCH} onto upstream/main =="
cd "${REPO}"
[[ -z "$(git status --porcelain)" ]] || die "working tree in ${REPO} is dirty; commit or stash first"
git rev-parse --verify "${BRANCH}" >/dev/null || die "branch ${BRANCH} missing"
git remote get-url upstream >/dev/null 2>&1 || git remote add upstream "${UPSTREAM_URL}"
git fetch upstream main
git checkout "${BRANCH}"
if ! git rebase upstream/main; then
    git rebase --abort
    die "rebase hit conflicts. Resolve manually: git checkout ${BRANCH} && git rebase upstream/main, fix conflicts, then re-run this script."
fi
git push --force-with-lease origin "${BRANCH}" || echo "warning: push to origin failed (continuing with local build)" >&2

echo "== 2/4 sync build checkout =="
cd "${CHECKOUT}"
git fetch origin "${BRANCH}"
git reset --hard FETCH_HEAD

echo "== 3/4 rebuild server bundle =="
corepack pnpm install --prefer-offline 2>&1 | tail -2
cd "${CHECKOUT}/apps/server"
"${CHECKOUT}/node_modules/.bin/vp" pack
[[ -f dist/bin.mjs ]] || die "build finished but dist/bin.mjs is missing"
bash /home/dev/services/lateshift/tools/apply-branding.sh "${CHECKOUT}/apps/server/dist/client" || echo "warning: branding pass failed" >&2

echo "== 4/4 restart instances =="
python3 - <<'PYEOF'
import json, os, subprocess, sys, time, urllib.request

reg = json.load(open("/home/dev/services/lateshift/users.json"))
failed = []
for name, u in sorted(reg.get("users", {}).items()):
    unit = f"t3code@{name}.service"  # template instances only, never production
    base = u.get("baseDir", "")
    if os.path.exists(os.path.join(base, "BUDGET_PAUSED")):
        print(f"{name}: budget-paused, leaving stopped")
        continue
    r = subprocess.run(["sudo", "-n", "systemctl", "restart", unit], capture_output=True, text=True)
    if r.returncode != 0:
        print(f"{name}: restart FAILED: {r.stderr.strip()}", file=sys.stderr)
        failed.append(name)
        continue
    port = int(u["localPort"])
    ok = False
    for _ in range(30):
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=3) as resp:
                if resp.status == 200:
                    ok = True
                    break
        except OSError:
            pass
        time.sleep(2)
    print(f"{name}: {'healthy' if ok else 'NOT healthy after 60s'} on 127.0.0.1:{port}")
    if not ok:
        failed.append(name)
sys.exit(1 if failed else 0)
PYEOF

echo "done. Fork updated, instances rebuilt and restarted."
