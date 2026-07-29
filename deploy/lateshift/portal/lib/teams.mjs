// teams.mjs — W6-B: the portal's window onto v2 TEAM workspaces.
//
// Read side: registry.json (schemaVersion 2), written exclusively by `lsw`.
// The portal only ever READS it, re-read per request like users.json.
// Write side: every mutation shells out to `sudo -n lsw ...` (execFile argv
// arrays, never shell strings), so the flock + three-way reconciliation +
// rollback semantics live in exactly one place — lsw. If the sudoers grant for
// lsw is missing, actions fail loudly with sudo's error; nothing is mutated.
//
// The per-team PAT is deliberately NOT manageable from the browser: the token
// value must never transit a web form. The panel points at
//   lsw team pat install|rotate <project>
// which reads the token from stdin on the host.

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export const REGISTRY_V2_PATH =
  process.env.LSC_REGISTRY_V2 ?? "/home/dev/services/lateshift/registry.json";
const LSW = process.env.LSC_LSW_BIN ?? "/home/dev/services/lateshift/bin/lsw";

export const PROJECT_RE = /^[a-z0-9](?:-?[a-z0-9])*$/;
const GH_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
// owner/repo only — the URL form is normalized by lsw; keep the web surface
// to the strictest shape.
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9.-]*\/[A-Za-z0-9._-]+$/;

export function assertProject(v) {
  if (typeof v === "string" && PROJECT_RE.test(v) && v.length >= 2 && v.length <= 24) return v;
  throw new Error("project name must match [a-z0-9-]{2,24}");
}

export function assertLogin(v) {
  if (typeof v === "string" && GH_LOGIN_RE.test(v)) return v;
  throw new Error("invalid GitHub login");
}

export function assertRepo(v) {
  if (typeof v === "string" && REPO_RE.test(v) && !v.includes("..")) return v;
  throw new Error(`repos must be OWNER/REPO (got ${JSON.stringify(String(v).slice(0, 60))})`);
}

/** Load the v2 registry; absent/unreadable → null (panel renders as absent). */
export function loadRegistryV2() {
  try {
    if (!existsSync(REGISTRY_V2_PATH)) return null;
    const raw = JSON.parse(readFileSync(REGISTRY_V2_PATH, "utf8"));
    if (raw?.schemaVersion !== 2) return null;
    return { users: raw.users ?? {}, workspaces: raw.workspaces ?? {} };
  } catch {
    return null;
  }
}

/** Teams + provisioned v2 logins for the admin panel; null when no v2 registry. */
export function adminTeamsProps() {
  const reg = loadRegistryV2();
  if (!reg) return null;
  const teams = Object.values(reg.workspaces)
    .filter((w) => w?.kind === "team")
    .map((w) => ({
      id: String(w.id ?? ""),
      project: String(w.project ?? String(w.id ?? "").replace(/^t-/, "")),
      members: Array.isArray(w.members) ? w.members.map(String) : [],
      repos: Array.isArray(w.repos) ? w.repos.map(String) : [],
      projectLimit: Number(w.projectLimit ?? 0),
      unit: String(w.unit ?? ""),
      createdAt: w.createdAt ?? null,
    }))
    .sort((a, b) => a.project.localeCompare(b.project));
  const logins = Object.values(reg.users)
    .map((u) => String(u?.githubLogin ?? ""))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  return { teams, logins };
}

// -------------------------------------------------------------------------
// W6-C: the unified project list.
// -------------------------------------------------------------------------
// The sidebar shows every project a user can reach — personal and team — as
// ONE list (D13). One server per workspace vs one list in the UI is the one
// place the shapes disagree, so the PORTAL assembles the list: for each
// workspace the login belongs to, read the live projects from that
// workspace's own state.sqlite, strictly read-only, and label the group.

/** Workspaces (v2) the login is a member of; personal first, then teams. */
export function workspacesForLogin(login) {
  const reg = loadRegistryV2();
  if (!reg || !login) return null;
  const lower = String(login).toLowerCase();
  const user = reg.users[lower] ?? null;
  const out = [];
  for (const w of Object.values(reg.workspaces)) {
    const members = Array.isArray(w?.members) ? w.members : [];
    if (!members.some((m) => String(m).toLowerCase() === lower)) continue;
    out.push({
      id: String(w.id),
      kind: w.kind === "team" ? "team" : "personal",
      project: w.project ? String(w.project) : null,
      baseDir: String(w.baseDir ?? ""),
      isPersonal: user ? user.personalWorkspace === w.id : w.kind === "personal",
    });
  }
  out.sort((a, b) => (a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind === "personal" ? -1 : 1));
  return out;
}

function liveProjects(dbPath) {
  if (!dbPath || !existsSync(dbPath)) return [];
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    return db
      .prepare(
        `SELECT project_id, title, workspace_root, updated_at
           FROM projection_projects
          WHERE deleted_at IS NULL
          ORDER BY updated_at DESC`,
      )
      .all()
      .map((r) => ({
        projectId: String(r.project_id),
        title: r.title == null ? null : String(r.title),
        workspaceRoot: String(r.workspace_root ?? ""),
        updatedAt: r.updated_at ?? null,
      }));
  } catch {
    // A workspace whose DB is unreadable contributes an empty group rather
    // than sinking the whole list; the caller marks it unavailable.
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * The aggregated, grouped project list for a login.
 * null → no v2 registry, or the login has no v2 workspaces.
 * Group labels: "Personal" for the personal workspace, the project name for
 * teams — a user must always see whether a project is private or shared.
 */
export function aggregateProjects(login) {
  const workspaces = workspacesForLogin(login);
  if (!workspaces || workspaces.length === 0) return null;
  return {
    generatedAt: new Date().toISOString(),
    workspaces: workspaces.map((w) => {
      const projects = liveProjects(w.baseDir ? `${w.baseDir}/userdata/state.sqlite` : null);
      return {
        id: w.id,
        kind: w.kind,
        label: w.isPersonal ? "Personal" : (w.project ?? w.id.replace(/^t-/, "")),
        available: projects !== null,
        projects: projects ?? [],
      };
    }),
  };
}

function runLsw(args, { timeoutMs = 300_000 } = {}) {
  return new Promise((resolve) => {
    execFile(
      "sudo",
      ["-n", LSW, ...args],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          code: error ? (error.code ?? 1) : 0,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
        });
      },
    );
  });
}

/**
 * lsw team add <project> [--member L]... [--repo R]...
 * Creation is PAT-less from the panel; private repos therefore fail the clone
 * (and the whole creation rolls back) — the flash tells the admin to use the
 * CLI path with --pat-file for private repos.
 */
export function teamAdd({ project, members = [], repos = [] }) {
  const args = ["team", "add", assertProject(project)];
  for (const m of members) args.push("--member", assertLogin(m));
  for (const r of repos) args.push("--repo", assertRepo(r));
  return runLsw(args);
}

export function memberAdd(project, login) {
  return runLsw(["member", "add", assertProject(project), assertLogin(login)], {
    timeoutMs: 60_000,
  });
}

export function memberRemove(project, login) {
  return runLsw(["member", "remove", assertProject(project), assertLogin(login)], {
    timeoutMs: 60_000,
  });
}
