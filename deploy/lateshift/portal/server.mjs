#!/usr/bin/env node
// LateShift Cloud portal server.
//
// Serves on 127.0.0.1:<PORT> (default 3790) behind the public Caddy gateway.
// Identity comes exclusively from the signed lsc_session cookie minted by the
// GitHub OAuth callback; work history and the admin panel build on that.
//
// SAFETY: never touches the production t3code unit; all systemctl calls go
// through lib/actions.mjs assertSafeUnit(). Refuses to start on port 443 or
// the production local port 3773.

import http from "node:http";
import crypto from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { loadConfig, loadRegistry, resolveIdentity, NAME_RE } from "./lib/registry.mjs";
import * as auth from "./lib/auth.mjs";
import {
  readWorkHistory,
  readCostSince,
  readCostThisMonth,
  readMonthProviderCost,
  readMonthProviderTokenUsage,
  mergeProviderTokenUsage,
  emptyProviderUsageMap,
  stateDbPath,
} from "./lib/history.mjs";
// Pool remaining (provider truth) vs share of consumption (our attribution)
// are two strictly separate things and come from two separate modules on
// purpose. See lib/rateLimits.mjs.
import { readPoolStatus, DEFAULT_SNAPSHOT_DIR } from "./lib/rateLimits.mjs";
import * as actions from "./lib/actions.mjs";
import * as ops from "./lib/ops.mjs";
import * as views from "./views.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf8")).version;

const PORT = Number(process.env.PORT ?? 3790);
if (PORT === 443 || PORT === 3773) {
  console.error(`refusing to start on port ${PORT} (reserved for the production instance)`);
  process.exit(1);
}

const LOGO_PATHS = [
  join(__dirname, "static", "logo.png"),
  "/home/dev/services/lateshift/assets/lateshift-logo.png",
];
const CSRF_COOKIE = "lsc_csrf";

// ---------------------------------------------------------------- helpers

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const idx = part.indexOf("=");
    if (idx > 0) out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function parseForm(body) {
  const out = {};
  for (const [k, v] of new URLSearchParams(body)) out[k] = v;
  return out;
}

function html(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
    ...extraHeaders,
  });
  res.end(body);
}

function redirect(res, location, extraHeaders = {}) {
  res.writeHead(302, { location, ...extraHeaders });
  res.end();
}

function json(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(payload));
}

