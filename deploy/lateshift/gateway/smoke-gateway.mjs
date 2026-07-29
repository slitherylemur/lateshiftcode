#!/usr/bin/env node
// smoke-gateway.mjs — end-to-end smoke test for gateway/Caddyfile (W7-B).
//
// Boots the REAL portal (scratch tree) + a fake workspace on a unix socket +
// the REAL gateway Caddyfile on shadow ports (LSC_HTTP_PORT=8881,
// LSC_PORTAL_UPSTREAM=127.0.0.1:3798). The live caddy.service, live portal and
// live site are never touched. Needs root (or the caddy group) and the caddy
// binary on PATH.
//
//   sudo node deploy/lateshift/gateway/smoke-gateway.mjs

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import http from "node:http";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORTAL_PORT = 3798;
const GW = "http://127.0.0.1:8881";
const SECRET = "cc".repeat(32);

const root = mkdtempSync(join(tmpdir(), "lsc-gwsmoke-"));
const runRoot = join(root, "run");
const sock = (ws) => join(runRoot, ws, "http.sock");

writeFileSync(join(root, "portal.config.json"), JSON.stringify({
  sessionSecret: SECRET,
  publicBaseUrl: "https://lateshiftcloud.com",
  adminGithubLogins: [],
}));
const ws = (id, members, extra = {}) => ({
  id, kind: id.startsWith("t-") ? "team" : "personal", unixUser: id, unixGroup: id,
  baseDir: join(root, "workspaces", id), socketPath: sock(id),
  unit: `t3ws@${id}.service`, projectLimit: 3, owner: members[0], members,
  createdAt: "2026-07-29T00:00:00Z", ...extra,
});
writeFileSync(join(root, "registry.json"), JSON.stringify({
  schemaVersion: 2,
  users: {
    alice: { githubLogin: "alice", unixUser: "u-alice", personalWorkspace: "u-alice", admin: false, status: "active" },
    bob: { githubLogin: "bob", unixUser: "u-bob", personalWorkspace: "u-bob", admin: false, status: "active" },
    carol: { githubLogin: "carol", unixUser: "u-carol", personalWorkspace: "u-carol", admin: false, status: "active" },
  },
  workspaces: {
    "u-alice": ws("u-alice", ["alice"]),
    "u-bob": ws("u-bob", ["bob"]),       // no socket -> 503 page
    "u-carol": ws("u-carol", ["carol"]),
    "t-proj": ws("t-proj", ["alice", "bob"], { project: "proj" }),
  },
}));

// Fake workspace on alice's unix socket: echoes path + the X-Lsc-User it saw.
mkdirSync(dirname(sock("u-alice")), { recursive: true });
const backend = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end(`ws:u-alice path:${req.url} user:${req.headers["x-lsc-user"]}`);
});
await new Promise((ok) => backend.listen(sock("u-alice"), ok));
// Raw upgrade handler so the smoke can prove 101 passes the whole path.
backend.on("upgrade", (req, socket) => {
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
    `X-Saw-User: ${req.headers["x-lsc-user"]}\r\n\r\n`,
  );
  socket.end();
});

const portal = spawn(process.execPath, [join(__dirname, "..", "portal", "server.mjs")], {
  env: { ...process.env, LSC_ROOT: root, LSC_RUNTIME_ROOT: runRoot, PORT: String(PORTAL_PORT) },
  stdio: ["ignore", "inherit", "inherit"],
});
const caddy = spawn("caddy", ["run", "--config", join(__dirname, "Caddyfile"), "--adapter", "caddyfile"], {
  env: {
    ...process.env,
    LSC_HTTP_PORT: "8881",
    LSC_PORTAL_UPSTREAM: `127.0.0.1:${PORTAL_PORT}`,
  },
  stdio: ["ignore", "ignore", "inherit"],
});

const b64url = (b) =>
  Buffer.from(b).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
function mint(gh) {
  const now = Math.floor(Date.now() / 1000);
  const body = b64url(JSON.stringify({ v: 1, gh, iat: now, exp: now + 3600 }));
  return `${body}.${b64url(createHmac("sha256", SECRET).update(body).digest())}`;
}
const get = (path, { gh, wsid, headers = {} } = {}) => {
  const cookie = [];
  if (gh) cookie.push(`lsc_session=${mint(gh)}`);
  if (wsid) cookie.push(`lsc_ws=${wsid}`);
  return fetch(`${GW}${path}`, {
    redirect: "manual",
    headers: { ...(cookie.length ? { cookie: cookie.join("; ") } : {}), ...headers },
  });
};

