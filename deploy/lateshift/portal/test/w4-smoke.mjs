// w4-smoke.mjs — W4 (identity + account UX) assertions. Zero dependencies, no
// host state touched: pure functions and view rendering only.
//
//   node deploy/lateshift/portal/test/w4-smoke.mjs
//
// Exits non-zero on the first failed assertion.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import * as views from "../views.mjs";
import * as auth from "../lib/auth.mjs";
import * as profiles from "../lib/profiles.mjs";
import { p, normalizePath } from "../lib/paths.mjs";

// paths
assert.equal(p("/account"), "/~lsc/account");
assert.deepEqual(normalizePath("/~lsc/account"), { path: "/account", prefixed: true });
assert.deepEqual(normalizePath("/%7Elsc/account"), { path: "/account", prefixed: true });
assert.deepEqual(normalizePath("/~lsc"), { path: "/", prefixed: true });
assert.deepEqual(normalizePath("/admin"), { path: "/admin", prefixed: false });
assert.deepEqual(normalizePath("/internal/ops/status"), { path: "/internal/ops/status", prefixed: false });

// oauth scopes
const cfg = { publicBaseUrl: "https://x.test", githubClientId: "cid" };
assert.ok(auth.githubAuthorizeUrl(cfg, "s").includes("scope=read%3Auser&"));
assert.ok(auth.githubAuthorizeUrl(cfg, "s", auth.SCOPE_PUSH).includes("repo+workflow"));
assert.equal(auth.hasPushScope(["read:user"]), false);
assert.equal(auth.hasPushScope(["read:user", "repo", "workflow"]), true);

// oauth state intent round-trip + tamper
const S = "secret";
for (const intent of [auth.INTENT_SIGNIN, auth.INTENT_CONNECT]) {
  const { state } = auth.makeOAuthState(S, intent);
  assert.equal(auth.verifyOAuthState(state, state, S), intent);
  assert.equal(auth.verifyOAuthState(state, state, "wrong"), null);
  const tampered = state.replace("~" + intent, "~connect") + "";
  if (intent === auth.INTENT_SIGNIN) assert.equal(auth.verifyOAuthState(tampered, tampered, S), null);
  assert.equal(auth.verifyOAuthState(state, state + "x", S), null);
}
// legacy pre-intent state still verifies as signin
const nonce = "abc123";
const legacySig = crypto.createHmac("sha256", S).update(nonce).digest("base64").replaceAll("+","-").replaceAll("/","_").replace(/=+$/,"");
const legacy = `${nonce}.${legacySig}`;
assert.equal(auth.verifyOAuthState(legacy, legacy, S), auth.INTENT_SIGNIN);

// avatar url sanitizing
assert.equal(profiles.sanitizeAvatarUrl("https://avatars.githubusercontent.com/u/1?v=4"), "https://avatars.githubusercontent.com/u/1?v=4");
assert.equal(profiles.sanitizeAvatarUrl("javascript:alert(1)"), null);
assert.equal(profiles.sanitizeAvatarUrl("http://avatars.githubusercontent.com/u/1"), null);
assert.equal(profiles.sanitizeAvatarUrl("https://evil.test/x.png"), null);
assert.equal(profiles.displayName({ login: "octo", name: null }), "@octo");
assert.equal(profiles.displayName({ login: "octo", name: "Octo Cat" }), "Octo Cat");

const identity = { login: "octo", name: "Octo Cat", displayName: "Octo Cat", profilePic: "https://avatars.githubusercontent.com/u/1?v=4" };

// account page
const acct = views.renderAccount({
  csrf: "tok", identity, isAdmin: true, hasWorkspace: true,
  github: { connected: false, login: "octo" },
  memberships: [{ kind: "personal", label: "Personal workspace", detail: "Only you can reach it." }],
  pool: null,
  share: { turns: 12, inputTokens: 100, outputTokens: 20, costUsd: 1.5, monthCostUsd: 1.5, byProvider: {}, sharePct: 42.123 },
  flash: null,
});
assert.ok(acct.includes('href="/~lsc/account"'), "header chip links to account");
assert.ok(acct.includes("Octo Cat"));
assert.ok(acct.includes("avatars.githubusercontent.com"));
assert.ok(acct.includes('referrerpolicy="no-referrer"'));
assert.ok(acct.includes('action="/~lsc/auth/logout"') && acct.includes('name="csrf" value="tok"'), "sign out is a CSRF POST");
assert.ok(acct.includes("Unknown — no rate-limit update"), "pool unknown, not estimated");
assert.ok(acct.includes("42.1%"));
assert.ok(acct.includes("/~lsc/auth/github/connect"));
assert.ok(!acct.includes("viewBox=\"0 0 16 16\""), "no GitHub logo on the account/header surface");