function csrfOk(cookies, form) {
  const a = cookies[CSRF_COOKIE];
  const b = form.csrf;
  if (typeof a !== "string" || typeof b !== "string" || !a || a.length > 128) return false;
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function ensureCsrf(cookies, res) {
  let token = cookies[CSRF_COOKIE];
  if (!token || !/^[a-f0-9]{32,64}$/.test(token)) {
    token = crypto.randomBytes(24).toString("hex");
    res.setHeader(
      "set-cookie",
      `${CSRF_COOKIE}=${token}; Path=/; SameSite=Strict; HttpOnly; Secure`,
    );
  }
  return token;
}

// ---------------------------------------------------------------- context

function sessionFrom(req, config) {
  const raw = parseCookies(req)[auth.SESSION_COOKIE];
  if (!raw) return null;
  return auth.verifySession(raw, config.sessionSecret);
}

function buildContext(req) {
  const config = loadConfig();
  const users = loadRegistry();
  const session = sessionFrom(req, config);
  const principal = resolveIdentity({ ghLogin: session?.gh ?? null }, { users, config });
  const identity = { login: session?.gh ?? null, name: null, profilePic: null };
  const fwdHost =
    typeof req.headers["x-forwarded-host"] === "string" ? req.headers["x-forwarded-host"] : "";
  const isPublic = fwdHost === "lateshiftcloud.com" || fwdHost.endsWith(".lateshiftcloud.com");
  return { config, users, identity, principal, session, isPublic };
}

const SNAPSHOT_DIR = process.env.LSC_RATE_LIMIT_SNAPSHOT_DIR || DEFAULT_SNAPSHOT_DIR;

/**
 * Month-to-date share of consumption for every registry user.
 *
 * This is OUR attribution from the turn_usage ledger, never provider truth.
 * It is deliberately built for every signed-in user, not just admins: the
 * leaderboard is the social mechanism that makes a shared subscription work,
 * so everyone sees the same table.
 *
 * `share` is a share of the *recorded consumption*, i.e. of each other, not of
 * the provider's pool — we cannot know the pool in token terms, only in the
 * percentages the provider reports separately.
 */
function consumptionLeaderboard(users) {
  const totals = emptyProviderUsageMap();
  const entries = Object.values(users)
    .map((u) => {
      const usage = readMonthProviderTokenUsage(stateDbPath(u.baseDir));
      mergeProviderTokenUsage(totals, usage);
      return { name: u.name, usage };
    })
    .sort((a, b) => b.usage.total.billableTokens - a.usage.total.billableTokens);

  const grand = totals.total.billableTokens;
  return {
    totals,
    // A dollar figure is only meaningful where the provider gave us one. Codex
    // never does, so we track how much of the ledger had a cost at all and the
    // view can say so instead of implying Codex was free.
    costCoverage: {
      claudeRows: totals.claude.costRows,
      codexRows: totals.codex.costRows,
      codexTurns: totals.codex.turns,
    },
    rows: entries.map((e) => ({
      name: e.name,
      billableTokens: e.usage.total.billableTokens,
      share: grand > 0 ? (e.usage.total.billableTokens / grand) * 100 : null,
      turns: e.usage.total.turns,
      claude: e.usage.claude,
      codex: e.usage.codex,
      other: e.usage.other,
      costUsd: e.usage.total.costUsd,
    })),
  };
}

async function dashboardProps(ctx, csrf) {
  const { user } = ctx.principal;
  const dbPath = stateDbPath(user.baseDir);
  return {
    // Provider truth: what is left in the shared pool. Never derived from
    // turn_usage, never estimated when absent.
    pool: readPoolStatus(SNAPSHOT_DIR),
    // Our attribution: who consumed what. Visible to every user.
    consumption: consumptionLeaderboard(ctx.users),
    myUsage: readMonthProviderTokenUsage(dbPath),
    csrf,
    identity: {
      login: ctx.principal.login,
      name: ctx.identity.name,
      profilePic: ctx.identity.profilePic,
    },
    user: {
      name: user.name,
      projectLimit: user.projectLimit,
      admin: user.admin,
    },
    instanceStatus: await actions.instanceStatus(user.name),
    monthCostUsd: readCostThisMonth(dbPath),
    projects: readWorkHistory(dbPath),
    isAdmin: ctx.principal.isAdmin,
    github: githubStatusFor(user),
  };
}

// Workspace GitHub-connection status for a registry user (dashboard + admin).
// { connected: bool, login: string|null } — login is the registry githubLogin.
function githubStatusFor(user) {
  if (!user || !user.baseDir) return { connected: false, login: user?.githubLogin ?? null };
  const st = auth.githubIdentityStatus(user.baseDir);
  return { connected: st.authenticated, login: user.githubLogin ?? st.login ?? null };
}

async function adminProps(ctx, csrf, flash, selectedParam) {
  const adminLogin = ctx.principal.login;
  const adminLower = adminLogin ? adminLogin.toLowerCase() : null;
  const registryUsers = Object.values(ctx.users).sort((a, b) => a.name.localeCompare(b.name));

  const rows = [];
  let totalCost30d = 0;
  let activeCount = 0;

  for (const u of registryUsers) {
    const dbPath = stateDbPath(u.baseDir);
    const status = await actions.instanceStatus(u.name);
    if (status === "active") activeCount += 1;
    const cost30d = readCostSince(dbPath, 30);
    if (cost30d != null) totalCost30d += cost30d;
    const monthProv = readMonthProviderCost(dbPath);

    const isSelf = Boolean(
      u.githubLogin && adminLower && u.githubLogin.toLowerCase() === adminLower,
    );
    rows.push({
      name: u.name,
      localPort: u.localPort,
      projectLimit: u.projectLimit,
      admin: u.admin,
      instanceStatus: status,
      cost30dUsd: cost30d,
      monthCostUsd: readCostThisMonth(dbPath),
      monthProviderCost: monthProv,
      github: githubStatusFor(u),
      isSelf,
    });
  }

  const selfRow = rows.find((r) => r.isSelf) || null;
  const self = {
    present: Boolean(selfRow),
    name: selfRow ? selfRow.name : null,
    login: adminLogin,
  };

  // Selection: a registry user name, or "@self" for the admin's own account.
  const SELF_KEY = "@self";
  let selectedKey;
  if (selectedParam && selectedParam in ctx.users) selectedKey = selectedParam;
  else if (selectedParam === SELF_KEY) selectedKey = SELF_KEY;
  else selectedKey = self.present ? self.name : SELF_KEY;

  return {
    csrf,
    identity: {
      login: ctx.principal.login,
      name: ctx.identity.name,
      profilePic: ctx.identity.profilePic,
    },
    users: rows,
    self,
    selectedKey,
    pool: readPoolStatus(SNAPSHOT_DIR),
    consumption: consumptionLeaderboard(ctx.users),
    aggregate: {
      totalCost30dUsd: totalCost30d,
      userCount: rows.length,
      activeCount,
    },
    flash: flash || null,
    pending: auth.readPending().pending,
  };
}

// ---------------------------------------------------------------- routes

// ---------------------------------------------------------------- auth routes

// GET /authz — loopback-only authorization endpoint for the public gateway.
// Contract: request carries the forwarded Cookie and X-Authz-Host: <public
// hostname>. Apex host → 200 (portal self-auths). Subdomain label must match a
// registry user AND the session must resolve to that user (or an admin) → 200
// + X-Lsc-User. Label "prod" → admins only. No/invalid session → 401 +
// X-Authz-Redirect. Valid session, wrong user → 403.
async function handleAuthz(req, res) {
  const config = loadConfig();
  const users = loadRegistry();

  const rawHost = req.headers["x-authz-host"];
  const host =
    typeof rawHost === "string"
      ? rawHost.split(",")[0].trim().toLowerCase().replace(/:\d+$/, "")
      : "";
  const apex = config.publicBaseUrl
    ? new URL(config.publicBaseUrl).host.toLowerCase()
    : "lateshiftcloud.com";
  const loginUrl = `${config.publicBaseUrl || "https://lateshiftcloud.com"}/auth/github/login`;

  const done = (status, headers = {}) => {
    res.writeHead(status, headers);
    res.end();
  };

  if (!host) return done(400);
  if (host === apex) return done(200); // portal handles its own auth
  if (!host.endsWith(`.${apex}`)) return done(404);
  const label = host.slice(0, host.length - apex.length - 1);
  if (!label || label.includes(".")) return done(404); // single-label only

  const session = auth.verifySession(parseCookies(req)[auth.SESSION_COOKIE], config.sessionSecret);
  if (!session) return done(401, { "x-authz-redirect": loginUrl });
  const principal = resolveIdentity({ ghLogin: session.gh }, { users, config });

  if (label === "prod") {
    if (principal.isAdmin)
      return done(200, { "x-lsc-user": principal.user?.name || principal.login });
    return done(403);
  }
  const target = users[label];
  if (!target) return done(404);
  if (principal.isAdmin) return done(200, { "x-lsc-user": target.name });
  if (principal.user && principal.user.name === target.name) {
    return done(200, { "x-lsc-user": target.name });
  }
  return done(403);
}

// GET /auth/github/login — 302 to GitHub's authorize endpoint.
async function handleGithubLogin(req, res) {
  const config = loadConfig();
  if (!config.githubClientId || !config.sessionSecret || !config.publicBaseUrl) {
    html(
      res,
      503,
      views.renderMessage({
        title: "Unavailable",
        heading: "GitHub sign-in not configured",
        bodyHtml: "<p>OAuth is not configured on this server.</p>",
        backHref: "/",
        error: true,
      }),
    );
    return;
  }
  const { state, cookie } = auth.makeOAuthState(config.sessionSecret);
  redirect(res, auth.githubAuthorizeUrl(config, state), { "set-cookie": cookie });
}

// GET /auth/github/callback — verify state, exchange code, mint session.
async function handleGithubCallback(req, res, url) {
  const config = loadConfig();
  const users = loadRegistry();
  const cookies = parseCookies(req);
  const fail = (heading, detail) =>
    html(
      res,
      400,
      views.renderMessage({
        title: "Sign-in failed",
        heading,
        bodyHtml: `<p>${views.esc(detail)}</p>`,
        backHref: "/",
        error: true,
      }),
      { "set-cookie": auth.clearStateCookie() },
    );

  if (!config.githubClientId || !config.sessionSecret) {
    return fail("Not configured", "GitHub sign-in is not configured.");
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code) return fail("Missing code", "No authorization code was returned.");
  if (!auth.verifyOAuthState(state, cookies[auth.STATE_COOKIE], config.sessionSecret)) {
    return fail("Invalid state", "The OAuth state check failed. Please try signing in again.");
  }

  let profile;
  try {
    profile = await auth.githubExchange(config, code);
  } catch (e) {
    return fail("GitHub error", e?.message ?? String(e));
  }

  const principal = resolveIdentity({ ghLogin: profile.login }, { users, config });
  const sessionValue = auth.signSession(
    auth.makeSessionPayload(profile.login),
    config.sessionSecret,
  );
  const setCookie = [
    auth.clearStateCookie(),
    auth.sessionCookie(sessionValue, req, config, { maxAgeS: 7 * 24 * 3600 }),
  ];

  if (principal.user) {
    // Known user: install the OAuth token into their workspace gh store the
    // first time (or if their store isn't authenticated yet — the re-auth
    // path). Never overwrite an already-connected store; never log the token.
    try {
      const status = auth.githubIdentityStatus(principal.user.baseDir);
      if (!status.authenticated) {
        auth.installGithubIdentity(principal.user.baseDir, {
          login: profile.login,
          id: profile.id,
          token: profile.token,
        });
      }
    } catch (e) {
      // Sign-in must never break on identity-install failure.
      console.error(`identity install failed for ${principal.user.name}: ${e?.message ?? e}`);
    }
    res.writeHead(302, { location: "/", "set-cookie": setCookie });
    res.end();
    return;
  }
  if (principal.isAdmin) {
    res.writeHead(302, { location: "/admin", "set-cookie": setCookie });
    res.end();
    return;
  }
  // Unknown login → record a pending request (deduped, denied list honoured)
  // and optionally notify by email; then render an awaiting-approval page.
  const result = auth.addPending({
    login: profile.login,
    name: profile.name,
    avatar: profile.avatar_url,
  });
  // Stash the captured token (unless the login was denied) so provisioning can
  // install it into the workspace immediately after admin approval. Refreshed
  // on every repeat sign-in while still pending. Never logged.
  if (result.reason !== "denied") {
    auth.setPendingToken(profile.login, { id: profile.id, token: profile.token });
  }
  html(
    res,
    200,
    views.renderAwaitingApproval({
      login: profile.login,
      name: profile.name,
      avatar: profile.avatar_url,
      denied: result.reason === "denied",
    }),
    { "set-cookie": setCookie },
  );
}

async function handleGet(req, res, url) {
  const cookies = parseCookies(req);

  if (url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "lateshift-portal", version: VERSION }));
    return;
  }

  if (url.pathname === "/static/logo.png" || url.pathname === "/favicon.ico") {
    for (const p of LOGO_PATHS) {
      if (existsSync(p)) {
        res.writeHead(200, {
          "content-type": "image/png",
          "cache-control": "public, max-age=86400",
        });
        res.end(readFileSync(p));
        return;
      }
    }
    res.writeHead(404).end();
    return;
  }

  if (url.pathname === "/authz") return handleAuthz(req, res);
  if (url.pathname === "/auth/github/login") return handleGithubLogin(req, res);
  if (url.pathname === "/auth/github/callback") return handleGithubCallback(req, res, url);
  if (url.pathname === "/auth/logout") {
    const config = loadConfig();
    res.writeHead(302, { location: "/", "set-cookie": auth.clearSessionCookies(req, config) });
    res.end();
    return;
  }

  const ctx = buildContext(req);
  const csrf = ensureCsrf(cookies, res);

  if (url.pathname === "/") {
    if (!ctx.principal.user && !ctx.principal.isAdmin) {
      html(
        res,
        200,
        views.renderHero({
          identityLogin: ctx.principal.login,
          githubEnabled: Boolean(ctx.config.githubClientId && ctx.config.publicBaseUrl),
        }),
      );
      return;
    }
    if (!ctx.principal.user && ctx.principal.isAdmin) {
      // Admin without their own workspace: send them to the panel.
      redirect(res, "/admin");
      return;
    }
    html(res, 200, views.renderDashboard(await dashboardProps(ctx, csrf)));
    return;
  }

  if (url.pathname === "/admin") {
    if (!ctx.principal.isAdmin) {
      html(res, 403, views.renderForbidden({ identity: { login: ctx.principal.login } }));
      return;
    }
    const flash = url.searchParams.get("flash")?.slice(0, 300) ?? null;
    const selectedParam = url.searchParams.get("u")?.slice(0, 40) ?? null;
    html(res, 200, views.renderAdmin(await adminProps(ctx, csrf, flash, selectedParam)));
    return;
  }

  html(
    res,
    404,
    views.renderMessage({
      title: "Not found",
      heading: "404 — Not found",
      bodyHtml: "<p>That page does not exist.</p>",
      backHref: "/",
      error: true,
    }),
  );
}

