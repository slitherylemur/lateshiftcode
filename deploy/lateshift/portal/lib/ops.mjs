// ops.mjs — the guarded "ops broker": lets the admin's sandboxed T3 workspace
// modify and redeploy the LateShift Cloud system it runs inside, WITHOUT ever
// being able to touch production (t3code.service / port 3773 / 443 / cloudflared).
//
// Reached only over loopback at POST /internal/ops/<action> (see server.mjs).
// Auth is a bearer secret in the `X-Ops-Token` header, constant-time compared
// against the portal-readable copy at secrets/ops-token (the sandbox cannot
// read that copy — InaccessiblePaths=…/secrets — only its own identity copy).
// Requests bearing X-Forwarded-Host are rejected: the public gateway can never
// reach this endpoint.
//
// SAFETY MODEL (defense in depth):
//   - assertOpsUnit(): systemctl/journalctl only ever see t3code@<name> template
//     instances or the small whitelist below. The bare production unit
//     `t3code`/`t3code.service` can never be named — same posture as
//     lib/actions.mjs assertSafeUnit(), but stricter (production is not even a
//     restartable target here; it is exposed ONLY as a read-only health bit).
//   - execFile-only (argv arrays, never shell strings); every user value is
//     validated before it reaches an argv.
//   - Secrets are never logged; the ops-token never appears in the audit log.

import { execFile } from "node:child_process";
import { readFileSync, appendFileSync, existsSync } from "node:fs";
import crypto from "node:crypto";
import http from "node:http";

import { loadRegistry, NAME_RE } from "./registry.mjs";

// ---------------------------------------------------------------- constants

const LSC_ROOT = "/home/dev/services/lateshift";
const CHECKOUT = `${LSC_ROOT}/checkout`;
const SECRETS_TOKEN = `${LSC_ROOT}/secrets/ops-token`;
const AUDIT_LOG = `${LSC_ROOT}/ops-audit.log`;
const BRANDING = `${LSC_ROOT}/tools/apply-branding.sh`;

const INFRA_REPO = "/home/dev/projects/t3code";
const INFRA_BRANCH = "lateshift-cloud";
// deploy-portal source: the lateshift-cloud working copy of the portal.
const PORTAL_SRC = `${INFRA_REPO}/deploy/lateshift/portal`;
const PORTAL_DST = `${LSC_ROOT}/portal`;

// The calling workspace owner. A restart of this instance would kill the very
// turn issuing it, so it must be scheduled (delaySeconds), never immediate.
const SELF_NAME = "slither";

// Never restartable, never log-readable through this broker.
const PRODUCTION_UNITS = new Set(["t3code", "t3code.service"]);

// Branch names accepted by rebuild-checkout / self-restart guards.
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,80}$/;

// journalctl whitelist: t3code@<name> instances + these fixed units. The
// production unit t3code.service is deliberately ABSENT and also blocked by
// PRODUCTION_UNITS below.
const LOG_UNIT_RE =
  /^(?:t3code@[a-z0-9-]{2,20}|lateshift-portal|caddy)\.service$/;

// ---------------------------------------------------------------- shell-out

function run(file, args, { timeoutMs = 120_000, cwd, env, maxBuffer = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    const options = { timeout: timeoutMs, maxBuffer };
    if (cwd) options.cwd = cwd;
    if (env) options.env = env;
    execFile(file, args, options, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: error ? (error.code ?? 1) : 0,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
      });
    });
  });
}

/** Last N chars of combined stdout/stderr — for staged/collected output. */
function tail(r, n = 4000) {
  return `${r.stdout}${r.stderr ? `\n${r.stderr}` : ""}`.slice(-n);
}

// PATH for the isolated build stages (mirrors the dev login shell).
const DEV_PATH = "/home/dev/.rokit/bin:/home/dev/.local/bin:/usr/local/bin:/usr/bin:/bin";

/**
 * Run ONE heavy build stage in a transient systemd unit as dev, OUTSIDE the
 * portal's own cgroup. The portal unit has MemoryMax=256M / CPUQuota=50%, so
 * running pnpm/vp as a portal child would OOM-kill the whole portal. systemd-run
 * --wait --pipe runs it synchronously in a fresh (uncapped) cgroup and streams
 * the output back; exit code reflects the child's result.
 */
