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
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";

export const PENDING_PATH = "/home/dev/services/lateshift/pending.json";

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

/** Create a signed OAuth state and its short-lived cookie. */
export function makeOAuthState(secret) {
  const nonce = crypto.randomBytes(16).toString("hex");
  const sig = b64urlEncode(hmac(secret || "", nonce));
  const state = `${nonce}.${sig}`;
  const cookie = `${STATE_COOKIE}=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${STATE_TTL_S}`;
  return { state, cookie };
}

/** Clear the OAuth state cookie. */
export function clearStateCookie() {
  return `${STATE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/** Verify the callback state against the cookie and its signature. */
export function verifyOAuthState(stateParam, cookieValue, secret) {
  if (typeof stateParam !== "string" || typeof cookieValue !== "string") return false;
  if (!safeStrEq(stateParam, cookieValue)) return false;
  const dot = stateParam.indexOf(".");
  if (dot <= 0) return false;
  const nonce = stateParam.slice(0, dot);
  const sig = stateParam.slice(dot + 1);
  const expected = b64urlEncode(hmac(secret || "", nonce));
  return safeStrEq(sig, expected);
}

// ---------------------------------------------------------------- GitHub flow

/** Build the github.com authorize URL for the standard web flow. */
export function githubAuthorizeUrl(config, state) {
  const redirectUri = `${config.publicBaseUrl}/auth/github/callback`;
  const q = new URLSearchParams({
    client_id: config.githubClientId,
    redirect_uri: redirectUri,
    scope: "read:user",
    state,
    allow_signup: "false",
  });
  return `https://github.com/login/oauth/authorize?${q.toString()}`;
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
    name: typeof u.name === "string" ? u.name : null,
    avatar_url: typeof u.avatar_url === "string" ? u.avatar_url : null,
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

// ---------------------------------------------------------------- notify

/**
 * Fire-and-forget email via Resend when a new signup request lands. Never
 * throws; silently skips when resendApiKey is unconfigured.
 */
export async function notifySignup(config, { login, name }) {
  if (!config.resendApiKey || !config.notifyEmail) return;
  try {
    const safeLogin = String(login);
    const safeName = name ? String(name) : "(no name)";
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "LateShift Cloud <onboarding@resend.dev>",
        to: [config.notifyEmail],
        subject: `LateShift Cloud: access request from ${safeLogin}`,
        text: `A new GitHub user requested access to LateShift Cloud.\n\nLogin: ${safeLogin}\nName: ${safeName}\n\nApprove or deny in the admin panel.`,
      }),
    });
  } catch {
    // Notification failures must never break signup.
  }
}
