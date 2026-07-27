#!/usr/bin/env node
// t3client.mjs — headless T3 Code client for LateShift Cloud smoke tests.
//
// Dependency-free (node >= 22: built-in fetch + WebSocket). Authenticates
// against a T3 Code server instance with a one-time pairing token, then
// drives the server over the same WebSocket RPC the web UI uses.
//
// Usage:
//   node t3client.mjs --url <base-url> [--auth-file FILE] <command> [args]
//
// Commands:
//   pair --pairing <token-or-pairing-url>
//       Exchange a ONE-TIME pairing token for a bearer access token and save
//       it to the auth file. Mint tokens with `t3user pair <name>`.
//   projects
//       List projects from GET /api/orchestration/shell (id, title, root).
//   create-project --title T --root PATH [--project-id ID]
//       Dispatch project.create over the WebSocket RPC.
//   delete-project --project-id ID [--force]
//       Dispatch project.delete over the WebSocket RPC.
//   dispatch --json '<orchestration command JSON>'
//       Dispatch an arbitrary orchestration command over the WebSocket RPC.
//
// Exit codes: 0 success, 1 usage/transport error, 2 command rejected by server.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";

const { readFileSync, writeFileSync, mkdirSync } = NodeFS;
const { dirname } = NodePath;
const { randomUUID } = NodeCrypto;

// OAuth token-exchange constants (packages/contracts/src/auth.ts).
const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:token-exchange";
const SUBJECT_TOKEN_TYPE = "urn:t3:params:oauth:token-type:environment-bootstrap";
const REQUESTED_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";

function fail(message, code = 1) {
  console.error(`t3client: ${message}`);
  process.exit(code);
}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i += 1;
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

function extractPairingToken(value) {
  if (!value.includes("://")) return value.trim();
  const url = new URL(value);
  const hashParams = new URLSearchParams(url.hash.replace(/^#/, ""));
  return (hashParams.get("token") ?? url.searchParams.get("token") ?? "").trim() || null;
}

function loadAuth(authFile) {
  try {
    return JSON.parse(readFileSync(authFile, "utf8"));
  } catch {
    return {};
  }
}

async function httpJson(method, url, { headers = {}, body } = {}) {
  const response = await fetch(url, { method, headers, body });
  const text = await response.text();
  let json;
  try {
    json = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!response.ok) {
    throw new Error(`${method} ${url} -> HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  return json;
}

async function exchangePairingToken(baseUrl, pairingToken) {
  const body = new URLSearchParams({
    grant_type: GRANT_TYPE,
    subject_token: pairingToken,
    subject_token_type: SUBJECT_TOKEN_TYPE,
    requested_token_type: REQUESTED_TOKEN_TYPE,
    client_label: "t3client-smoke-test",
  });
  const result = await httpJson("POST", `${baseUrl}/oauth/token`, {
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!result?.access_token) throw new Error("token exchange returned no access_token");
  return result;
}

async function getWsTicket(baseUrl, accessToken) {
  const result = await httpJson("POST", `${baseUrl}/api/auth/websocket-ticket`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!result?.ticket) throw new Error("websocket-ticket returned no ticket");
  return result.ticket;
}

// Single-shot RPC over the server's Effect RPC WebSocket (JSON serialization,
// one JSON envelope per frame). Returns the decoded Exit.
async function wsRpc(baseUrl, accessToken, tag, payload, { timeoutMs = 15000 } = {}) {
  const ticket = await getWsTicket(baseUrl, accessToken);
  const wsUrl = `${baseUrl.replace(/^http/, "ws")}/ws?wsTicket=${encodeURIComponent(ticket)}`;
  const socket = new WebSocket(wsUrl);
  const requestId = "1";

  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`RPC ${tag} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const done = (fn, value) => {
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* ignore */
      }
      fn(value);
    };
    socket.addEventListener("error", (event) =>
      done(reject, new Error(`websocket error: ${event.message ?? "unknown"}`)),
    );
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ _tag: "Request", id: requestId, tag, payload, headers: [] }));
    });
    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      const envelopes = Array.isArray(message) ? message : [message];
      for (const envelope of envelopes) {
        if (envelope._tag === "Exit" && String(envelope.requestId) === requestId) {
          return done(resolve, envelope.exit);
        }
        if (envelope._tag === "Defect") {
          return done(reject, new Error(`server defect: ${JSON.stringify(envelope.defect)}`));
        }
        if (envelope._tag === "ClientProtocolError") {
          return done(reject, new Error(`protocol error: ${JSON.stringify(envelope.error)}`));
        }
      }
    });
  });
}