function runIsolated(cwd, file, args, { timeoutMs = 15 * 60_000, extraEnv = {} } = {}) {
  const env = { HOME: "/home/dev", PATH: DEV_PATH, ...extraEnv };
  const setenv = Object.entries(env).map(([k, v]) => `--setenv=${k}=${v}`);
  const unit = `lsc-rebuild-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const sdArgs = [
    "-n", "systemd-run", "--wait", "--pipe", "--collect", "--quiet",
    `--unit=${unit}`, "--uid=dev", "--gid=dev",
    `--working-directory=${cwd}`,
    ...setenv,
    "--", file, ...args,
  ];
  return run("sudo", sdArgs, { timeoutMs });
}

// ---------------------------------------------------------------- guards

/**
 * The ONLY way a t3code@<name> unit name is ever built for systemctl/journalctl.
 * <name> must be a registry-shaped name; the production unit can never result.
 */
export function assertOpsUnit(name) {
  if (typeof name !== "string" || !NAME_RE.test(name)) throw new Error("invalid instance name");
  const unit = `t3code@${name}.service`;
  if (PRODUCTION_UNITS.has(unit) || PRODUCTION_UNITS.has(name)) {
    throw new Error(`refusing to touch production unit '${name}'`);
  }
  return unit;
}

/** journalctl target: a whitelisted unit that is never production. */
export function assertLogUnit(unit) {
  if (typeof unit !== "string" || PRODUCTION_UNITS.has(unit) || !LOG_UNIT_RE.test(unit)) {
    throw new Error(`unit '${unit}' is not permitted for logs`);
  }
  return unit;
}

function assertBranch(branch) {
  if (typeof branch !== "string" || !BRANCH_RE.test(branch)) {
    throw new Error("branch must match [A-Za-z0-9._/-]{1,80}");
  }
  return branch;
}

// ---------------------------------------------------------------- auth + audit

/** Read the portal-readable token copy. Never logged. */
function readOpsToken() {
  return readFileSync(SECRETS_TOKEN, "utf8").trim();
}

/**
 * Gate an incoming request. Returns { ok:true } or { ok:false, status, detail }.
 * Rejects any X-Forwarded-Host (never reachable via the public gateway) and any
 * request whose X-Ops-Token does not constant-time match the stored secret.
 */
export function checkAuth(req) {
  if (req.headers["x-forwarded-host"] !== undefined) {
    return { ok: false, status: 403, detail: "forwarded requests are not accepted" };
  }
  const provided = req.headers["x-ops-token"];
  if (typeof provided !== "string" || provided.length === 0) {
    return { ok: false, status: 401, detail: "missing X-Ops-Token" };
  }
  let expected;
  try {
    expected = readOpsToken();
  } catch {
    return { ok: false, status: 503, detail: "ops token not provisioned" };
  }
  const a = crypto.createHash("sha256").update(provided).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  if (!crypto.timingSafeEqual(a, b)) {
    return { ok: false, status: 401, detail: "invalid X-Ops-Token" };
  }
  return { ok: true };
}

/** Append one audit line. `params` MUST already be free of secrets. */
function audit(action, params, outcome) {
  try {
    const line =
      JSON.stringify({ ts: new Date().toISOString(), action, params: params ?? {}, outcome }) + "\n";
    appendFileSync(AUDIT_LOG, line, { mode: 0o600 });
  } catch {
    /* auditing must never break the request */
  }
}

// ---------------------------------------------------------------- helpers

function registryUser(name) {
  const users = loadRegistry();
  return users[name] ?? null;
}

/** Poll http://127.0.0.1:<port>/ for a 200 within `timeoutMs`. */
function pollHealth(port, timeoutMs = 60_000, intervalMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  const once = () =>
    new Promise((resolve) => {
      const reqp = http.get({ host: "127.0.0.1", port, path: "/", timeout: 3000 }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      reqp.on("timeout", () => reqp.destroy());
      reqp.on("error", () => resolve(false));
    });
  return new Promise((resolve) => {
    const attempt = async () => {
      if (await once()) return resolve(true);
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(attempt, intervalMs);
    };
    attempt();
  });
}

async function isActive(unit) {
  const r = await run("systemctl", ["is-active", unit], { timeoutMs: 10_000 });
  return r.stdout.trim() || "unknown";
}

async function gitShort(cwd, ref = "HEAD") {
  const r = await run("git", ["-C", cwd, "rev-parse", "--short", ref], { timeoutMs: 10_000 });
  return r.ok ? r.stdout.trim() : null;
}

// ---------------------------------------------------------------- actions

/** 1. status — read-only fleet snapshot. Production appears ONLY as a health bit. */
async function status() {
  const users = loadRegistry();
  const instances = {};
  for (const name of Object.keys(users).sort()) {
    instances[name] = await isActive(`t3code@${name}.service`);
  }
  const [portal, caddy, prod, checkoutBranchR] = await Promise.all([
    isActive("lateshift-portal.service"),
    isActive("caddy.service"),
    isActive("t3code.service"), // production — read-only health bit only
    run("git", ["-C", CHECKOUT, "rev-parse", "--abbrev-ref", "HEAD"], { timeoutMs: 10_000 }),
  ]);
  return {
    ok: true,
    services: {
      instances,
      "lateshift-portal": portal,
      caddy,
      "production(t3code.service)": prod, // read-only health bit, never a target
    },
    checkout: {
      branch: checkoutBranchR.ok ? checkoutBranchR.stdout.trim() : null,
      commit: await gitShort(CHECKOUT),
    },
    portal: {
      branch: INFRA_BRANCH,
      commit: await gitShort(INFRA_REPO),
    },
  };
}

/**
 * 2. rebuild-checkout — fetch+reset the build checkout to origin/<branch>, then
 * pnpm install, vp pack (server), web build, branding. Heavy; run synchronously
 * with generous timeouts. Returns per-stage tail output; stops at first failure.
 */
async function rebuildCheckout(body) {
  const branch = assertBranch(body?.branch);
  const stages = [];
  const vp = `${CHECKOUT}/node_modules/.bin/vp`;
  // Light git stages run in-process (as dev); heavy build stages are isolated.
  const light = async (name, file, args, opts = {}) => {
    const r = await run(file, args, { cwd: CHECKOUT, ...opts });
    stages.push({ stage: name, ok: r.ok, code: r.code, tail: tail(r, 3000) });
    return r.ok;
  };
  const heavy = async (name, cwd, file, args, opts = {}) => {
    const r = await runIsolated(cwd, file, args, opts);
    stages.push({ stage: name, ok: r.ok, code: r.code, tail: tail(r, 3000) });
    return r.ok;
  };

  if (!(await light("fetch", "git", ["-C", CHECKOUT, "fetch", "origin", branch], { timeoutMs: 180_000 })))
    return { ok: false, stage: "fetch", stages };
  if (!(await light("reset", "git", ["-C", CHECKOUT, "reset", "--hard", "FETCH_HEAD"], { timeoutMs: 60_000 })))
    return { ok: false, stage: "reset", stages };
  if (!(await heavy("install", CHECKOUT, "corepack", ["pnpm", "install", "--prefer-offline"])))
    return { ok: false, stage: "install", stages };
  if (!(await heavy("pack-server", `${CHECKOUT}/apps/server`, vp, ["pack"])))
    return { ok: false, stage: "pack-server", stages };
  if (!existsSync(`${CHECKOUT}/apps/server/dist/bin.mjs`)) {
    stages.push({ stage: "verify-server", ok: false, code: 1, tail: "apps/server/dist/bin.mjs missing" });
    return { ok: false, stage: "verify-server", stages };
  }
  if (!(await heavy("build-web", CHECKOUT, vp, ["run", "--filter", "./apps/web", "build"])))
    return { ok: false, stage: "build-web", stages };
  if (!existsSync(`${CHECKOUT}/apps/web/dist/index.html`)) {
    stages.push({ stage: "verify-web", ok: false, code: 1, tail: "apps/web/dist/index.html missing" });
    return { ok: false, stage: "verify-web", stages };
  }
  if (!(await heavy("branding", CHECKOUT, "bash", [BRANDING, `${CHECKOUT}/apps/web/dist`], { timeoutMs: 120_000 })))
    return { ok: false, stage: "branding", stages };

  return { ok: true, branch, commit: await gitShort(CHECKOUT), stages };
}

/**
 * 3. restart-instance — restart a t3code@<name> template instance.
 *  - name === SELF (the calling workspace) requires delaySeconds (10-300): the
 *    restart is scheduled via a transient systemd timer so it fires AFTER this
 *    turn completes. Refuses if a delayed restart is already pending.
 *  - any other instance: immediate restart + health poll on its localPort.
 */
async function restartInstance(body) {
  const name = body?.name;
  const unit = assertOpsUnit(name); // also blocks production
  const delayRaw = body?.delaySeconds;

  if (name === SELF_NAME) {
    if (delayRaw === undefined || delayRaw === null) {
      return {
        ok: false,
        refused: true,
        detail:
          `refusing to restart the calling workspace '${name}' immediately: that would ` +
          `kill this turn. Pass delaySeconds (10-300) to schedule a delayed self-restart.`,
      };
    }
    const delay = Number(delayRaw);
    if (!Number.isInteger(delay) || delay < 10 || delay > 300) {
      return { ok: false, refused: true, detail: "delaySeconds must be an integer 10-300" };
    }
    const transient = `lsc-delayed-restart-${name}`;
    const pending = await isActive(`${transient}.timer`);
    if (pending === "active" || pending === "activating" || pending === "waiting") {
      return { ok: false, refused: true, detail: `a delayed restart (${transient}) is already pending` };
    }
    const r = await run(
      "sudo",
      [
        "-n",
        "systemd-run",
        "--collect",
        `--on-active=${delay}s`,
        `--unit=${transient}`,
        "systemctl",
        "restart",
        unit,
      ],
      { timeoutMs: 15_000 },
    );
    if (!r.ok) return { ok: false, stage: "schedule", detail: tail(r, 2000) };
    return { ok: true, scheduled: true, self: true, delaySeconds: delay, unit: transient };
  }

  // Other instance: immediate restart, then confirm health on its localPort.
  const r = await run("sudo", ["-n", "systemctl", "restart", unit], { timeoutMs: 90_000 });
  if (!r.ok) return { ok: false, stage: "restart", detail: tail(r, 2000) };
  const u = registryUser(name);
  const port = u ? Number(u.localPort) : null;
  if (!port) return { ok: true, restarted: true, health: "unknown", detail: "no localPort in registry" };
  const healthy = await pollHealth(port, 60_000);
  return { ok: healthy, restarted: true, health: healthy ? "healthy" : "unhealthy", localPort: port };
}

/**
 * 4. deploy-portal — redeploy the portal onto itself. Because restarting
 * lateshift-portal kills THIS process, the request cannot both restart-and-poll
 * inline. Robust solution:
 *   (a) In-process (as dev): back up the installed dir to portal.bak-<ts> and
 *       rsync the source over it (static/ preserved).
 *   (b) Hand restart + health-poll + AUTO-ROLLBACK to a DETACHED supervisor
 *       started via `systemd-run` (a transient unit, independent of the portal
 *       process): it restarts the portal, polls /healthz, and on failure
 *       restores the backup and restarts again — writing the final outcome to
 *       the audit log. The HTTP response returns BEFORE the restart, reporting
 *       that the supervised redeploy was launched (observe via status/healthz).
 */
async function deployPortal() {
  if (!existsSync(PORTAL_SRC)) return { ok: false, stage: "validate", detail: "portal source missing" };
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${LSC_ROOT}/portal.bak-${ts}`;

  // (a) backup + sync, in-process (dev-owned files stay dev-owned).
  const cp = await run("cp", ["-a", PORTAL_DST, backup], { timeoutMs: 60_000 });
  if (!cp.ok) return { ok: false, stage: "backup", detail: tail(cp, 2000) };
  const sync = await run(
    "rsync",
    [
      "-a",
      "--delete",
      "--exclude=/static",
      "--exclude=/README.md",
      "--exclude=/actions.mjs",
      `${PORTAL_SRC}/`,
      `${PORTAL_DST}/`,
    ],
    { timeoutMs: 60_000 },
  );
  if (!sync.ok) return { ok: false, stage: "sync", detail: tail(sync, 2000) };

  // (b) detached supervisor: restart, poll /healthz, auto-rollback on failure.
  const port = Number(process.env.PORT ?? 3790);
  const script = `
set -u
LOG=${AUDIT_LOG}
audit() { printf '%s\\n' "{\\"ts\\":\\"$(date -Is)\\",\\"action\\":\\"deploy-portal:supervisor\\",\\"outcome\\":\\"$1\\"}" >> "$LOG"; }
sleep 1
systemctl restart lateshift-portal
ok=0
for i in $(seq 1 20); do
  if curl -fsS -m 3 http://127.0.0.1:${port}/healthz >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
if [ "$ok" = 1 ]; then audit "deployed-healthy backup=${backup}"; exit 0; fi
# rollback
rsync -a --delete "${backup}/" "${PORTAL_DST}/"
systemctl restart lateshift-portal
ok=0
for i in $(seq 1 20); do
  if curl -fsS -m 3 http://127.0.0.1:${port}/healthz >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
if [ "$ok" = 1 ]; then audit "rolled-back-healthy backup=${backup}"; else audit "rollback-FAILED backup=${backup}"; fi
`;
  const sup = await run(
    "sudo",
    [
      "-n",
      "systemd-run",
      "--collect",
      "--unit=lsc-portal-redeploy",
      "/bin/bash",
      "-c",
      script,
    ],
    { timeoutMs: 15_000 },
  );
  if (!sup.ok) {
    // Supervisor failed to launch: roll back synchronously so we don't leave a
    // half-deployed tree, then report.
    await run("rsync", ["-a", "--delete", `${backup}/`, `${PORTAL_DST}/`], { timeoutMs: 60_000 });
    return { ok: false, stage: "supervisor", detail: tail(sup, 2000) };
  }
  return {
    ok: true,
    scheduled: true,
    backup,
    detail:
      "portal synced; supervised restart launched (systemd-run lsc-portal-redeploy). It polls " +
      "/healthz and auto-rolls-back to the backup on failure. Verify via status/healthz.",
  };
}