// pool rendering with W3-shaped data
const acct2 = views.renderAccount({
  csrf: "tok", identity, isAdmin: false, hasWorkspace: true,
  github: { connected: true, login: "octo" }, memberships: [],
  pool: { asOf: new Date().toISOString(), providers: [{ provider: "claude", windows: [{ label: "five_hour", utilization: 63, resetsAt: "2026-07-29T20:00:00Z", status: "allowed" }] }] },
  share: null, flash: "GitHub push access connected.",
});
assert.ok(acct2.includes("five_hour") && acct2.includes("63% used") && acct2.includes("2026-07-29T20:00:00Z"));
assert.ok(!acct2.includes("weekly"));

// dashboard: no short name, no server path
const dash = views.renderDashboard({
  csrf: "tok", identity, user: { projectLimit: 3, admin: false },
  workspaceUrl: "https://lateshiftcloud.com/", instanceStatus: "active", monthCostUsd: 1,
  projects: [{ title: "roblox-game", workspaceRoot: "/home/dev/services/lateshift/users/slither/projects/roblox-game", costUsd: 1, threads: [{ title: "t", updatedAt: new Date().toISOString() }] }],
  usage: null, isAdmin: false, github: { connected: true, login: "octo" },
});
assert.ok(dash.includes("Welcome back, Octo"), "greets by display name");
assert.ok(!dash.includes("/home/dev/services/lateshift"), "no absolute server path");
assert.ok(!dash.includes("slither"), "no internal short name");
assert.ok(!dash.includes(".lateshiftcloud.com/\">Open"), "no per-user subdomain");
assert.ok(dash.includes("roblox-game"));

// XSS: hostile display name is escaped
const evil = views.renderAccount({
  csrf: "t", identity: { login: "octo", name: '<img src=x onerror=alert(1)>', displayName: '<img src=x onerror=alert(1)>', profilePic: null },
  isAdmin: false, hasWorkspace: false, github: { connected: false, login: "octo" }, memberships: [], pool: null, share: null, flash: '<script>bad()</script>',
});
assert.ok(!evil.includes("<img src=x"), "display name escaped");
assert.ok(!evil.includes("<script>bad()"), "flash escaped");

console.log("ALL SMOKE TESTS PASSED");

// Every portal POST target lives under the reserved root. Under the v2 single
// origin only /~lsc/* is routed to the portal; a bare action="/admin/..." would
// be swallowed by the T3 server (whose catch-all never 404s) — W0-C finding 2.
const admin = views.renderAdmin({
  csrf: "tok",
  identity,
  self: { present: true, login: "octo" },
  selectedKey: "octo",
  users: [
    {
      name: "octo",
      displayName: "Octo Cat",
      avatarUrl: null,
      projectLimit: 3,
      admin: true,
      isSelf: true,
      status: "active",
      github: { connected: true, login: "octo" },
    },
  ],
  leaderboard: [],
  aggregate: { userCount: 1, activeCount: 1, totalCost30dUsd: 0 },
  flash: null,
  pending: [],
});
for (const page of [admin, acct, acct2, dash]) {
  const bare = [...page.matchAll(/(?:action|href)="(\/(?:admin|auth|account|static)[^"]*)"/g)]
    .map((m) => m[1])
    .filter((u) => !u.startsWith("/~lsc/"));
  assert.deepEqual(bare, [], `unprefixed portal URL(s): ${bare.join(", ")}`);
}
assert.ok(admin.includes("Octo Cat"), "admin list names the human first");
assert.ok(admin.includes("octo</span>"), "internal short name still visible on the admin surface");

const confirm = views.renderConfirm({
  csrf: "t",
  title: "T",
  heading: "H",
  detailHtml: "d",
  action: p("/admin/remove-user"),
  fields: [{ name: "name", value: "octo" }],
  confirmLabel: "Go",
  danger: true,
});
assert.ok(confirm.includes('action="/~lsc/admin/remove-user"'));
assert.ok(confirm.includes('href="/~lsc/admin"'), "cancel returns to the prefixed admin page");

// Awaiting-approval avatar is sanitized before it reaches the <img src>.
assert.equal(profiles.sanitizeAvatarUrl("https://evil.test/a.png"), null);

console.log("PREFIX ASSERTIONS PASSED");
