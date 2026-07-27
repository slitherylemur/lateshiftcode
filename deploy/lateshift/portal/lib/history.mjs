// history.mjs — read-only work-history / usage readers over a per-user T3
// instance state database (<baseDir>/userdata/state.sqlite).
//
// Every function opens the DB read-only and closes it before returning; the
// portal is low-traffic and this keeps us from ever holding locks against a
// live instance. turn_usage may be missing on older databases — handled by
// probing sqlite_master first.

import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync } from "node:fs";

function withDb(dbPath, fn, fallback) {
  if (!dbPath || !existsSync(dbPath)) return fallback;
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    return fn(db);
  } catch {
    return fallback;
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

function hasTable(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

/**
 * Projects with nested threads. Live projects first (by updated_at desc),
 * then deleted ones; threads per project sorted by updated_at desc.
 * costUsd per project comes from turn_usage when available (null otherwise).
 */
export function readWorkHistory(dbPath) {
  return withDb(
    dbPath,
    (db) => {
      const projects = db
        .prepare(
          `SELECT project_id, title, workspace_root, created_at, updated_at, deleted_at
             FROM projection_projects
            ORDER BY (deleted_at IS NOT NULL), updated_at DESC`,
        )
        .all();
      const threads = db
        .prepare(
          `SELECT thread_id, project_id, title, updated_at, deleted_at, archived_at
             FROM projection_threads
            ORDER BY updated_at DESC`,
        )
        .all();
      const usageAvailable = hasTable(db, "turn_usage");
      const costByProject = new Map();
      if (usageAvailable) {
        for (const row of db
          .prepare(
            `SELECT project_id, SUM(total_cost_usd) AS cost
               FROM turn_usage GROUP BY project_id`,
          )
          .all()) {
          if (row.project_id != null) costByProject.set(row.project_id, row.cost ?? 0);
        }
      }
      const byProject = new Map();
      const result = projects.map((p) => {
        const entry = {
          projectId: p.project_id,
          title: p.title,
          workspaceRoot: p.workspace_root,
          createdAt: p.created_at,
          updatedAt: p.updated_at,
          deletedAt: p.deleted_at,
          costUsd: usageAvailable ? (costByProject.get(p.project_id) ?? 0) : null,
          threads: [],
        };
        byProject.set(p.project_id, entry);
        return entry;
      });
      for (const t of threads) {
        byProject.get(t.project_id)?.threads.push({
          threadId: t.thread_id,
          title: t.title,
          updatedAt: t.updated_at,
          deletedAt: t.deleted_at,
          archivedAt: t.archived_at,
        });
      }
      return result;
    },
    [],
  );
}

/**
 * Usage totals for one instance. Returns null when the DB or the turn_usage
 * table is missing, or when no usage rows exist ("no usage recorded yet").
 * sinceIso (optional) restricts to rows completed after that instant.
 */
export function readUsageSummary(dbPath, sinceIso = null) {
  return withDb(
    dbPath,
    (db) => {
      if (!hasTable(db, "turn_usage")) return null;
      const where = sinceIso ? "WHERE completed_at >= ?" : "";
      const row = db
        .prepare(
          `SELECT COUNT(*) AS turns,
                  COALESCE(SUM(total_cost_usd), 0) AS totalCostUsd,
                  COALESCE(SUM(input_tokens), 0) AS inputTokens,
                  COALESCE(SUM(output_tokens), 0) AS outputTokens,
                  COALESCE(SUM(cached_input_tokens), 0) AS cachedInputTokens,
                  COALESCE(SUM(reasoning_output_tokens), 0) AS reasoningOutputTokens
             FROM turn_usage ${where}`,
        )
        .get(...(sinceIso ? [sinceIso] : []));
      if (!row || Number(row.turns) === 0) return null;
      return {
        turns: Number(row.turns),
        totalCostUsd: Number(row.totalCostUsd),
        inputTokens: Number(row.inputTokens),
        outputTokens: Number(row.outputTokens),
        cachedInputTokens: Number(row.cachedInputTokens),
        reasoningOutputTokens: Number(row.reasoningOutputTokens),
      };
    },
    null,
  );
}

/** Total cost over the trailing N days, or null if no usage table/rows/DB. */
export function readCostSince(dbPath, days = 30) {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const summary = readUsageSummary(dbPath, since);
  return summary ? summary.totalCostUsd : null;
}

export function stateDbPath(baseDir) {
  return `${baseDir}/userdata/state.sqlite`;
}

/** Cost since the start of the current UTC calendar month (null = no data). */
export function readCostThisMonth(dbPath) {
  const now = new Date();
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const summary = readUsageSummary(dbPath, since);
  return summary ? summary.totalCostUsd : null;
}

/** Budget-pause marker written by bin/budget-check, or null. */
export function readBudgetPaused(baseDir) {
  try {
    const raw = JSON.parse(readFileSync(`${baseDir}/BUDGET_PAUSED`, "utf8"));
    return {
      pausedAt: raw.pausedAt ?? null,
      monthCostUsd: Number(raw.monthCostUsd ?? 0),
      monthlyBudgetUsd: Number(raw.monthlyBudgetUsd ?? 0),
    };
  } catch {
    return null;
  }
}
