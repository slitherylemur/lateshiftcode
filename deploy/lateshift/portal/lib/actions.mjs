// actions.mjs — every shell-out the portal performs. All of them use
// execFile (argv arrays, never shell strings) and validate every
// user-supplied value before it reaches an argv.
//
// SAFETY: systemctl is only ever invoked with a unit name that passes
// assertSafeUnit(): t3code@<name>[.service] template instances or the
// portal's own unit. The bare production unit `t3code` / `t3code.service`
// can never be named.

import { execFile } from "node:child_process";
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { dirname, basename } from "node:path";
import { NAME_RE, TS_LOGIN_RE, GH_LOGIN_RE } from "./registry.mjs";

const T3USER = "/home/dev/services/lateshift/bin/t3user";
// Stock production binary — NEVER the patched checkout: running the checkout
// build against production's default base dir would apply fork migrations to
// production's state database.
const SHARED_SERVER_BIN = "/usr/bin/t3";

const SAFE_UNIT_RE = /^t3code@[a-z0-9-]{2,20}(\.service)?$/;

export function assertSafeUnit(unit) {
  if (SAFE_UNIT_RE.test(unit) || unit === "lateshift-portal") return unit;
  throw new Error(`refusing to touch systemd unit '${unit}'`);
}

export function assertName(name) {
  if (typeof name === "string" && NAME_RE.test(name)) return name;
  throw new Error("invalid user name");
}

export function assertTsLogin(login) {
  if (typeof login === "string" && TS_LOGIN_RE.test(login) && login.length <= 128) return login;
  throw new Error("invalid tailnet login");
}

export function assertLimit(value) {
  const n = Number(value);
  if (Number.isInteger(n) && n >= 0 && n <= 999) return n;
  throw new Error("project limit must be an integer 0-999");
}