// POST /internal/ops/<action> - the guarded ops broker (see lib/ops.mjs).
// Loopback-only, CSRF-EXEMPT machine RPC like /internal/roblox-create: auth is
// the X-Ops-Token bearer secret (constant-time compared in ops.checkAuth), and
// any X-Forwarded-Host request is rejected so the public gateway can never
// reach it. Never touches production (t3code.service / 3773 / 443).
async function handleOps(req, res, url) {
  const gate = ops.checkAuth(req);
  if (!gate.ok) {
    json(res, gate.status, { ok: false, detail: gate.detail });
    return;
  }
  let body;
  try {
    body = JSON.parse(await readBody(req, 64 * 1024));
  } catch {
    json(res, 400, { ok: false, detail: "invalid JSON body" });
    return;
  }
  if (!body || typeof body !== "object") {
    json(res, 400, { ok: false, detail: "body must be a JSON object" });
    return;
  }
  const action = url.pathname.slice("/internal/ops/".length);
  const { status, payload } = await ops.handleOps(action, body);
  json(res, status, payload);
}

// POST /internal/roblox-create — loopback-only machine broker that performs the
// entire privileged, keyless Roblox project creation on behalf of a sandboxed
// instance. It is intentionally CSRF-EXEMPT: it is not a browser form endpoint
// (no cookies, no ambient authority) but a JSON RPC the local t3code server
// calls over 127.0.0.1; a CSRF token would be meaningless machine-to-machine.
// Defense instead comes from (a) the portal binding only 127.0.0.1 and (b) the
// explicit rejection below of anything bearing X-Forwarded-Host, so no request
// proxied in via the public Tailscale/gateway path can ever reach it.
async function handleRobloxCreate(req, res) {
  if (req.headers["x-forwarded-host"] !== undefined) {
    json(res, 403, { ok: false, stage: "validate", detail: "forwarded requests are not accepted" });
    return;
  }
  let body;
  try {
    body = JSON.parse(await readBody(req, 32 * 1024));
  } catch {
    json(res, 400, { ok: false, stage: "validate", detail: "invalid JSON body" });
    return;
  }
  if (!body || typeof body !== "object") {
    json(res, 400, { ok: false, stage: "validate", detail: "body must be a JSON object" });
    return;
  }
  let result;
  try {
    result = await actions.createRobloxProject({
      name: body.name,
      robloxJson: body.robloxJson,
      targetDir: body.targetDir,
      shareWithStaff: body.shareWithStaff === true,
    });
  } catch (err) {
    json(res, 500, { ok: false, stage: "wire", detail: String(err?.message ?? err) });
    return;
  }
  // Clean HTTP status for validation failures; 200 for everything else so the
  // caller reads the typed stage/detail out of the body uniformly.
  const status = result.ok === false && result.stage === "validate" ? 400 : 200;
  json(res, status, result);
}

