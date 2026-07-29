// auth.mjs — GitHub OAuth (web flow, no libraries), HMAC-signed session and
// OAuth-state cookies, and the JSON pending-approval store. Zero dependencies;
// all crypto via node:crypto, all outbound HTTP via the Node 24 global fetch.
//
// SECURITY NOTES
//   - Session cookie `lsc_session` is base64url(payload).sig where sig is
//     HMAC-SHA256(sessionSecret, base64url(payload)). Signature checks are
//     constant-time (timingSafeEqual over equal-length HMAC digests).
//   - The OAuth `state` is a signed random nonce stored in a short-lived,
//     HttpOnly cookie; the callback compares the query `state` to the cookie
//     constant-time AND re-verifies the signature.
//   - The portal OWNS pending.json (registry writes still go only through the
//     t3user CLI). Writes here are atomic (temp file + rename).

import crypto from "node:crypto";
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, chmodSync } from "node:fs";

export const PENDING_PATH = "/home/dev/services/lateshift/pending.json";
// Access tokens captured at sign-in for users still awaiting approval, kept
// separate from pending.json (which is admin-facing) so the secret lives in a
// 600 dev-owned file and can be installed into the workspace right after add.
export const PENDING_TOKENS_PATH = "/home/dev/services/lateshift/pending-tokens.json";

export const SESSION_COOKIE = "lsc_session";
export const STATE_COOKIE = "lsc_oauth_state";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const STATE_TTL_S = 600; // 10 minutes
const APEX_SUFFIX = "lateshiftcloud.com";

// GitHub login: 1-39 chars, alphanumeric or single hyphens. We keep the check
// liberal (no leading/trailing/double-hyphen enforcement) but strictly bounded.
export const GH_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

// ---------------------------------------------------------------- base64url

