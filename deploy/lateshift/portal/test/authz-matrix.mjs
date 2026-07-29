#!/usr/bin/env node
// authz-matrix.mjs — EXHAUSTIVE executable test matrix for GET /authz (W7-D).
//
// /authz is the single point of failure for all access control
// (architecture-v2 R2); every row of the decision table in
// lib/workspaces.mjs is asserted here, most importantly every DENY row.
//
// Runs the REAL portal (server.mjs) against a scratch tree — no mocks of the
// code under test. Root-safe: registry-unreadable is simulated by renaming
// and corrupting the file, not chmod (root ignores modes).
//
//   node test/authz-matrix.mjs        exits 0 iff every case passes

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import net from "node:net";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 3799;
const SECRET = "aa".repeat(32);

// ---------------------------------------------------------------- scratch tree

const root = mkdtempSync(join(tmpdir(), "lsc-authz-"));
const runRoot = join(root, "run");

writeFileSync(join(root, "portal.config.json"), JSON.stringify({
  sessionSecret: SECRET,
  publicBaseUrl: "https://lateshiftcloud.com",
  adminGithubLogins: ["AdminBoss"],
}));

const sock = (ws) => join(runRoot, ws, "http.sock");
const wsEntry = (id, kind, members, extra = {}) => ({
  id, kind, unixUser: id, unixGroup: id,
  baseDir: join(root, "workspaces", id),
  socketPath: sock(id),
  unit: `t3ws@${id}.service`,
  projectLimit: 3,
  owner: kind === "personal" ? members[0] : null,
  members,
  createdAt: "2026-07-29T00:00:00Z",
  ...extra,
});
const userEntry = (login, ws, extra = {}) => ({
  githubLogin: login, unixUser: ws, personalWorkspace: ws,
  admin: false, status: "active", avatarUrl: null,
  createdAt: "2026-07-29T00:00:00Z", ...extra,
});

const registry = {
  schemaVersion: 2,
  users: {
    alice: userEntry("alice", "u-alice"),
    bob: userEntry("bob", "u-bob"),
    carol: userEntry("carol", "u-carol"),
    adminboss: userEntry("AdminBoss", "u-adminboss", { admin: true }),
    mallory: userEntry("mallory", "u-mallory", { status: "disabled" }),
    // registry corruption case: socketPath escapes the runtime root
    eve: userEntry("eve", "u-eve"),
  },
  workspaces: {
    "u-alice": wsEntry("u-alice", "personal", ["alice"]),
    "u-bob": wsEntry("u-bob", "personal", ["bob"]), // socket NOT created -> 503
    "u-carol": wsEntry("u-carol", "personal", ["carol"]),
    "u-adminboss": wsEntry("u-adminboss", "personal", ["AdminBoss"]),
    "u-mallory": wsEntry("u-mallory", "personal", ["mallory"]),
    "u-eve": wsEntry("u-eve", "personal", ["eve"], { socketPath: "/tmp/evil.sock" }),
    "t-proj": wsEntry("t-proj", "team", ["alice", "bob"], { project: "proj" }),
  },
};
const regPath = join(root, "registry.json");
writeFileSync(regPath, JSON.stringify(registry));

// Real unix sockets for the workspaces that are "up".
const listeners = [];
function listenAt(path) {
  mkdirSync(dirname(path), { recursive: true });
  return new Promise((ok, bad) => {
    const s = net.createServer(() => {});
    s.once("error", bad);
    s.listen(path, ok);
    listeners.push(s);
  });
}
await listenAt(sock("u-alice"));
await listenAt(sock("u-carol"));
await listenAt(sock("u-adminboss"));
await listenAt(sock("u-mallory")); // up, but its owner is disabled -> still 403
await listenAt(sock("t-proj"));

// ---------------------------------------------------------------- portal child

const child = spawn(process.execPath, [join(__dirname, "..", "server.mjs")], {
  env: { ...process.env, LSC_ROOT: root, LSC_RUNTIME_ROOT: runRoot, PORT: String(PORT) },
  stdio: ["ignore", "inherit", "inherit"],
});

async function waitHealthy() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/healthz`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("portal did not become healthy");
}

// ---------------------------------------------------------------- cookies

const b64url = (b) =>
  Buffer.from(b).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
function mint(gh, { expOffsetS = 3600, secret = SECRET, tamper = false } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const body = b64url(JSON.stringify({ v: 1, gh, iat: now, exp: now + expOffsetS }));
  let sig = b64url(createHmac("sha256", secret).update(body).digest());
  if (tamper) sig = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
  return `${body}.${sig}`;
}

function authz({ session, ws, headers = {}, path = "/authz" } = {}) {
  const cookie = [];
  if (session) cookie.push(`lsc_session=${session}`);
  if (ws) cookie.push(`lsc_ws=${ws}`);
  return fetch(`http://127.0.0.1:${PORT}${path}`, {
    redirect: "manual",
    headers: { ...(cookie.length ? { cookie: cookie.join("; ") } : {}), ...headers },
  });
}

// ---------------------------------------------------------------- assertions

let failures = 0, ran = 0;
async function expect(name, resPromise, want) {
  ran++;
  let res;
  try {
    res = await resPromise;
  } catch (e) {
    failures++;
    console.log(`FAIL ${name}: request error ${e}`);
    return;
  }
  const problems = [];
  if (res.status !== want.status) problems.push(`status ${res.status} != ${want.status}`);
  for (const [h, v] of Object.entries(want.headers ?? {})) {
    const got = res.headers.get(h);
    if (v === null) {
      if (got !== null) problems.push(`${h} should be ABSENT, got ${JSON.stringify(got)}`);
    } else if (got !== v) problems.push(`${h}: ${JSON.stringify(got)} != ${JSON.stringify(v)}`);
  }
  if (problems.length) {
    failures++;
    console.log(`FAIL ${name}: ${problems.join("; ")}`);
  } else {
    console.log(`ok   ${name}`);
  }
}
const NOROUTE = { "x-lsc-upstream": null, "x-lsc-user": null };
const login = "https://lateshiftcloud.com/~lsc/auth/github/login";

