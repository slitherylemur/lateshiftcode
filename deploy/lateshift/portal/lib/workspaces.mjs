// workspaces.mjs — read-only access to the v2 registry (registry.json) and the
// session→workspace resolution used by /authz.
//
// This module is the routing half of architecture-v2 R2: /authz is the single
// point of failure for ALL access control, so everything here FAILS CLOSED.
// Any parse error, any missing field, any workspace that cannot be positively
// confirmed as (a) known, (b) containing the caller as a member and (c)
// serving on a socket inside the runtime root → deny. There is no fallback
// from an explicit-but-invalid selection to the personal workspace: a cookie
// that names a workspace the user cannot use is a deny, not a redirect.
//
// registry.json is written exclusively by the lsw CLI (flock + atomic rename);
// the portal only ever reads it, re-read on every request.

import { readFileSync, existsSync } from "node:fs";
import { LATESHIFT_ROOT, GH_LOGIN_RE } from "./registry.mjs";

export const REGISTRY_V2_PATH = `${LATESHIFT_ROOT}/registry.json`;

// Runtime root that every workspace socket must live under. Overridable only
// for the test matrix (scratch tree); defaults to the tmpfiles-managed /run/lsc.
export const RUNTIME_ROOT = process.env.LSC_RUNTIME_ROOT || "/run/lsc";

// Workspace ids are u-<slug> / t-<slug>, produced by lsw. Anything else in the
// lsc_ws cookie is rejected before it is ever used in a lookup.
export const WS_ID_RE = /^[ut]-[a-z0-9][a-z0-9-]{0,38}$/;

// The workspace-selection cookie. It is a HINT, never an assertion: /authz
// validates it against registry membership on every single request.
export const WS_COOKIE = "lsc_ws";

/**
 * Load and minimally validate registry.json. THROWS on any problem — the
 * caller (handleAuthz) turns every throw into a deny. Never returns a
 * partially-usable registry.
 */
export function loadRegistryV2() {
  const raw = JSON.parse(readFileSync(REGISTRY_V2_PATH, "utf8"));
  if (!raw || typeof raw !== "object") throw new Error("registry: not an object");
  const users = raw.users, workspaces = raw.workspaces;
  if (!users || typeof users !== "object") throw new Error("registry: users missing");
  if (!workspaces || typeof workspaces !== "object") throw new Error("registry: workspaces missing");
  return { users, workspaces };
}

/** Case-insensitive membership test against a workspace's members list. */
function isMember(ws, login) {
  if (!Array.isArray(ws.members)) return false;
  const lower = login.toLowerCase();
  return ws.members.some((m) => typeof m === "string" && m.toLowerCase() === lower);
}

/**
 * Resolve an authenticated GitHub login (+ optional lsc_ws cookie value) to
 * the workspace upstream Caddy should proxy to.
 *
 * Returns exactly one of:
 *   { ok: true,  upstream: "unix/<socketPath>", user: "<canonical login>", workspaceId }
 *   { ok: false, status: 403, reason }    — deny (never routed)
 *   { ok: false, status: 503, reason }    — member is valid but the workspace
 *                                           socket is not present yet ("starting")
 *
 * Decision table (every row verified by test/authz-matrix.mjs):
 *   unknown login              → 403   user status != active        → 403
 *   cookie bad format          → 403   cookie unknown workspace     → 403
 *   cookie non-member          → 403   no personal workspace        → 403
 *   socketPath missing/outside → 403   socket file absent           → 503
 */
export function resolveWorkspace(login, wsCookie, reg) {
  const deny = (reason) => ({ ok: false, status: 403, reason });

  if (typeof login !== "string" || !GH_LOGIN_RE.test(login)) return deny("bad-login");
  const user = reg.users[login.toLowerCase()];
  if (!user || typeof user !== "object") return deny("unknown-user");
  if (user.status !== "active") return deny("user-not-active");
  const canonical = typeof user.githubLogin === "string" ? user.githubLogin : null;
  if (!canonical || canonical.toLowerCase() !== login.toLowerCase()) return deny("registry-login-mismatch");

  // Workspace selection. Explicit cookie → that workspace or nothing.
  // No cookie → the personal workspace, which must still pass every check.
  let wsId;
  if (wsCookie != null && wsCookie !== "") {
    if (typeof wsCookie !== "string" || !WS_ID_RE.test(wsCookie)) return deny("bad-ws-cookie");
    wsId = wsCookie;
  } else {
    if (typeof user.personalWorkspace !== "string" || !WS_ID_RE.test(user.personalWorkspace)) {
      return deny("no-personal-workspace");
    }
    wsId = user.personalWorkspace;
  }

  const ws = reg.workspaces[wsId];
  if (!ws || typeof ws !== "object") return deny("unknown-workspace");
  // Membership is checked on EVERY request, for EVERY workspace kind,
  // including the caller's own personal one and including admins. There is no
  // admin bypass here: routing follows membership, full stop (R2 — no other
  // responsibilities, no special cases to get wrong).
  if (!isMember(ws, canonical)) return deny("not-a-member");

  const sock = ws.socketPath;
  if (typeof sock !== "string" || !sock.startsWith(`${RUNTIME_ROOT}/`) || sock.includes("..")) {
    return deny("bad-socket-path");
  }
  if (!existsSync(sock)) {
    // Known member of a known workspace whose instance has no socket yet
    // (starting, or crashed). Caddy shows a friendly "starting" page on 503
    // instead of dialing an empty upstream and returning a bare 502.
    return { ok: false, status: 503, reason: "workspace-starting" };
  }
  return { ok: true, upstream: `unix/${sock}`, user: canonical, workspaceId: wsId };
}
