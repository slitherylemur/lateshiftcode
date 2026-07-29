// profiles.mjs — the portal's GitHub profile cache (avatar + display name).
//
// WHY THIS FILE EXISTS
// The registry (users.json) is written exclusively by the t3user CLI and is
// keyed by internal short name; it has no place for GitHub presentation data,
// and the portal must never hand-edit it. Avatars previously came only from the
// Tailscale-User-Profile-Pic header, which architecture-v2.md D3 deletes — so
// `buildContext` hardcoded profilePic: null. This store replaces that: capture
// avatar_url and name at the OAuth callback and persist them here.
//
// Ownership mirrors pending.json: the portal is the only writer, writes are
// atomic (temp file + rename), and the file is keyed by lowercased GitHub login
// so it works for pending users too (who have no registry entry yet).
//
// Contains NO secrets. Tokens live in pending-tokens.json / the per-workspace
// gh store, never here.

import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";

export const PROFILES_PATH = "/home/dev/services/lateshift/profiles.json";

const GH_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const MAX_NAME = 100;

/**
 * Only accept avatar URLs GitHub actually serves. This value is rendered into
 * an <img src>, so an unvalidated URL would let a hostile profile point the
 * browser at an arbitrary origin (and `javascript:`/`data:` are refused here
 * rather than relying on esc() alone).
 */
export function sanitizeAvatarUrl(value) {
  if (typeof value !== "string" || value.length > 512) return null;
  let u;
  try {
    u = new URL(value);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase();
  const ok =
    host === "avatars.githubusercontent.com" ||
    host === "github.com" ||
    host.endsWith(".githubusercontent.com");
  return ok ? u.toString() : null;
}

/** Read the whole store, tolerating absence / corruption. */
export function readProfiles() {
  try {
    if (!existsSync(PROFILES_PATH)) return {};
    const raw = JSON.parse(readFileSync(PROFILES_PATH, "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

function writeProfiles(map) {
  const tmp = `${PROFILES_PATH}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(map, null, 2) + "\n", { mode: 0o644 });
  renameSync(tmp, PROFILES_PATH);
}

/**
 * Persist (or refresh) the profile captured at the OAuth callback.
 * Returns the stored record, or null when the login is unusable.
 */
export function saveProfile({ login, name, avatarUrl }) {
  if (typeof login !== "string" || !GH_LOGIN_RE.test(login)) return null;
  const record = {
    login,
    name: typeof name === "string" && name.trim() ? name.trim().slice(0, MAX_NAME) : null,
    avatarUrl: sanitizeAvatarUrl(avatarUrl),
    updatedAt: new Date().toISOString(),
  };
  const map = readProfiles();
  const prev = map[login.toLowerCase()];
  // Never downgrade a good avatar/name to null on a callback that returned less.
  if (prev) {
    if (!record.name) record.name = prev.name ?? null;
    if (!record.avatarUrl) record.avatarUrl = sanitizeAvatarUrl(prev.avatarUrl);
  }
  map[login.toLowerCase()] = record;
  try {
    writeProfiles(map);
  } catch (e) {
    // Presentation data: never fail a sign-in because the cache is unwritable.
    console.error(`profile save failed for ${login}: ${e?.message ?? e}`);
  }
  return record;
}

/**
 * Look up a profile by GitHub login. Always returns a usable shape:
 * { login, name, avatarUrl } with nulls when unknown.
 */
export function getProfile(login) {
  if (typeof login !== "string" || !GH_LOGIN_RE.test(login)) {
    return { login: null, name: null, avatarUrl: null };
  }
  const rec = readProfiles()[login.toLowerCase()];
  return {
    login,
    name: rec && typeof rec.name === "string" ? rec.name : null,
    avatarUrl: rec ? sanitizeAvatarUrl(rec.avatarUrl) : null,
  };
}

/** Best display name for a login: GitHub name, else @login, else "Account". */
export function displayName(profile) {
  if (profile?.name) return profile.name;
  if (profile?.login) return `@${profile.login}`;
  return "Account";
}
