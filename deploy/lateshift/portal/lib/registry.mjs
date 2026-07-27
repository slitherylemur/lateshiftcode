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
// GitHub login: 1-39 chars, alphanumerics and hyphens.
export const GH_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

// Positive number or null (absence / non-positive is "no cap configured").
function posNum(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * portal.config.json (all fields optional; absence of each key tolerated):
 *   adminLogins        string[]  — tailnet logins that are portal admins
 *   sharedWorkspaceUrl string    — origin of the shared production workspace
 *   sharedStateDb      string    — path to the shared instance state DB
 *   subscriptionLimits object    — provider spend caps used by the admin
 *                                   subscription-totals panel. Keys:
 *       claude    usd/month cap for Claude-backed usage    (optional)
 *       codex     usd/month cap for Codex/OpenAI usage      (optional)
 *       claude5h  usd cap per 5-hour session window, Claude  (optional)
 *       codex5h   usd cap per 5-hour session window, Codex   (optional)
 *   -- GitHub OAuth / public sign-in (added for lateshiftcloud.com) --
 *   githubClientId     string    — GitHub OAuth app client id
 *   githubClientSecret string    — GitHub OAuth app client secret
 *   sessionSecret      string    — HMAC key for the lsc_session cookie (hex)
 *   publicBaseUrl      string    — public origin, e.g. https://lateshiftcloud.com
 *   cookieDomain       string    — e.g. .lateshiftcloud.com (session cookie Domain)
 *   adminGithubLogins  string[]  — GitHub logins that are portal admins
 *   resendApiKey       string    — Resend API key for signup notifications
 *   notifyEmail        string    — where signup-request emails are sent
 *   Absence of subscriptionLimits (or any key) is tolerated: the panel shows
 *   raw totals without a percentage ring for the missing cap.
 */
export function loadConfig() {
  const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  const sl = raw.subscriptionLimits && typeof raw.subscriptionLimits === "object" ? raw.subscriptionLimits : {};
  return {
    adminLogins: Array.isArray(raw.adminLogins) ? raw.adminLogins : [],
    sharedWorkspaceUrl: raw.sharedWorkspaceUrl || null,
    sharedStateDb: raw.sharedStateDb || null,
    subscriptionLimits: {
      claude: posNum(sl.claude),
      codex: posNum(sl.codex),
      claude5h: posNum(sl.claude5h),
      codex5h: posNum(sl.codex5h),
    },
    // GitHub OAuth / public portal. Each key tolerated absent (→ null / []).
    githubClientId: raw.githubClientId || null,
    githubClientSecret: raw.githubClientSecret || null,
    sessionSecret: raw.sessionSecret || null,
    publicBaseUrl: raw.publicBaseUrl ? String(raw.publicBaseUrl).replace(/\/+$/, "") : null,
    cookieDomain: raw.cookieDomain || null,
    adminGithubLogins: Array.isArray(raw.adminGithubLogins) ? raw.adminGithubLogins : [],
    resendApiKey: raw.resendApiKey || null,
    notifyEmail: raw.notifyEmail || null,
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
      // Optional GitHub login mapping (set via `t3user set <name> githubLogin`).
      githubLogin:
        typeof u.githubLogin === "string" && GH_LOGIN_RE.test(u.githubLogin) ? u.githubLogin : null,
      monthlyBudgetUsd: Number(u.monthlyBudgetUsd ?? 0),
      sharedProjects: Array.isArray(u.sharedProjects) ? u.sharedProjects.map(String) : [],
      createdAt: u.createdAt ?? null,
    };
  }
  return users;
}

/**
 * Resolve a principal from a tailnet login (Tailscale-User-Login header) and/or
 * a GitHub login (from a verified lsc_session cookie) to:
 *   { login, user (registry entry or null), isAdmin, via }
 *
 * The tailnet path is preferred when present (KEEPS existing tailnet behaviour
 * exactly). Otherwise the GitHub login is matched against registry users'
 * `githubLogin` (case-insensitive) and against config.adminGithubLogins.
 *
 * Back-compat: a bare string first argument is treated as a tailnet login.
 */
export function resolveIdentity(arg, { users, config }) {
  const tsLogin = typeof arg === "string" ? arg : arg?.tsLogin ?? null;
  const ghLogin = typeof arg === "string" ? null : arg?.ghLogin ?? null;

  // --- Tailnet path (unchanged semantics) ---
  if (tsLogin && typeof tsLogin === "string" && TS_LOGIN_RE.test(tsLogin)) {
    const lower = tsLogin.toLowerCase();
    const user = Object.values(users).find((u) => u.tsLogin && u.tsLogin.toLowerCase() === lower) ?? null;
    const isAdmin = config.adminLogins.some((a) => a.toLowerCase() === lower) || Boolean(user?.admin);
    return { login: tsLogin, user, isAdmin, via: "tailscale" };
  }

  // --- GitHub session path ---
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
