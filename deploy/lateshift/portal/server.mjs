#!/usr/bin/env node
// LateShift Cloud portal server.
//
// Serves on 127.0.0.1:<PORT> (default 3790) behind Tailscale Serve, which
// injects the caller's tailnet identity as Tailscale-User-Login /
// Tailscale-User-Name / Tailscale-User-Profile-Pic headers. Identity mapping,
// work history, workspace pairing and the admin panel all build on that.
//
// SAFETY: never touches the production t3code unit; all systemctl calls go
// through lib/actions.mjs assertSafeUnit(). Refuses to start on port 443 or
// the production local port 3773.

import http from "node:http";
import crypto from "node:crypto";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { loadConfig, loadRegistry, resolveIdentity, NAME_RE } from "./lib/registry.mjs";
import * as auth from "./lib/auth.mjs";
import {
  readWorkHistory,
  readUsageSummary,
  readCostSince,
  readCostThisMonth,
  readBudgetPaused,
  readMonthProviderCost,
  readProviderTurns,
  computeProviderWindows,
  stateDbPath,
} from "./lib/history.mjs";
import * as actions from "./lib/actions.mjs";
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

// The single share root. Directories directly under it are the universe of
// shareable projects; grants (registry sharedProjects) are absolute paths here.
const SHARED_ROOT = "/home/dev/shared";
const SHARE_DIR_RE = /^[A-Za-z0-9._-]+$/;

// ---------------------------------------------------------------- helpers

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const idx = part.indexOf("=");
    if (idx > 0) out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}