function describeExitFailure(exit) {
  const causes = exit?.cause ?? [];
  const parts = [];
  for (const cause of causes) {
    if (cause._tag === "Fail") {
      const error = cause.error ?? {};
      parts.push(error.message ?? error.detail ?? JSON.stringify(error));
    } else if (cause._tag === "Die") {
      parts.push(`defect: ${JSON.stringify(cause.defect).slice(0, 300)}`);
    } else {
      parts.push(cause._tag);
    }
  }
  return parts.join("; ") || JSON.stringify(exit).slice(0, 300);
}

async function dispatchCommand(baseUrl, accessToken, command) {
  const exit = await wsRpc(baseUrl, accessToken, "orchestration.dispatchCommand", command);
  if (exit._tag === "Success") {
    console.log(`OK dispatch ${command.type}: ${JSON.stringify(exit.value)}`);
    return true;
  }
  console.error(`REJECTED dispatch ${command.type}: ${describeExitFailure(exit)}`);
  return false;
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const command = positional[0];
  if (!command || flags.help) {
    console.error("see header comment for usage");
    process.exit(command ? 0 : 1);
  }
  const baseUrl = (flags.url ?? "").replace(/\/+$/, "");
  if (!baseUrl) fail("--url <base-url> is required");
  const authFile = flags["auth-file"] ?? "/tmp/t3client-auth.json";
  const auth = loadAuth(authFile);

  if (command === "pair") {
    const raw = flags.pairing;
    if (typeof raw !== "string") fail("pair requires --pairing <token-or-url>");
    const pairingToken = extractPairingToken(raw);
    if (!pairingToken) fail("could not extract pairing token");
    const result = await exchangePairingToken(baseUrl, pairingToken);
    auth[baseUrl] = { accessToken: result.access_token, scope: result.scope };
    mkdirSync(dirname(authFile), { recursive: true });
    writeFileSync(authFile, JSON.stringify(auth, null, 2), { mode: 0o600 });
    console.log(`OK paired with ${baseUrl} (scope: ${result.scope}); saved to ${authFile}`);
    return;
  }

  const accessToken = auth[baseUrl]?.accessToken;
  if (!accessToken) fail(`no access token for ${baseUrl} in ${authFile}; run pair first`);

  switch (command) {
    case "projects": {
      const shell = await httpJson("GET", `${baseUrl}/api/orchestration/shell`, {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      const projects = shell?.projects ?? [];
      console.log(`${projects.length} project(s):`);
      for (const project of projects) {
        console.log(`  ${project.id}  ${JSON.stringify(project.title)}  ${project.workspaceRoot}`);
      }
      return;
    }
    case "create-project": {
      const title = flags.title;
      const root = flags.root;
      if (typeof title !== "string" || typeof root !== "string") {
        fail("create-project requires --title and --root");
      }
      const projectId =
        typeof flags["project-id"] === "string" ? flags["project-id"] : randomUUID();
      const ok = await dispatchCommand(baseUrl, accessToken, {
        type: "project.create",
        commandId: randomUUID(),
        projectId,
        title,
        workspaceRoot: root,
        createWorkspaceRootIfMissing: true,
        createdAt: new Date().toISOString(),
      });
      if (ok) console.log(`projectId: ${projectId}`);
      process.exit(ok ? 0 : 2);
      break;
    }
    case "delete-project": {
      const projectId = flags["project-id"];
      if (typeof projectId !== "string") fail("delete-project requires --project-id");
      const ok = await dispatchCommand(baseUrl, accessToken, {
        type: "project.delete",
        commandId: randomUUID(),
        projectId,
        force: flags.force === true || flags.force === "true",
      });
      process.exit(ok ? 0 : 2);
      break;
    }
    case "dispatch": {
      if (typeof flags.json !== "string") fail("dispatch requires --json '<command>'");
      const ok = await dispatchCommand(baseUrl, accessToken, JSON.parse(flags.json));
      process.exit(ok ? 0 : 2);
      break;
    }
    default:
      fail(`unknown command: ${command}`);
  }
}

main().catch((error) => fail(error?.message ?? String(error)));
