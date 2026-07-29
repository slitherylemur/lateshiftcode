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
// GitHub login: 1-39 chars, alphanumerics and hyphens.
export const GH_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/**
 * portal.config.json (all fields optional; absence of each key tolerated):
 *   githubClientId     string    — GitHub OAuth app client id
 *   githubClientSecret string    — GitHub OAuth app client secret
 *   sessionSecret      string    — HMAC key for the lsc_session cookie (hex)
 *   publicBaseUrl      string    — public origin, e.g. https://lateshiftcloud.com
 *   cookieDomain       string    — e.g. .lateshiftcloud.com (session cookie Domain)
 *   adminGithubLogins  string[]  — GitHub logins that are portal admins
 */
export function loadConfig() {
  const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  return {
    // GitHub OAuth / public portal. Each key tolerated absent (→ null / []).
    githubClientId: raw.githubClientId || null,
    githubClientSecret: raw.githubClientSecret || null,
    sessionSecret: raw.sessionSecret || null,
    publicBaseUrl: raw.publicBaseUrl ? String(raw.publicBaseUrl).replace(/\/+$/, "") : null,
    cookieDomain: raw.cookieDomain || null,
    adminGithubLogins: Array.isArray(raw.adminGithubLogins) ? raw.adminGithubLogins : [],
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
      baseDir: String(u.baseDir ?? ""),
      projectLimit: Number(u.projectLimit ?? 0),
      admin: Boolean(u.admin),
      // GitHub login mapping (set via `t3user set <name> githubLogin`).
      githubLogin:
        typeof u.githubLogin === "string" && GH_LOGIN_RE.test(u.githubLogin) ? u.githubLogin : null,
      createdAt: u.createdAt ?? null,
    };
  }
  return users;
}

/**
 * Resolve a principal from a GitHub login (from a verified lsc_session cookie)
 * to: { login, user (registry entry or null), isAdmin, via }
 *
 * The login is matched against registry users' `githubLogin`
 * (case-insensitive) and against config.adminGithubLogins.
 */
export function resolveIdentity(arg, { users, config }) {
  const ghLogin = typeof arg === "string" ? arg : (arg?.ghLogin ?? null);

  if (ghLogin && typeof ghLogin === "string" && GH_LOGIN_RE.test(ghLogin)) {
    const lower = ghLogin.toLowerCase();
    const user =
      Object.values(users).find((u) => u.githubLogin && u.githubLogin.toLowerCase() === lower) ?? null;
    const isAdmin =
      (Array.isArray(config.adminGithubLogins) &&
        config.adminGithubLogins.some((a) => String(a).toLowerCase() === lower)) ||
      Boolean(user?.admin);
    return { login: ghLogin, user, isAdmin, via: "github" };
  }

  return { login: null, user: null, isAdmin: false, via: null };
}