async function handlePost(req, res, url) {
  // Machine broker endpoint — handled before any CSRF/form logic (see
  // handleRobloxCreate for the CSRF-exemption and X-Forwarded-Host rejection).
  if (url.pathname.startsWith("/internal/ops/")) {
    return handleOps(req, res, url);
  }
  if (url.pathname === "/internal/roblox-create") {
    return handleRobloxCreate(req, res);
  }

  const cookies = parseCookies(req);
  const ctx = buildContext(req);
  const form = parseForm(await readBody(req));

  if (!csrfOk(cookies, form)) {
    html(
      res,
      403,
      views.renderMessage({
        title: "Rejected",
        heading: "Request rejected",
        bodyHtml: "<p>Missing or invalid CSRF token. Go back and retry.</p>",
        backHref: "/",
        error: true,
      }),
    );
    return;
  }
  const csrf = cookies[CSRF_COOKIE];

  // ---- admin actions ---------------------------------------------------
  if (!url.pathname.startsWith("/admin/")) {
    html(
      res,
      404,
      views.renderMessage({
        title: "Not found",
        heading: "404 — Not found",
        bodyHtml: "<p>Unknown action.</p>",
        backHref: "/",
        error: true,
      }),
    );
    return;
  }
  if (!ctx.principal.isAdmin) {
    html(res, 403, views.renderForbidden({ identity: { login: ctx.principal.login } }));
    return;
  }

  const name = typeof form.name === "string" ? form.name.trim() : "";
  const validName = NAME_RE.test(name);
  // Redirect back to the acted-on user's detail (preserving selection) + flash.
  const flashTo = (msg) =>
    redirect(
      res,
      `/admin?${validName ? `u=${encodeURIComponent(name)}&` : ""}flash=${encodeURIComponent(msg)}`,
    );
  const errPage = (heading, detail) =>
    html(
      res,
      500,
      views.renderMessage({
        title: "Error",
        heading,
        bodyHtml: `<pre>${views.esc(detail || "unknown error")}</pre>`,
        backHref: "/admin",
        error: true,
      }),
    );

  try {
    switch (url.pathname) {
      case "/admin/add-user": {
        if (!validName) return errPage("Invalid user name", "Names must match [a-z0-9-]{2,20}.");
        const limit = actions.assertLimit(form.projectLimit ?? 3);
        const r = await actions.addUser({ name, projectLimit: limit });
        if (!r.ok) return errPage(`Provisioning '${name}' failed`, r.stderr || r.stdout);
        return flashTo(`User '${name}' provisioned.`);
      }

      case "/admin/set-limit": {
        if (!validName || !(name in ctx.users)) return errPage("Unknown user", name);
        const limit = actions.assertLimit(form.limit);
        if (form.confirm !== "1") {
          // Two-step: applying a limit restarts the user's instance.
          html(
            res,
            200,
            views.renderConfirm({
              csrf,
              title: "Confirm limit change",
              heading: `Change project limit for '${name}' to ${limit}?`,
              detailHtml:
                `This updates <code>instance.env</code> and <strong>restarts ` +
                `t3code@${views.esc(name)}</strong>. Any in-flight work on that ` +
                `instance will be interrupted for a few seconds.`,
              action: "/admin/set-limit",
              fields: [
                { name: "name", value: name },
                { name: "limit", value: String(limit) },
              ],
              confirmLabel: "Apply and restart",
              danger: false,
            }),
          );
          return;
        }
        const s = await actions.setUserField(name, "projectLimit", limit);
        if (!s.ok) return errPage("Setting limit failed", s.stderr || s.stdout);
        const r = await actions.restartInstance(name);
        if (!r.ok) return errPage("Limit saved but restart failed", r.stderr || r.stdout);
        return flashTo(`Limit for '${name}' set to ${limit}; instance restarted.`);
      }

      case "/admin/toggle-admin": {
        if (!validName || !(name in ctx.users)) return errPage("Unknown user", name);
        const next = ctx.users[name].admin ? "false" : "true";
        const s = await actions.setUserField(name, "admin", next);
        if (!s.ok) return errPage("Toggle failed", s.stderr || s.stdout);
        return flashTo(`admin flag for '${name}' is now ${next}.`);
      }

      case "/admin/remove-user": {
        if (!validName || !(name in ctx.users)) return errPage("Unknown user", name);
        if (form.confirm !== "1") {
          html(
            res,
            200,
            views.renderConfirm({
              csrf,
              title: "Confirm removal",
              heading: `Remove user '${name}'?`,
              detailHtml:
                `This stops <code>t3code@${views.esc(name)}</code> and archives ` +
                `its data (never deleted).`,
              action: "/admin/remove-user",
              fields: [{ name: "name", value: name }],
              confirmLabel: "Remove user",
              danger: true,
            }),
          );
          return;
        }
        const force = form.force === "1";
        const r = await actions.removeUser(name, { force });
        if (!r.ok) {
          // Surface --force ONLY after a normal remove failed.
          html(
            res,
            500,
            views.renderConfirm({
              csrf,
              title: "Removal failed",
              heading: `Normal removal of '${name}' failed`,
              detailHtml:
                `<pre>${views.esc((r.stderr || r.stdout).slice(0, 2000))}</pre>` +
                `You can retry with <code>--force</code>, which skips the failing ` +
                `stop/cleanup steps.`,
              action: "/admin/remove-user",
              fields: [
                { name: "name", value: name },
                { name: "force", value: "1" },
              ],
              confirmLabel: "Force remove",
              danger: true,
            }),
          );
          return;
        }
        return redirect(
          res,
          `/admin?flash=${encodeURIComponent(`User '${name}' removed (data archived).`)}`,
        );
      }

      case "/admin/approve": {
        const login = typeof form.login === "string" ? form.login.trim() : "";
        if (!auth.GH_LOGIN_RE.test(login))
          return errPage("Invalid GitHub login", login || "(empty)");
        if (!validName) return errPage("Invalid user name", "Names must match [a-z0-9-]{2,20}.");
        const limit = actions.assertLimit(form.projectLimit ?? 3);
        const r = await actions.addUser({ name, projectLimit: limit });
        if (!r.ok) return errPage(`Provisioning '${name}' failed`, r.stderr || r.stdout);
        const g = await actions.setGithubLogin(name, login);
        auth.removePending(login);
        // Install the token captured at sign-in into the freshly-created
        // workspace, then discard it from the pending-tokens store.
        let ghNote = "";
        const captured = auth.getPendingToken(login);
        if (captured && captured.token) {
          try {
            const fresh = loadRegistry()[name];
            const baseDir = fresh?.baseDir || `/home/dev/services/lateshift/users/${name}`;
            auth.installGithubIdentity(baseDir, { login, id: captured.id, token: captured.token });
            ghNote = " GitHub token installed.";
          } catch (e) {
            ghNote = ` (GitHub token install failed: ${String(e?.message ?? e).slice(0, 120)})`;
          }
        } else {
          ghNote = " (no captured token — user must sign in again to connect GitHub).";
        }
        auth.removePendingToken(login);
        if (!g.ok) {
          return flashTo(
            `User '${name}' provisioned, but githubLogin could NOT be set (t3user rejected it): ` +
              (g.stderr || g.stdout).slice(0, 160),
          );
        }
        return flashTo(`Approved ${login} as '${name}' (githubLogin set).${ghNote}`);
      }

      case "/admin/deny": {
        const login = typeof form.login === "string" ? form.login.trim() : "";
        if (!auth.GH_LOGIN_RE.test(login))
          return errPage("Invalid GitHub login", login || "(empty)");
        auth.denyPending(login);
        auth.removePendingToken(login);
        return flashTo(`Denied access request from ${login}.`);
      }

      default:
        return errPage("Unknown action", url.pathname);
    }
  } catch (err) {
    return errPage("Action failed", err?.message ?? String(err));
  }
}

// ---------------------------------------------------------------- server

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://portal.local");
    if (req.method === "GET" || req.method === "HEAD") {
      await handleGet(req, res, url);
    } else if (req.method === "POST") {
      await handlePost(req, res, url);
    } else {
      res.writeHead(405, { allow: "GET, POST" }).end();
    }
  } catch (err) {
    console.error("request error:", err);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "text/plain" });
    }
    res.end("internal error");
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`lateshift-portal v${VERSION} listening on 127.0.0.1:${PORT}`);
});
