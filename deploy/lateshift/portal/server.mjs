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
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { loadConfig, loadRegistry, resolveIdentity, NAME_RE } from "./lib/registry.mjs";
import { readWorkHistory, readUsageSummary, readCostSince, stateDbPath } from "./lib/history.mjs";
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

function buildContext(req) {
  const config = loadConfig();
  const users = loadRegistry();
  const rawIdentity = identityFrom(req);
  const principal = resolveIdentity(rawIdentity.login, { users, config });
  return { config, users, identity: rawIdentity, principal };
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
    },
    instanceStatus: await actions.instanceStatus(user.name),
    projects: readWorkHistory(dbPath),
    usage: readUsageSummary(dbPath),
    isAdmin: ctx.principal.isAdmin,
  };
}

async function adminProps(ctx, csrf, flash) {
  const users = Object.values(ctx.users).sort((a, b) => a.name.localeCompare(b.name));
  const rows = [];
  let totalCost30d = 0;
  let activeCount = 0;
  for (const u of users) {
    const status = await actions.instanceStatus(u.name);
    if (status === "active") activeCount += 1;
    const cost30d = readCostSince(stateDbPath(u.baseDir), 30);
    if (cost30d != null) totalCost30d += cost30d;
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
    });
  }
  return {
    csrf,
    identity: {
      login: ctx.principal.login,
      name: ctx.identity.name,
      profilePic: ctx.identity.profilePic,
    },
    users: rows,
    aggregate: {
      totalCost30dUsd: totalCost30d,
      userCount: rows.length,
      activeCount,
    },
    flash: flash || null,
  };
}

// ---------------------------------------------------------------- routes

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

  const ctx = buildContext(req);
  const csrf = ensureCsrf(cookies, res);

  if (url.pathname === "/") {
    if (!ctx.principal.user && !ctx.principal.isAdmin) {
      html(res, 200, views.renderHero({ identityLogin: ctx.principal.login }));
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
    html(res, 200, views.renderAdmin(await adminProps(ctx, csrf, flash)));
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

async function handlePost(req, res, url) {
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
    const r = await actions.mintUserPairing(user.name);
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

  const name = typeof form.name === "string" ? form.name.trim() : "";
  const validName = NAME_RE.test(name);
  const flashTo = (msg) => redirect(res, `/admin?flash=${encodeURIComponent(msg)}`);
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

      case "/admin/toggle-shared": {
        if (!validName || !(name in ctx.users)) return errPage("Unknown user", name);
        const next = ctx.users[name].sharedAccess ? "false" : "true";
        const s = await actions.setUserField(name, "sharedAccess", next);
        if (!s.ok) return errPage("Toggle failed", s.stderr || s.stdout);
        return flashTo(`sharedAccess for '${name}' is now ${next}.`);
      }

      case "/admin/pair": {
        if (!validName || !(name in ctx.users)) return errPage("Unknown user", name);
        const r = await actions.mintUserPairing(name, "1h");
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
        return flashTo(`User '${name}' removed (data archived).`);
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