function identityFrom(req) {
  // Only meaningful when the request came through Tailscale Serve. Direct
  // 127.0.0.1 requests can forge these headers — accepted risk on this
  // single-admin box (see README).
  const login = req.headers["tailscale-user-login"];
  return {
    login: typeof login === "string" && login.length <= 256 ? login : null,
    name:
      typeof req.headers["tailscale-user-name"] === "string"
        ? req.headers["tailscale-user-name"]
        : null,
    profilePic:
      typeof req.headers["tailscale-user-profile-pic"] === "string"
        ? req.headers["tailscale-user-profile-pic"]
        : null,
  };
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

/** Directories directly under the share root, as {name, path}. */
function listSharedDirs() {
  try {
    return readdirSync(SHARED_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith(".") && SHARE_DIR_RE.test(d.name))
      .map((d) => ({ name: d.name, path: `${SHARED_ROOT}/${d.name}` }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
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
  const tsIdentity = identityFrom(req);
  // Tailnet identity wins when present (unchanged tailnet behaviour); the
  // signed GitHub session cookie only applies on the public path.
  const session = tsIdentity.login ? null : sessionFrom(req, config);
  const principal = resolveIdentity(
    { tsLogin: tsIdentity.login, ghLogin: session?.gh ?? null },
    { users, config },
  );
  const identity = tsIdentity.login
    ? tsIdentity
    : { login: session?.gh ?? null, name: null, profilePic: null };
  const fwdHost =
    typeof req.headers["x-forwarded-host"] === "string" ? req.headers["x-forwarded-host"] : "";
  const isPublic = fwdHost === "lateshiftcloud.com" || fwdHost.endsWith(".lateshiftcloud.com");
  return { config, users, identity, principal, session, isPublic };
}

async function dashboardProps(ctx, csrf) {
  const { user } = ctx.principal;
  const dbPath = stateDbPath(user.baseDir);
  return {
    csrf,
    identity: {
      login: ctx.principal.login,
      name: ctx.identity.name,
      profilePic: ctx.identity.profilePic,
    },
    user: {
      name: user.name,
      projectLimit: user.projectLimit,
      sharedAccess: user.sharedAccess,
      admin: user.admin,
      monthlyBudgetUsd: user.monthlyBudgetUsd,
      sharedProjects: user.sharedProjects,
    },
    instanceStatus: await actions.instanceStatus(user.name),
    budgetPaused: readBudgetPaused(user.baseDir),
    monthCostUsd: readCostThisMonth(dbPath),
    projects: readWorkHistory(dbPath),
    usage: readUsageSummary(dbPath),
    isAdmin: ctx.principal.isAdmin,
  };
}

async function adminProps(ctx, csrf, flash, selectedParam) {
  const adminLogin = ctx.principal.login;
  const adminLower = adminLogin ? adminLogin.toLowerCase() : null;
  const registryUsers = Object.values(ctx.users).sort((a, b) => a.name.localeCompare(b.name));

  const rows = [];
  const leaderboard = [];
  const subTotals = { claude: 0, codex: 0, other: 0, total: 0 };
  let totalCost30d = 0;
  let activeCount = 0;
  let allTurns = [];
  // 7d lookback is more than enough to locate the current 5h window anchor.
  const windowSince = new Date(Date.now() - 7 * 86400_000).toISOString();

  for (const u of registryUsers) {
    const dbPath = stateDbPath(u.baseDir);
    const status = await actions.instanceStatus(u.name);
    if (status === "active") activeCount += 1;
    const cost30d = readCostSince(dbPath, 30);
    if (cost30d != null) totalCost30d += cost30d;
    const monthProv = readMonthProviderCost(dbPath);
    subTotals.claude += monthProv.claude;
    subTotals.codex += monthProv.codex;
    subTotals.other += monthProv.other;
    subTotals.total += monthProv.total;
    allTurns = allTurns.concat(readProviderTurns(dbPath, windowSince));

    const isSelf = Boolean(u.tsLogin && adminLower && u.tsLogin.toLowerCase() === adminLower);
    rows.push({
      name: u.name,
      tsLogin: u.tsLogin,
      localPort: u.localPort,
      tsPort: u.tsPort,
      projectLimit: u.projectLimit,
      sharedAccess: u.sharedAccess,
      admin: u.admin,
      instanceStatus: status,
      cost30dUsd: cost30d,
      monthlyBudgetUsd: u.monthlyBudgetUsd,
      monthCostUsd: readCostThisMonth(dbPath),
      budgetPaused: readBudgetPaused(u.baseDir),
      sharedProjects: u.sharedProjects,
      monthProviderCost: monthProv,
      isSelf,
    });
    leaderboard.push({
      name: u.name,
      total: monthProv.total,
      claude: monthProv.claude,
      codex: monthProv.codex,
      other: monthProv.other,
    });
  }

  leaderboard.sort((a, b) => b.total - a.total);
  const windows = computeProviderWindows(allTurns);

  const selfRow = rows.find((r) => r.isSelf) || null;
  const self = {
    present: Boolean(selfRow),
    name: selfRow ? selfRow.name : null,
    login: adminLogin,
    workspaceConfigured: Boolean(ctx.config.sharedWorkspaceUrl),
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
    sharedDirs: listSharedDirs(),
    subscription: {
      totals: subTotals,
      windows,
      limits: ctx.config.subscriptionLimits,
    },
    leaderboard,
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
  if (result.added) auth.notifySignup(config, { login: profile.login, name: profile.name });
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

  // ---- user-facing actions -------------------------------------------
  if (url.pathname === "/open") {
    const user = ctx.principal.user;
    if (!user) {
      html(res, 403, views.renderForbidden({ identity: { login: ctx.principal.login } }));
      return;
    }
    const r = await actions.mintUserPairing(user.name, "15m", { publicHost: ctx.isPublic });
    if (!r.ok) {
      html(
        res,
        502,
        views.renderMessage({
          title: "Error",
          heading: "Could not open workspace",
          bodyHtml: `<p>Pairing failed:</p><pre>${views.esc(r.detail ?? "unknown error")}</pre>`,
          backHref: "/",
          error: true,
        }),
      );
      return;
    }
    redirect(res, r.url);
    return;
  }

  if (url.pathname === "/open-shared") {
    const user = ctx.principal.user;
    if (!user || !user.sharedAccess) {
      html(res, 403, views.renderForbidden({ identity: { login: ctx.principal.login } }));
      return;
    }
    const r = await actions.mintSharedPairing(user.name, ctx.config.sharedWorkspaceUrl);
    if (!r.ok) {
      html(
        res,
        502,
        views.renderMessage({
          title: "Error",
          heading: "Could not open shared workspace",
          bodyHtml: `<p>Pairing failed:</p><pre>${views.esc(r.detail ?? "unknown error")}</pre>`,
          backHref: "/",
          error: true,
        }),
      );
      return;
    }
    redirect(res, r.url);
    return;
  }

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

  // Admin opens the shared production workspace (their own "workspace" card).
  // Not keyed by a registry user — uses the admin's own registry name when
  // present, else a static label. No `name` field required.
  if (url.pathname === "/admin/open-workspace") {
    const adminLower = ctx.principal.login ? ctx.principal.login.toLowerCase() : null;
    const selfUser = Object.values(ctx.users).find(
      (u) => u.tsLogin && adminLower && u.tsLogin.toLowerCase() === adminLower,
    );
    // Default: the admin's OWN instance when they have one; production only
    // when explicitly requested (shared=1) or when no own workspace exists.
    if (selfUser && form.shared !== "1") {
      const own = await actions.mintUserPairing(selfUser.name, "15m", { publicHost: ctx.isPublic });
      if (own.ok) {
        redirect(res, own.url);
        return;
      }
      // fall through to the shared workspace on pairing failure
    }
    const label = selfUser ? selfUser.name : "admin";
    const r = await actions.mintSharedPairing(label, ctx.config.sharedWorkspaceUrl);
    if (!r.ok) {
      html(
        res,
        502,
        views.renderMessage({
          title: "Error",
          heading: "Could not open workspace",
          bodyHtml: `<p>Pairing failed:</p><pre>${views.esc(r.detail ?? "unknown error")}</pre>`,
          backHref: "/admin",
          error: true,
        }),
      );
      return;
    }
    redirect(res, r.url);
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
        const tsLogin = form.tsLogin ? actions.assertTsLogin(form.tsLogin.trim()) : null;
        const r = await actions.addUser({ name, tsLogin, projectLimit: limit });
        if (!r.ok) return errPage(`Provisioning '${name}' failed`, r.stderr || r.stdout);
        if (form.sharedAccess === "on" || form.sharedAccess === "true") {
          const s = await actions.setUserField(name, "sharedAccess", "true");
          if (!s.ok) return errPage(`User created but sharedAccess failed`, s.stderr || s.stdout);
        }
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

      case "/admin/set-budget": {
        if (!validName || !(name in ctx.users)) return errPage("Unknown user", name);
        const budget = actions.assertBudget(form.budget);
        const s = await actions.setUserField(name, "monthlyBudgetUsd", budget);
        if (!s.ok) return errPage("Setting budget failed", s.stderr || s.stdout);
        return flashTo(
          budget === 0
            ? `Budget for '${name}' removed (unlimited).`
            : `Budget for '${name}' set to $${budget}/month (enforced within ~10 min).`,
        );
      }

      case "/admin/set-tslogin": {
        if (!validName || !(name in ctx.users)) return errPage("Unknown user", name);
        const login = (form.tsLogin ?? "").trim();
        if (!login) return errPage("Invalid tailnet login", "Tailnet login cannot be empty.");
        const s = await actions.setUserField(name, "tsLogin", login);
        if (!s.ok) return errPage("Setting tailnet login failed", s.stderr || s.stdout);
        return flashTo(`Tailnet login for '${name}' set to ${login}.`);
      }

      case "/admin/toggle-admin": {
        if (!validName || !(name in ctx.users)) return errPage("Unknown user", name);
        const next = ctx.users[name].admin ? "false" : "true";
        const s = await actions.setUserField(name, "admin", next);
        if (!s.ok) return errPage("Toggle failed", s.stderr || s.stdout);
        return flashTo(`admin flag for '${name}' is now ${next}.`);
      }

      case "/admin/share-project": {
        if (!validName || !(name in ctx.users)) return errPage("Unknown user", name);
        const path = actions.assertSharedPath((form.path ?? "").trim());
        const r = await actions.shareProject(name, path);
        if (!r.ok) return errPage("Sharing failed", r.stderr || r.stdout);
        return flashTo(`Shared '${path}' with '${name}'.`);
      }

      case "/admin/unshare-project": {
        if (!validName || !(name in ctx.users)) return errPage("Unknown user", name);
        const path = actions.assertSharedPath((form.path ?? "").trim());
        const r = await actions.unshareProject(name, path);
        if (!r.ok) return errPage("Unsharing failed", r.stderr || r.stdout);
        return flashTo(`Unshared '${path}' from '${name}'.`);
      }

      case "/admin/toggle-shared": {
        if (!validName || !(name in ctx.users)) return errPage("Unknown user", name);
        const next = ctx.users[name].sharedAccess ? "false" : "true";
        const s = await actions.setUserField(name, "sharedAccess", next);
        if (!s.ok) return errPage("Toggle failed", s.stderr || s.stdout);
        return flashTo(`sharedAccess for '${name}' is now ${next}.`);
      }

      case "/admin/pair": {
        if (!validName || !(name in ctx.users)) return errPage("Unknown user", name);
        const r = await actions.mintUserPairing(name, "1h", { publicHost: ctx.isPublic });
        if (!r.ok) return errPage("Pairing failed", r.detail);
        html(res, 200, views.renderPairResult({ name, url: r.url, backHref: "/admin" }));
        return;
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
                `This stops <code>t3code@${views.esc(name)}</code>, clears its ` +
                `tailnet mapping and archives its data (never deleted).`,
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
        if (!g.ok) {
          return flashTo(
            `User '${name}' provisioned, but githubLogin could NOT be set (t3user rejected it): ` +
              (g.stderr || g.stdout).slice(0, 160),
          );
        }
        return flashTo(`Approved ${login} as '${name}' (githubLogin set).`);
      }

      case "/admin/deny": {
        const login = typeof form.login === "string" ? form.login.trim() : "";
        if (!auth.GH_LOGIN_RE.test(login))
          return errPage("Invalid GitHub login", login || "(empty)");
        auth.denyPending(login);
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