function b64urlEncode(buf) {
  return Buffer.from(buf).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function b64urlDecode(str) {
  const s = String(str).replaceAll("-", "+").replaceAll("_", "/");
  return Buffer.from(s, "base64");
}

function hmac(secret, data) {
  return crypto.createHmac("sha256", secret).update(data).digest();
}

/** Constant-time equality over two strings (hashed to fixed length first). */
function safeStrEq(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ---------------------------------------------------------------- sessions

/** Build a fresh session payload for a GitHub login. */
export function makeSessionPayload(ghLogin) {
  const now = Date.now();
  return { v: 1, gh: String(ghLogin), iat: Math.floor(now / 1000), exp: Math.floor((now + SESSION_TTL_MS) / 1000) };
}

/** Sign a payload object into the cookie value `b64url(payload).b64url(sig)`. */
export function signSession(payload, secret) {
  if (!secret) throw new Error("sessionSecret not configured");
  const body = b64urlEncode(JSON.stringify(payload));
  const sig = b64urlEncode(hmac(secret, body));
  return `${body}.${sig}`;
}

/** Verify a cookie value; returns the payload object or null. */
export function verifySession(cookieValue, secret) {
  if (!secret || typeof cookieValue !== "string") return null;
  const dot = cookieValue.indexOf(".");
  if (dot <= 0) return null;
  const body = cookieValue.slice(0, dot);
  const sig = cookieValue.slice(dot + 1);
  const expected = b64urlEncode(hmac(secret, body));
  // Constant-time compare of equal-length base64url signatures.
  const sb = Buffer.from(sig);
  const eb = Buffer.from(expected);
  if (sb.length !== eb.length || !crypto.timingSafeEqual(sb, eb)) return null;
  let payload;
  try {
    payload = JSON.parse(b64urlDecode(body).toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || payload.v !== 1 || typeof payload.gh !== "string") return null;
  if (typeof payload.exp !== "number" || payload.exp * 1000 < Date.now()) return null;
  if (!GH_LOGIN_RE.test(payload.gh)) return null;
  return payload;
}

// ---------------------------------------------------------------- cookies

/** True when the request arrived via the public host (X-Forwarded-Host apex). */
export function isPublicHost(req) {
  const xfh = req.headers["x-forwarded-host"];
  if (typeof xfh !== "string" || !xfh) return false;
  const host = xfh.split(",")[0].trim().toLowerCase().replace(/:\d+$/, "");
  return host === APEX_SUFFIX || host.endsWith(`.${APEX_SUFFIX}`);
}

/** Assemble a Set-Cookie for the session, choosing Domain by request path. */
export function sessionCookie(value, req, config, { maxAgeS } = {}) {
  const parts = [`${SESSION_COOKIE}=${value}`, "Path=/", "HttpOnly", "Secure", "SameSite=Lax"];
  if (isPublicHost(req) && config.cookieDomain) parts.push(`Domain=${config.cookieDomain}`);
  if (typeof maxAgeS === "number") parts.push(`Max-Age=${maxAgeS}`);
  return parts.join("; ");
}

/** Set-Cookie that clears the session on both the host and the cookie domain. */
export function clearSessionCookies(req, config) {
  const base = `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
  const out = [base];
  if (config.cookieDomain) out.push(`${base}; Domain=${config.cookieDomain}`);
  return out;
}

// ---------------------------------------------------------------- OAuth state

// OAuth intents. The state carries which flow the user consented to, signed,
// so the callback cannot be tricked into treating a bare sign-in as a grant of
// push access (see githubAuthorizeUrl for why the two are separate).
export const INTENT_SIGNIN = "signin";
export const INTENT_CONNECT = "connect";
const INTENTS = new Set([INTENT_SIGNIN, INTENT_CONNECT]);

/**
 * Create a signed OAuth state and its short-lived cookie.
 * State is `${nonce}~${intent}.${sig}` with sig = HMAC(secret, nonce~intent),
 * so the intent is tamper-evident.
 */
export function makeOAuthState(secret, intent = INTENT_SIGNIN) {
  const kind = INTENTS.has(intent) ? intent : INTENT_SIGNIN;
  const nonce = crypto.randomBytes(16).toString("hex");
  const body = `${nonce}~${kind}`;
  const sig = b64urlEncode(hmac(secret || "", body));
  const state = `${body}.${sig}`;
  const cookie = `${STATE_COOKIE}=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${STATE_TTL_S}`;
  return { state, cookie };
}

/** Clear the OAuth state cookie. */
export function clearStateCookie() {
  return `${STATE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/**
 * Verify the callback state against the cookie and its signature.
 * Returns the signed intent ("signin" | "connect") on success, or null.
 * A state minted before intents existed (`nonce.sig`, no `~`) verifies as
 * "signin" so logins already in flight across a deploy are not broken.
 */
export function verifyOAuthState(stateParam, cookieValue, secret) {
  if (typeof stateParam !== "string" || typeof cookieValue !== "string") return null;
  if (!safeStrEq(stateParam, cookieValue)) return null;
  const dot = stateParam.indexOf(".");
  if (dot <= 0) return null;
  const body = stateParam.slice(0, dot);
  const sig = stateParam.slice(dot + 1);
  if (!safeStrEq(sig, b64urlEncode(hmac(secret || "", body)))) return null;
  const tilde = body.indexOf("~");
  if (tilde < 0) return INTENT_SIGNIN; // legacy state, pre-intent
  const intent = body.slice(tilde + 1);
  return INTENTS.has(intent) ? intent : null;
}

// ---------------------------------------------------------------- GitHub flow

// ---- OAuth scopes ---------------------------------------------------------
//
// Sign-in used to request "read:user repo workflow" — a broad repo-WRITE grant
// taken at FIRST CONTACT, from a stranger, before the admin has even seen the
// access request. architecture-v2.md §6 splits it:
//
//   SCOPE_SIGNIN — identity only. Enough to know who you are and show your
//                  avatar; cannot read private code and cannot push.
//   SCOPE_PUSH   — the upgrade, requested separately and only when the user
//                  explicitly clicks "connect push access" on the account page.
//                  `repo` grants git push/pull over HTTPS; `workflow` is
//                  required so pushes touching .github/workflows/** aren't
//                  rejected by GitHub.
//
// Existing installed workspace credentials are untouched: tokens already in a
// workspace's hosts.yml keep their original grant, and installGithubIdentity()
// is only ever called with a token that actually carries `repo` (see
// hasPushScope), so a narrow sign-in token can never overwrite a wide one.
export const SCOPE_SIGNIN = "read:user";
export const SCOPE_PUSH = "read:user repo workflow";

/**
 * Build the github.com authorize URL for the standard web flow.
 * `scope` defaults to identity-only; pass SCOPE_PUSH for the consented upgrade.
 */
export function githubAuthorizeUrl(config, state, scope = SCOPE_SIGNIN) {
  const redirectUri = `${config.publicBaseUrl}/auth/github/callback`;
  const q = new URLSearchParams({
    client_id: config.githubClientId,
    redirect_uri: redirectUri,
    scope,
    state,
    allow_signup: "false",
  });
  return `https://github.com/login/oauth/authorize?${q.toString()}`;
}

/** True when a granted-scope list actually permits git push over HTTPS. */
export function hasPushScope(scopes) {
  const list = Array.isArray(scopes) ? scopes : [];
  return list.includes("repo");
}

/** Exchange the code for an access token, then fetch the user profile. */
export async function githubExchange(config, code) {
  const redirectUri = `${config.publicBaseUrl}/auth/github/callback`;
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: config.githubClientId,
      client_secret: config.githubClientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!tokenRes.ok) throw new Error(`token exchange failed: ${tokenRes.status}`);
  const tokenJson = await tokenRes.json();
  const accessToken = tokenJson.access_token;
  if (!accessToken) throw new Error(`no access_token (${tokenJson.error || "unknown"})`);

  const userRes = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "lateshift-cloud-portal",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!userRes.ok) throw new Error(`user fetch failed: ${userRes.status}`);
  const u = await userRes.json();
  if (!u || typeof u.login !== "string" || !GH_LOGIN_RE.test(u.login)) {
    throw new Error("invalid github login in profile");
  }
  return {
    login: u.login,
    id: Number.isFinite(u.id) ? u.id : null,
    name: typeof u.name === "string" ? u.name : null,
    avatar_url: typeof u.avatar_url === "string" ? u.avatar_url : null,
    // Scopes GitHub actually granted (comma- or space-separated in the token
    // response). Authoritative: the user may have declined part of what we
    // asked for, so never infer the grant from what we requested.
    scopes:
      typeof tokenJson.scope === "string"
        ? tokenJson.scope
            .split(/[,\s]+/)
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
    // Access token for provisioning the per-workspace gh credential store.
    // NEVER log this value; callers install it into hosts.yml then discard it.
    token: accessToken,
  };
}

// ---------------------------------------------------------------- pending store

/** Read the pending store, tolerating absence / corruption. */
export function readPending() {
  try {
    if (!existsSync(PENDING_PATH)) return { pending: [], denied: [] };
    const raw = JSON.parse(readFileSync(PENDING_PATH, "utf8"));
    return {
      pending: Array.isArray(raw.pending) ? raw.pending : [],
      denied: Array.isArray(raw.denied) ? raw.denied : [],
    };
  } catch {
    return { pending: [], denied: [] };
  }
}

function writePending(store) {
  const tmp = `${PENDING_PATH}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, PENDING_PATH);
}

function sameLogin(a, b) {
  return String(a || "").toLowerCase() === String(b || "").toLowerCase();
}

/**
 * Record a sign-in request from an unknown GitHub user. Deduped by login
 * (case-insensitive); denied logins are silently ignored (denied list honored).
 * Returns { added: boolean, reason?: "denied"|"exists" }.
 */
export function addPending({ login, name, avatar }) {
  const store = readPending();
  if (store.denied.some((d) => sameLogin(d.login ?? d, login))) return { added: false, reason: "denied" };
  if (store.pending.some((p) => sameLogin(p.login, login))) return { added: false, reason: "exists" };
  store.pending.push({
    login: String(login),
    name: name ? String(name) : null,
    avatar: avatar ? String(avatar) : null,
    requestedAt: new Date().toISOString(),
  });
  writePending(store);
  return { added: true };
}

/** Remove a login from the pending list (e.g. after approval). */
export function removePending(login) {
  const store = readPending();
  const before = store.pending.length;
  store.pending = store.pending.filter((p) => !sameLogin(p.login, login));
  if (store.pending.length !== before) writePending(store);
  return before - store.pending.length;
}

/** Move a pending login to the denied list. */
export function denyPending(login) {
  const store = readPending();
  const entry = store.pending.find((p) => sameLogin(p.login, login));
  store.pending = store.pending.filter((p) => !sameLogin(p.login, login));
  if (!store.denied.some((d) => sameLogin(d.login ?? d, login))) {
    store.denied.push({ login: String(login), name: entry?.name ?? null, deniedAt: new Date().toISOString() });
  }
  writePending(store);
  return true;
}

// ------------------------------------------------ workspace GitHub identity

/**
 * Resolve the per-workspace identity store paths from a registry baseDir
 * (e.g. /home/dev/services/lateshift/users/<name>). Mirrors the layout set up
 * by bin/run-instance.sh: <base>/identity/{gh/hosts.yml, gitconfig}.
 */
export function identityPaths(baseDir) {
  const dir = `${String(baseDir)}/identity`;
  const ghDir = `${dir}/gh`;
  return { dir, ghDir, hostsPath: `${ghDir}/hosts.yml`, gitconfigPath: `${dir}/gitconfig` };
}

/**
 * Inspect a workspace's gh store. Returns { authenticated, login }.
 * "authenticated" means hosts.yml exists AND carries a non-empty oauth_token
 * (a bare/placeholder store with an empty token counts as NOT authenticated).
 * Never returns or logs the token value.
 */
export function githubIdentityStatus(baseDir) {
  try {
    const { hostsPath } = identityPaths(baseDir);
    if (!existsSync(hostsPath)) return { authenticated: false, login: null };
    const raw = readFileSync(hostsPath, "utf8");
    // Top-level `oauth_token:` under github.com (indented, not under users:).
    const tok = raw.match(/^ {4}oauth_token:[ \t]*(\S.*)$/m);
    const authenticated = Boolean(tok && tok[1] && tok[1].trim().length > 0);
    const userM = raw.match(/^ {4}user:[ \t]*(\S+)\s*$/m);
    return { authenticated, login: userM ? userM[1] : null };
  } catch {
    return { authenticated: false, login: null };
  }
}

// Escape a value for safe inclusion as a YAML scalar (we only ever write
// GitHub logins/tokens which are alphanumerics+`_-`, but stay defensive).
function yamlScalar(v) {
  const s = String(v);
  return /^[A-Za-z0-9._-]+$/.test(s) ? s : JSON.stringify(s);
}

/**
 * Write the GitHub OAuth token into a workspace's gh credential store in gh's
 * expected hosts.yml shape, and stamp the workspace gitconfig author identity.
 * Overwrites unconditionally — callers guard with githubIdentityStatus() so an
 * already-connected store is never clobbered. dir 700 / file 600, dev-owned
 * (the portal runs as dev). NEVER logs the token.
 */
export function installGithubIdentity(baseDir, { login, id, token }) {
  if (!login || !GH_LOGIN_RE.test(login)) throw new Error("invalid github login for identity install");
  if (!token || typeof token !== "string") throw new Error("missing token for identity install");
  const { dir, ghDir, hostsPath, gitconfigPath } = identityPaths(baseDir);
  mkdirSync(ghDir, { recursive: true });
  chmodSync(dir, 0o700);
  chmodSync(ghDir, 0o700);

  const l = yamlScalar(login);
  const t = yamlScalar(token);
  const hosts =
    `github.com:\n` +
    `    user: ${l}\n` +
    `    oauth_token: ${t}\n` +
    `    git_protocol: https\n` +
    `    users:\n` +
    `        ${l}:\n` +
    `            oauth_token: ${t}\n`;
  const tmpHosts = `${hostsPath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmpHosts, hosts, { mode: 0o600 });
  renameSync(tmpHosts, hostsPath);
  chmodSync(hostsPath, 0o600);

  // Stamp author identity: user.name = gh login, user.email = noreply alias.
  const email = id != null ? `${id}+${login}@users.noreply.github.com` : `${login}@users.noreply.github.com`;
  stampGitconfigIdentity(gitconfigPath, login, email);
  return { ok: true };
}

/**
 * Update user.name/user.email in an existing gitconfig's [user] section,
 * preserving the credential-helper blocks. Creates a minimal file if absent.
 */
function stampGitconfigIdentity(gitconfigPath, name, email) {
  let cfg;
  try {
    cfg = existsSync(gitconfigPath) ? readFileSync(gitconfigPath, "utf8") : null;
  } catch {
    cfg = null;
  }
  if (cfg && /\[user\]/.test(cfg)) {
    // Replace name/email lines that live inside the [user] section only.
    cfg = cfg.replace(/(\[user\][^[]*?\n\s*name\s*=)[^\n]*/, `$1 ${name}`);
    cfg = cfg.replace(/(\[user\][^[]*?\n\s*email\s*=)[^\n]*/, `$1 ${email}`);
  } else {
    cfg =
      `[user]\n\tname = ${name}\n\temail = ${email}\n` +
      `[credential "https://github.com"]\n\thelper =\n\thelper = !/usr/bin/gh auth git-credential\n` +
      `[credential "https://gist.github.com"]\n\thelper =\n\thelper = !/usr/bin/gh auth git-credential\n`;
  }
  const tmp = `${gitconfigPath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, cfg, { mode: 0o600 });
  renameSync(tmp, gitconfigPath);
  chmodSync(gitconfigPath, 0o600);
}

// -------------------------------------------- pending access-token store

/** Read the pending-tokens map ({ [loginLower]: {login,id,token,at} }). */
export function readPendingTokens() {
  try {
    if (!existsSync(PENDING_TOKENS_PATH)) return {};
    const raw = JSON.parse(readFileSync(PENDING_TOKENS_PATH, "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function writePendingTokens(map) {
  const tmp = `${PENDING_TOKENS_PATH}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(map, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, PENDING_TOKENS_PATH);
  try {
    chmodSync(PENDING_TOKENS_PATH, 0o600);
  } catch {
    /* best effort */
  }
}

/** Store (or refresh) the captured token for a pending login. Never logs it. */
export function setPendingToken(login, { id, token }) {
  if (!login || !GH_LOGIN_RE.test(login) || !token) return false;
  const map = readPendingTokens();
  map[String(login).toLowerCase()] = {
    login: String(login),
    id: id != null ? Number(id) : null,
    token: String(token),
    at: new Date().toISOString(),
  };
  writePendingTokens(map);
  return true;
}

/** Fetch a captured token for a login (or null). */
export function getPendingToken(login) {
  if (!login) return null;
  const map = readPendingTokens();
  return map[String(login).toLowerCase()] ?? null;
}

/** Delete a captured token (on approve or deny). Returns true if removed. */
export function removePendingToken(login) {
  if (!login) return false;
  const map = readPendingTokens();
  const key = String(login).toLowerCase();
  if (!(key in map)) return false;
  delete map[key];
  writePendingTokens(map);
  return true;
}