let failures = 0, ran = 0;
async function check(name, fn) {
  ran++;
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failures++;
    console.log(`FAIL ${name}: ${e.message}`);
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

try {
  // wait for both portal and gateway
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${GW}/~lsc/healthz`);
      if (r.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
    if (i === 59) throw new Error("gateway/portal did not come up");
  }

  await check("reserved root -> portal healthz", async () => {
    const r = await fetch(`${GW}/~lsc/healthz`);
    const j = await r.json();
    assert(r.status === 200 && j.service === "lateshift-portal", `got ${r.status}`);
  });
  await check("percent-encoded reserved root also portal", async () => {
    const r = await fetch(`${GW}/%7Elsc/healthz`);
    assert(r.status === 200, `got ${r.status}`);
  });
  await check("public /~lsc/authz is 404", async () => {
    const r = await get("/~lsc/authz", { gh: "alice" });
    assert(r.status === 404, `got ${r.status}`);
  });
  await check("signed out apex -> 302 to login", async () => {
    const r = await get("/some/thread");
    assert(r.status === 302, `got ${r.status}`);
    assert((r.headers.get("location") || "").includes("/~lsc/auth/github/login"),
      `location ${r.headers.get("location")}`);
  });
  await check("alice routed to her workspace socket, path preserved", async () => {
    const r = await get("/projects/x?y=1", { gh: "alice" });
    const t = await r.text();
    assert(r.status === 200 && t === "ws:u-alice path:/projects/x?y=1 user:alice", `got ${r.status} ${t}`);
  });
  await check("forged X-Lsc-User/Upstream overwritten by authz values", async () => {
    const r = await get("/", {
      gh: "alice",
      headers: { "x-lsc-user": "root", "x-lsc-upstream": "127.0.0.1:22" },
    });
    const t = await r.text();
    assert(t.includes("ws:u-alice") && t.includes("user:alice"), `got ${t}`);
  });
  await check("non-member team selection -> 403 page", async () => {
    const r = await get("/", { gh: "carol", wsid: "t-proj" });
    const t = await r.text();
    assert(r.status === 403 && t.includes("Forbidden"), `got ${r.status}`);
  });
  await check("member with socket down -> 503 starting page", async () => {
    const r = await get("/", { gh: "bob" });
    const t = await r.text();
    assert(r.status === 503 && t.includes("starting"), `got ${r.status}`);
    assert(r.headers.get("retry-after") === "5", "missing Retry-After");
  });
  await check("websocket upgrade survives forward_auth + dynamic upstream", async () => {
    const got = await new Promise((ok, bad) => {
      const req = http.request({
        host: "127.0.0.1", port: 8881, path: "/ws",
        headers: {
          cookie: `lsc_session=${mint("alice")}`,
          Connection: "Upgrade", Upgrade: "websocket",
          "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version": "13",
        },
      });
      req.on("upgrade", (res) => ok(res));
      req.on("response", (res) => bad(new Error(`no upgrade, status ${res.statusCode}`)));
      req.on("error", bad);
      req.end();
    });
    assert(got.statusCode === 101, `got ${got.statusCode}`);
    assert(got.headers["x-saw-user"] === "alice", `backend saw user ${got.headers["x-saw-user"]}`);
  });

  await check("retired subdomain host -> redirect to apex", async () => {
    // fetch/undici refuses a Host override, so speak raw http here.
    const r = await new Promise((ok, bad) => {
      const req = http.request(
        { host: "127.0.0.1", port: 8881, path: "/some/path", headers: { Host: "alice.lateshiftcloud.com" } },
        (res) => ok(res),
      );
      req.on("error", bad);
      req.end();
    });
    assert(r.statusCode === 302 && r.headers.location === "https://lateshiftcloud.com/some/path",
      `got ${r.statusCode} ${r.headers.location}`);
  });
} finally {
  caddy.kill("SIGTERM");
  portal.kill("SIGTERM");
  backend.close();
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${ran - failures}/${ran} passed`);
process.exit(failures === 0 ? 0 : 1);