// ---------------------------------------------------------------- the matrix

try {
  await waitHealthy();

  // -- signed out / broken sessions -> 401, never routed ---------------------
  await expect("signed out", authz({}),
    { status: 401, headers: { "x-authz-redirect": login, ...NOROUTE } });
  await expect("garbage cookie", authz({ session: "not-a-session" }),
    { status: 401, headers: NOROUTE });
  await expect("tampered signature", authz({ session: mint("alice", { tamper: true }) }),
    { status: 401, headers: NOROUTE });
  await expect("wrong secret", authz({ session: mint("alice", { secret: "bb".repeat(32) }) }),
    { status: 401, headers: NOROUTE });
  await expect("expired session", authz({ session: mint("alice", { expOffsetS: -60 }) }),
    { status: 401, headers: NOROUTE });

  // -- valid session, no/blocked account -> 403 -------------------------------
  await expect("valid session, unknown login", authz({ session: mint("stranger") }),
    { status: 403, headers: NOROUTE });
  await expect("disabled user", authz({ session: mint("mallory") }),
    { status: 403, headers: NOROUTE });

  // -- personal workspace routing ---------------------------------------------
  await expect("personal, no cookie", authz({ session: mint("alice") }),
    { status: 200, headers: { "x-lsc-upstream": `unix/${sock("u-alice")}`, "x-lsc-user": "alice" } });
  await expect("session login case-insensitive", authz({ session: mint("Alice") }),
    { status: 200, headers: { "x-lsc-user": "alice" } });
  await expect("explicit own personal cookie", authz({ session: mint("alice"), ws: "u-alice" }),
    { status: 200, headers: { "x-lsc-upstream": `unix/${sock("u-alice")}` } });

  // -- team workspace routing --------------------------------------------------
  await expect("team member via cookie", authz({ session: mint("bob"), ws: "t-proj" }),
    { status: 200, headers: { "x-lsc-upstream": `unix/${sock("t-proj")}`, "x-lsc-user": "bob" } });
  await expect("NON-member team cookie DENIED", authz({ session: mint("carol"), ws: "t-proj" }),
    { status: 403, headers: NOROUTE });
  await expect("cookie for a foreign personal ws DENIED",
    authz({ session: mint("carol"), ws: "u-alice" }), { status: 403, headers: NOROUTE });

  // -- admin: membership only, NO bypass ---------------------------------------
  await expect("admin routes to own personal", authz({ session: mint("AdminBoss") }),
    { status: 200, headers: { "x-lsc-upstream": `unix/${sock("u-adminboss")}`, "x-lsc-user": "AdminBoss" } });
  await expect("admin NOT member of team DENIED", authz({ session: mint("AdminBoss"), ws: "t-proj" }),
    { status: 403, headers: NOROUTE });

  // -- hostile / malformed workspace selection ----------------------------------
  await expect("unknown workspace id", authz({ session: mint("alice"), ws: "t-ghost" }),
    { status: 403, headers: NOROUTE });
  await expect("malformed ws cookie (traversal)", authz({ session: mint("alice"), ws: "../etc" }),
    { status: 403, headers: NOROUTE });
  await expect("malformed ws cookie (bad prefix)", authz({ session: mint("alice"), ws: "xx-thing" }),
    { status: 403, headers: NOROUTE });

  // -- forged inbound headers are ignored; outputs come from the registry -------
  await expect("forged X-Lsc-* / X-Authz-Host ignored",
    authz({
      session: mint("alice"),
      headers: {
        "x-lsc-upstream": `unix/${sock("t-proj")}`,
        "x-lsc-user": "AdminBoss",
        "x-authz-host": "adminboss.lateshiftcloud.com",
      },
    }),
    { status: 200, headers: { "x-lsc-upstream": `unix/${sock("u-alice")}`, "x-lsc-user": "alice" } });

  // -- registry corruption fails CLOSED ------------------------------------------
  await expect("socketPath outside runtime root DENIED", authz({ session: mint("eve") }),
    { status: 403, headers: NOROUTE });

  // -- workspace present but socket down -> 503 (never 200, never empty dial) ----
  await expect("member ok, socket absent -> 503", authz({ session: mint("bob") }),
    { status: 503, headers: NOROUTE });

  // -- registry unreadable -> DENY, not allow -------------------------------------
  renameSync(regPath, `${regPath}.away`);
  await expect("registry missing DENIED", authz({ session: mint("alice") }),
    { status: 403, headers: NOROUTE });
  writeFileSync(regPath, "{ this is not json");
  await expect("registry corrupt DENIED", authz({ session: mint("alice") }),
    { status: 403, headers: NOROUTE });
  rmSync(regPath);
  renameSync(`${regPath}.away`, regPath);
  await expect("registry restored (control)", authz({ session: mint("alice") }),
    { status: 200 });

  // -- the prefixed public form must not exist -------------------------------------
  await expect("/~lsc/authz is 404", authz({ session: mint("alice"), path: "/~lsc/authz" }),
    { status: 404, headers: NOROUTE });
  await expect("/%7Elsc/authz is 404", authz({ session: mint("alice"), path: "/%7Elsc/authz" }),
    { status: 404, headers: NOROUTE });
} finally {
  child.kill("SIGTERM");
  for (const l of listeners) l.close();
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${ran - failures}/${ran} passed`);
process.exit(failures === 0 ? 0 : 1);