/** 5. update-gateway — validate the installed Caddy config, then reload.
 * There is nothing to render any more (W7-C deleted the per-user subdomain
 * blocks and render-gateway): the v2 gateway is one static Caddyfile. Validate
 * BEFORE reload so a broken config can never be loaded into the gateway. */
async function updateGateway() {
  const v = await run(
    "sudo",
    ["-n", "caddy", "validate", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"],
    { timeoutMs: 60_000 },
  );
  if (!v.ok) return { ok: false, stage: "validate", code: v.code, output: tail(v, 3000) };
  const r = await run("sudo", ["-n", "systemctl", "reload", "caddy"], { timeoutMs: 60_000 });
  return { ok: r.ok, stage: "reload", code: r.code, output: tail(r, 3000) };
}

/** 6. logs — journalctl for whitelisted units only (never production t3code). */
async function logs(body) {
  const unit = assertLogUnit(body?.unit);
  let lines = Number(body?.lines ?? 100);
  if (!Number.isInteger(lines) || lines < 1) lines = 100;
  if (lines > 200) lines = 200;
  const r = await run(
    "sudo",
    ["-n", "journalctl", "-u", unit, "-n", String(lines), "--no-pager", "-o", "short-iso"],
    { timeoutMs: 30_000 },
  );
  if (!r.ok) return { ok: false, unit, detail: tail(r, 2000) };
  return { ok: true, unit, lines, output: r.stdout.slice(-16000) };
}

/** 7. pull-infra — fetch origin and report ahead/behind for the infra branch. */
async function pullInfra() {
  const fetch = await run("git", ["-C", INFRA_REPO, "fetch", "origin", INFRA_BRANCH], {
    timeoutMs: 120_000,
  });
  if (!fetch.ok) return { ok: false, stage: "fetch", detail: tail(fetch, 2000) };
  const counts = await run(
    "git",
    ["-C", INFRA_REPO, "rev-list", "--left-right", "--count", `origin/${INFRA_BRANCH}...HEAD`],
    { timeoutMs: 15_000 },
  );
  let behind = null;
  let ahead = null;
  if (counts.ok) {
    const m = counts.stdout.trim().split(/\s+/);
    behind = Number(m[0]);
    ahead = Number(m[1]);
  }
  return {
    ok: true,
    branch: INFRA_BRANCH,
    behind, // commits on origin not yet local
    ahead, // local commits not yet on origin
    localCommit: await gitShort(INFRA_REPO),
    originCommit: await gitShort(INFRA_REPO, `origin/${INFRA_BRANCH}`),
  };
}

// ---------------------------------------------------------------- dispatch

const ACTIONS = {
  status,
  "rebuild-checkout": rebuildCheckout,
  "restart-instance": restartInstance,
  "deploy-portal": deployPortal,
  "update-gateway": updateGateway,
  logs,
  "pull-infra": pullInfra,
};

/** Params echoed to the audit log per action (never secrets). */
function auditParams(action, body) {
  switch (action) {
    case "rebuild-checkout":
      return { branch: body?.branch };
    case "restart-instance":
      return { name: body?.name, delaySeconds: body?.delaySeconds ?? null };
    case "logs":
      return { unit: body?.unit, lines: body?.lines ?? null };
    default:
      return {};
  }
}

/**
 * Entry point invoked by server.mjs for POST /internal/ops/<action>.
 * `action` is the path segment; `body` the parsed JSON object.
 * Returns { status, payload } — the handler serializes payload as JSON.
 */
export async function handleOps(action, body) {
  const fn = ACTIONS[action];
  if (!fn) return { status: 404, payload: { ok: false, detail: `unknown action '${action}'` } };
  const params = auditParams(action, body);
  try {
    const payload = await fn(body ?? {});
    audit(action, params, payload.ok ? "ok" : `fail:${payload.stage ?? payload.detail ?? "?"}`.slice(0, 200));
    return { status: 200, payload };
  } catch (err) {
    const detail = String(err?.message ?? err).slice(0, 500);
    audit(action, params, `error:${detail}`.slice(0, 200));
    return { status: 400, payload: { ok: false, detail } };
  }
}