function run(file, args, { timeoutMs = 120_000, cwd, env, maxBuffer = 1024 * 1024 } = {}) {
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

/** systemctl is-active <unit> — read-only, no sudo needed. */
export async function instanceStatus(name) {
  const unit = assertSafeUnit(`t3code@${assertName(name)}.service`);
  const r = await run("systemctl", ["is-active", unit], { timeoutMs: 10_000 });
  return r.stdout.trim() || "unknown";
}

/** sudo systemctl restart t3code@<name> (allowed for template instances only). */
export async function restartInstance(name) {
  const unit = assertSafeUnit(`t3code@${assertName(name)}.service`);
  return run("sudo", ["-n", "systemctl", "restart", unit], {
    timeoutMs: 90_000,
  });
}

const PAIR_URL_RE = /https:\/\/[A-Za-z0-9.-]+(?::\d+)?\/pair#token=[A-Za-z0-9]+/;

/** t3user pair <name> → one-time pairing URL for the user's own instance. */
export async function mintUserPairing(name, ttl = "15m", { publicHost = false } = {}) {
  if (!/^[0-9]+[smhd]$/.test(ttl)) throw new Error("invalid ttl");
  const args = ["pair", assertName(name), "--ttl", ttl];
  if (publicHost) args.push("--public");
  const r = await run(T3USER, args);
  const match = r.stdout.match(PAIR_URL_RE);
  if (!r.ok || !match) {
    return { ok: false, url: null, detail: (r.stderr || r.stdout).slice(0, 2000) };
  }
  return { ok: true, url: match[0], detail: null };
}

/**
 * Pairing against the SHARED instance (today: production, default base dir
 * ~/.t3 — deliberately NO --base-dir flag). Verifies the printed URL points
 * at the configured shared workspace origin before handing it out.
 */
export async function mintSharedPairing(name, sharedWorkspaceUrl) {
  assertName(name);
  if (!sharedWorkspaceUrl) {
    return { ok: false, url: null, detail: "shared workspace not configured" };
  }
  const baseUrl = sharedWorkspaceUrl.replace(/\/+$/, "");
  const r = await run(SHARED_SERVER_BIN, [
    "auth",
    "pairing",
    "create",
    "--ttl",
    "15m",
    "--label",
    `portal:${name}`,
    "--base-url",
    baseUrl,
  ]);
  const match = r.stdout.match(PAIR_URL_RE);
  if (!r.ok || !match) {
    return { ok: false, url: null, detail: (r.stderr || r.stdout).slice(0, 2000) };
  }
  const url = match[0];
  const expectedOrigin = new URL(sharedWorkspaceUrl).origin;
  if (new URL(url).origin !== expectedOrigin) {
    return {
      ok: false,
      url: null,
      detail: `pairing URL origin ${new URL(url).origin} does not match shared workspace ${expectedOrigin}`,
    };
  }
  return { ok: true, url, detail: null };
}

/** t3user add — provisioning can take up to ~90s (health-gated). */
export async function addUser({ name, tsLogin, projectLimit }) {
  const args = ["add", assertName(name), "--project-limit", String(assertLimit(projectLimit))];
  if (tsLogin) args.push("--ts-login", assertTsLogin(tsLogin));
  return run(T3USER, args, { timeoutMs: 180_000 });
}

export function assertBudget(value) {
  const n = Number(value);
  if (Number.isFinite(n) && n >= 0 && n <= 100000) return Math.round(n * 100) / 100;
  throw new Error("budget must be a number 0-100000 (0 = unlimited)");
}

const SHARED_PATH_RE = /^\/home\/dev\/(shared|projects)\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

export function assertSharedPath(path) {
  if (typeof path === "string" && path.length <= 300 && SHARED_PATH_RE.test(path)) return path;
  throw new Error("shared path must be under /home/dev/shared/ or /home/dev/projects/");
}

/** t3user set <name> <key> <value> (allowed keys enforced by the CLI too). */
export async function setUserField(name, key, value) {
  if (!["projectLimit", "sharedAccess", "tsLogin", "admin", "monthlyBudgetUsd"].includes(key))
    throw new Error(`key '${key}' is not settable`);
  let v;
  if (key === "projectLimit") v = String(assertLimit(value));
  else if (key === "monthlyBudgetUsd") v = String(assertBudget(value));
  else if (key === "sharedAccess" || key === "admin")
    v = value === true || value === "true" ? "true" : "false";
  else v = assertTsLogin(value);
  return run(T3USER, ["set", assertName(name), key, v]);
}

/** t3user share/unshare <name> <path> — grant or revoke a shared project dir. */
export async function shareProject(name, path) {
  return run(T3USER, ["share", assertName(name), assertSharedPath(path)], { timeoutMs: 60_000 });
}

export async function unshareProject(name, path) {
  return run(T3USER, ["unshare", assertName(name), assertSharedPath(path)], { timeoutMs: 60_000 });
}

/** t3user remove <name> [--force] */
export async function removeUser(name, { force = false } = {}) {
  const args = ["remove", assertName(name)];
  if (force) args.push("--force");
  return run(T3USER, args, { timeoutMs: 180_000 });
}

export function assertGithubLogin(login) {
  if (typeof login === "string" && GH_LOGIN_RE.test(login)) return login;
  throw new Error("invalid github login");
}

/**
 * Persist a user's GitHub login via the t3user CLI:
 *   t3user set <name> githubLogin <login>
 * NOTE: t3user must allow the `githubLogin` key for this to succeed. If the
 * installed t3user rejects unknown keys this resolves { ok:false } and the
 * caller surfaces a warning (the registry is only ever written via t3user).
 */
export async function setGithubLogin(name, login) {
  return run(T3USER, ["set", assertName(name), "githubLogin", assertGithubLogin(login)]);
}

// -------------------------------------------------------------------------
// Roblox project broker
// -------------------------------------------------------------------------
// The privileged, keyless Roblox project creation. Instances run sandboxed and
// cannot read the group master key or create repos under the group owner's
// GitHub account, so they POST /internal/roblox-create and this runs the
// cloud-project-maker scripts from the (unsandboxed, dev) portal process with
// the master key injected via the environment. The key is NEVER logged and is
// scrubbed from any script output surfaced back to the caller.

const CLOUD_PROJECT_MAKER_DIR =
  process.env.LSC_CLOUD_PROJECT_MAKER_DIR ?? "/home/dev/projects/cloud-project-maker";
const ROBLOX_MASTER_ENV =
  process.env.LSC_ROBLOX_MASTER_ENV ?? "/home/dev/services/lateshift/secrets/roblox-master.env";
// The two roots a project may be created under (validated via realpath so a
// symlink cannot smuggle the target elsewhere).
const SHARED_PROJECTS_ROOT = "/home/dev/shared";
const INSTANCE_USERS_ROOT = "/home/dev/services/lateshift/users";
// Broker-specific name rule (the task spec): 2-30 chars of [a-z0-9-].
const ROBLOX_NAME_RE = /^[a-z0-9-]{2,30}$/;
const ROBLOX_JSON_RE = /^\{[\s0-9a-zA-Z":,.-]{0,4000}\}$/;
const REPO_URL_RE = /Repo:\s*(https:\/\/\S+)/i;
const WIRE_DOWNLOAD_FAILED_MARKER = "WIRE_ASSET_DOWNLOAD_FAILED";

/** Read the group master Roblox key. Never logged. Throws if unconfigured. */
function readMasterRobloxKey() {
  const text = readFileSync(ROBLOX_MASTER_ENV, "utf8");
  const m = /^\s*ROBLOX_MASTER_API_KEY\s*=\s*(.+?)\s*$/m.exec(text);
  const key = m ? m[1].replace(/^["']|["']$/g, "").trim() : "";
  if (!key) throw new Error("group master Roblox key is not configured");
  return key;
}

/** Replace every occurrence of each secret with <redacted>. */
function scrubSecrets(text, secrets) {
  let out = String(text ?? "");
  for (const s of secrets) {
    if (typeof s === "string" && s.length >= 8) out = out.split(s).join("<redacted>");
  }
  return out;
}

/** realpath of the nearest existing ancestor of an as-yet-uncreated path. */
function realExistingAncestor(p) {
  let cur = p;
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return realpathSync(cur);
}

/**
 * Validate targetDir and return its normalized absolute form. Throws on any
 * violation. `shareWithStaff` selects which realpath prefix is allowed.
 */
export function assertBrokerTargetDir(targetDir, name, shareWithStaff) {
  if (typeof targetDir !== "string" || targetDir.length === 0 || targetDir.length > 4096) {
    throw new Error("targetDir must be a non-empty path");
  }
  if (targetDir[0] !== "/" || targetDir.includes("\0"))
    throw new Error("targetDir must be absolute");
  if (targetDir.split("/").includes("..")) throw new Error("targetDir must not contain '..'");
  if (basename(targetDir) !== name)
    throw new Error("targetDir basename must equal the project name");
  if (existsSync(targetDir)) throw new Error("targetDir already exists");

  const ancestor = realExistingAncestor(dirname(targetDir));
  const base = shareWithStaff ? SHARED_PROJECTS_ROOT : INSTANCE_USERS_ROOT;
  const ok = ancestor === base || ancestor.startsWith(`${base}/`);
  if (!ok) {
    throw new Error(
      shareWithStaff
        ? `shared targetDir must be under ${SHARED_PROJECTS_ROOT}/`
        : `targetDir must be under ${INSTANCE_USERS_ROOT}/`,
    );
  }
  return targetDir;
}

/** Environment for the cloud-project-maker scripts (dev tools + TARGET_DIR). */
function brokerScriptEnv(targetDir) {
  const path = [
    "/home/dev/.local/bin",
    "/home/dev/.rokit/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ].join(":");
  return { ...process.env, HOME: "/home/dev", PATH: path, TARGET_DIR: targetDir };
}

/**
 * Broker entry point. Returns a plain object the HTTP handler serializes:
 *   success: { ok:true, stages, repositoryUrl?, output }
 *   failure: { ok:false, stage, detail?, code?, repositoryUrl? }
 * `stage` is one of validate | scaffold | wire | verify-download.
 */
export async function createRobloxProject({ name, robloxJson, targetDir, shareWithStaff }) {
  if (!ROBLOX_NAME_RE.test(typeof name === "string" ? name : "")) {
    return { ok: false, stage: "validate", detail: "name must match [a-z0-9-]{2,30}" };
  }
  if (typeof robloxJson !== "string" || !ROBLOX_JSON_RE.test(robloxJson)) {
    return { ok: false, stage: "validate", detail: "robloxJson must be a compact JSON object" };
  }
  const share = shareWithStaff === true;
  let safeTarget;
  try {
    safeTarget = assertBrokerTargetDir(targetDir, name, share);
  } catch (e) {
    return { ok: false, stage: "validate", detail: e?.message ?? "invalid targetDir" };
  }

  let masterKey;
  try {
    masterKey = readMasterRobloxKey();
  } catch (e) {
    return { ok: false, stage: "validate", detail: e?.message ?? "master key unavailable" };
  }
  const secrets = [masterKey];
  const env = brokerScriptEnv(safeTarget);
  const runOpts = { cwd: CLOUD_PROJECT_MAKER_DIR, env, maxBuffer: 16 * 1024 * 1024 };

  // Stage 1: scaffold + create the GitHub repo (no key needed here).
  const np = await run("./new-project.sh", [name, "--roblox", robloxJson, "--no-register"], {
    ...runOpts,
    timeoutMs: 15 * 60_000,
  });
  if (!np.ok) {
    return {
      ok: false,
      stage: "scaffold",
      code: np.code,
      detail: scrubSecrets(np.stderr || np.stdout, secrets).slice(-4000),
    };
  }
  const repoMatch = REPO_URL_RE.exec(np.stdout);
  const repositoryUrl = repoMatch ? repoMatch[1] : undefined;

  // Stage 2: wire ids + secrets and push. Both env keys carry the master key.
  const wr = await run("./wire-roblox.sh", [name, robloxJson], {
    ...runOpts,
    timeoutMs: 10 * 60_000,
    env: { ...env, ROBLOX_TEST_API_KEY: masterKey, ROBLOX_PROD_API_KEY: masterKey },
  });
  const wireOut = `${wr.stdout}\n${wr.stderr}`;
  if (wireOut.includes(WIRE_DOWNLOAD_FAILED_MARKER)) {
    return { ok: false, stage: "verify-download", ...(repositoryUrl ? { repositoryUrl } : {}) };
  }
  if (!wr.ok) {
    return {
      ok: false,
      stage: "wire",
      code: wr.code,
      detail: scrubSecrets(wireOut, secrets).slice(-4000),
      ...(repositoryUrl ? { repositoryUrl } : {}),
    };
  }

  return {
    ok: true,
    stages: ["scaffold", "repo", "wire", "deploy-triggered"],
    ...(repositoryUrl ? { repositoryUrl } : {}),
    projectPath: safeTarget,
    output: scrubSecrets(wireOut, secrets).slice(-2000),
  };
}
