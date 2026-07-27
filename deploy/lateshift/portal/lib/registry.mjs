// registry.mjs — read-only access to the LateShift registry and portal config.
//
// Writes to users.json go exclusively through the t3user CLI (which holds a
// flock and writes atomically); the portal only ever READS the file, re-read
// on every request so CLI-side changes show up immediately.

import { readFileSync } from "node:fs";

export const LATESHIFT_ROOT = "/home/dev/services/lateshift";
export const REGISTRY_PATH = `${LATESHIFT_ROOT}/users.json`;
export const CONFIG_PATH = `${LATESHIFT_ROOT}/portal.config.json`;

export const NAME_RE = /^[a-z0-9-]{2,20}$/;
export const TS_LOGIN_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$/;

export function loadConfig() {
  const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  return {
    adminLogins: Array.isArray(raw.adminLogins) ? raw.adminLogins : [],
    sharedWorkspaceUrl: raw.sharedWorkspaceUrl || null,
    sharedStateDb: raw.sharedStateDb || null,
  };
}

export function loadRegistry() {
  const raw = JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
  const users = {};
  for (const [name, u] of Object.entries(raw.users ?? {})) {
    if (!NAME_RE.test(name)) continue; // never trust registry names blindly
    users[name] = {
      name,
      localPort: Number(u.localPort),
      tsPort: Number(u.tsPort),
      baseDir: String(u.baseDir ?? ""),
      projectLimit: Number(u.projectLimit ?? 0),
      sharedAccess: Boolean(u.sharedAccess),
      admin: Boolean(u.admin),
      tsLogin: typeof u.tsLogin === "string" && u.tsLogin ? u.tsLogin : null,
      createdAt: u.createdAt ?? null,
    };
  }
  return users;
}

/**
 * Resolve a Tailscale login (from the Tailscale-User-Login header) to a
 * portal principal: { login, user (registry entry or null), isAdmin }.
 * adminLogins from portal.config.json are admins even without a registry user.
 */
export function resolveIdentity(login, { users, config }) {
  if (!login || typeof login !== "string" || !TS_LOGIN_RE.test(login)) {
    return { login: null, user: null, isAdmin: false };
  }
  const lower = login.toLowerCase();
  const user =
    Object.values(users).find((u) => u.tsLogin && u.tsLogin.toLowerCase() === lower) ?? null;
  const isAdmin = config.adminLogins.some((a) => a.toLowerCase() === lower) || Boolean(user?.admin);
  return { login, user, isAdmin };
}
