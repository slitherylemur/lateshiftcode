// actions.mjs — every shell-out the portal performs. All of them use
// execFile (argv arrays, never shell strings) and validate every
// user-supplied value before it reaches an argv.
//
// SAFETY: systemctl is only ever invoked with a unit name that passes
// assertSafeUnit(): t3code@<name>[.service] template instances or the
// portal's own unit. The bare production unit `t3code` / `t3code.service`
// can never be named.

import { execFile } from "node:child_process";
import { NAME_RE, TS_LOGIN_RE } from "./registry.mjs";

const T3USER = "/home/dev/services/lateshift/bin/t3user";
const SHARED_SERVER_BIN = "/home/dev/services/lateshift/checkout/apps/server/dist/bin.mjs";

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

function run(file, args, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          code: error ? (error.code ?? 1) : 0,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
        });
      },
    );
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
export async function mintUserPairing(name, ttl = "15m") {
  if (!/^[0-9]+[smhd]$/.test(ttl)) throw new Error("invalid ttl");
  const r = await run(T3USER, ["pair", assertName(name), "--ttl", ttl]);
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
  const r = await run("node", [
    SHARED_SERVER_BIN,
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

/** t3user set <name> <key> <value> (allowed keys enforced by the CLI too). */
export async function setUserField(name, key, value) {
  if (!["projectLimit", "sharedAccess", "tsLogin", "admin"].includes(key))
    throw new Error(`key '${key}' is not settable`);
  let v;
  if (key === "projectLimit") v = String(assertLimit(value));
  else if (key === "sharedAccess" || key === "admin")
    v = value === true || value === "true" ? "true" : "false";
  else v = assertTsLogin(value);
  return run(T3USER, ["set", assertName(name), key, v]);
}

/** t3user remove <name> [--force] */
export async function removeUser(name, { force = false } = {}) {
  const args = ["remove", assertName(name)];
  if (force) args.push("--force");
  return run(T3USER, args, { timeoutMs: 180_000 });
}
