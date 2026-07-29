// LateShift W6-C — the unified project list's cross-workspace half.
//
// The portal aggregates every project the signed-in user can reach across all
// of their workspaces (personal + team) and serves it at /api/lsc/projects
// (same origin, session cookie). This module renders:
//
//   * LscCurrentWorkspaceBadge — a small label naming the workspace this
//     browser is currently connected to, and whether it is private or shared.
//     A user must never be unsure whether what they are typing is private.
//   * LscWorkspaceGroups — one group per OTHER workspace, its projects listed
//     read-only; clicking one navigates to /api/lsc/select-workspace, which
//     sets the lsc_ws cookie and reloads — the reconnect that lands the app
//     on the selected workspace's server.
//
// Deliberately a data-source add-on, not a sidebar rewrite (architecture-v2
// R4b): the local workspace's projects keep their existing rendering and
// interactions; only remote workspaces are listed here. When the portal
// endpoint is absent (desktop build, dev server, plain upstream), everything
// in this file renders null and the sidebar is exactly upstream's.

import { useEffect, useState } from "react";

interface LscUnifiedProject {
  readonly projectId: string;
  readonly title: string | null;
  readonly workspaceRoot: string;
  readonly updatedAt: string | null;
}

interface LscUnifiedWorkspace {
  readonly id: string;
  readonly kind: "personal" | "team";
  readonly label: string;
  readonly available: boolean;
  readonly projects: ReadonlyArray<LscUnifiedProject>;
}

interface LscUnifiedProjectList {
  readonly generatedAt: string;
  readonly currentWorkspaceId: string | null;
  readonly workspaces: ReadonlyArray<LscUnifiedWorkspace>;
}

const ENDPOINT = "/api/lsc/projects";
const SELECT_ENDPOINT = "/api/lsc/select-workspace";
const REFRESH_MS = 60_000;

// Module-level cache so the badge and the groups share one fetch cycle.
let cached: LscUnifiedProjectList | null = null;
const listeners = new Set<(value: LscUnifiedProjectList | null) => void>();
let pollStarted = false;

async function refresh(): Promise<void> {
  try {
    const response = await fetch(ENDPOINT, { credentials: "same-origin" });
    if (!response.ok) {
      cached = null;
    } else {
      const body: unknown = await response.json();
      cached =
        typeof body === "object" && body !== null && Array.isArray((body as { workspaces?: unknown }).workspaces)
          ? (body as LscUnifiedProjectList)
          : null;
    }
  } catch {
    // Network/parse failure → behave as if the endpoint does not exist.
    cached = null;
  }
  for (const listener of listeners) listener(cached);
}

function ensurePolling(): void {
  if (pollStarted) return;
  pollStarted = true;
  void refresh();
  setInterval(() => {
    if (listeners.size > 0) void refresh();
  }, REFRESH_MS);
}

function useUnifiedProjects(): LscUnifiedProjectList | null {
  const [value, setValue] = useState<LscUnifiedProjectList | null>(cached);
  useEffect(() => {
    ensurePolling();
    listeners.add(setValue);
    setValue(cached);
    return () => {
      listeners.delete(setValue);
    };
  }, []);
  return value;
}

function selectWorkspace(workspaceId: string): void {
  window.location.assign(`${SELECT_ENDPOINT}?ws=${encodeURIComponent(workspaceId)}`);
}

/** Names the workspace the app is currently connected to. Null when unknown. */
export function LscCurrentWorkspaceBadge() {
  const list = useUnifiedProjects();
  if (!list || !list.currentWorkspaceId) return null;
  const current = list.workspaces.find((workspace) => workspace.id === list.currentWorkspaceId);
  if (!current) return null;
  const shared = current.kind === "team";
  return (
    <span
      data-testid="lsc-current-workspace"
      title={
        shared
          ? `Shared team workspace "${current.label}" — every member sees these projects and conversations.`
          : "Your private workspace — only you can see these projects and conversations."
      }
      className={
        "ml-1 inline-flex items-center rounded-sm px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide " +
        (shared ? "bg-warning/15 text-warning" : "bg-sidebar-row-hover text-sidebar-muted-foreground/80")
      }
    >
      {shared ? `${current.label} · shared` : "private"}
    </span>
  );
}

/** One read-only group per workspace the user belongs to but is not in. */
export function LscWorkspaceGroups() {
  const list = useUnifiedProjects();
  if (!list) return null;
  const others = list.workspaces.filter((workspace) => workspace.id !== list.currentWorkspaceId);
  if (others.length === 0) return null;
  return (
    <div className="px-2 py-2" data-testid="lsc-workspace-groups">
      {others.map((workspace) => (
        <div key={workspace.id} className="mb-2">
          <div className="mb-1 flex items-center justify-between pl-2 pr-1.5">
            <span className="text-xs font-medium text-sidebar-muted-foreground/80">
              {workspace.kind === "team" ? `${workspace.label} (shared)` : workspace.label}
            </span>
            <button
              type="button"
              className="cursor-pointer rounded-sm px-1.5 py-px text-[10px] font-medium text-sidebar-muted-foreground/80 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
              onClick={() => selectWorkspace(workspace.id)}
              data-testid={`lsc-switch-${workspace.id}`}
            >
              open
            </button>
          </div>
          {workspace.projects.length === 0 ? (
            <div className="pl-2 text-xs text-muted-foreground/60">
              {workspace.available ? "no projects" : "unavailable"}
            </div>
          ) : (
            workspace.projects.map((project) => (
              <button
                key={project.projectId}
                type="button"
                className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-sm text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                onClick={() => selectWorkspace(workspace.id)}
                title={`Open in the ${workspace.label} workspace (reconnects)`}
              >
                <span className="truncate">{project.title ?? project.workspaceRoot}</span>
              </button>
            ))
          )}
        </div>
      ))}
    </div>
  );
}
