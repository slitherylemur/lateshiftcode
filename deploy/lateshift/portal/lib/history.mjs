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

/** Start of the current UTC calendar month, as an ISO instant. */
export function monthStartIso() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

/** Cost since the start of the current UTC calendar month (null = no data). */
export function readCostThisMonth(dbPath) {
  const summary = readUsageSummary(dbPath, monthStartIso());
  return summary ? summary.totalCostUsd : null;
}

// ---------------------------------------------------------------- providers
//
// Subscription accounting groups raw provider_name values into the buckets the
// portal charges against: "claude", "codex", or "other". The turn_usage column
// is provider_name (e.g. "claudeAgent", "codex"); normalize defensively.

/** Fixed subscription session-window length: 5 hours, in ms. */
export const WINDOW_MS = 5 * 60 * 60 * 1000;

export function normalizeProvider(name) {
  const s = String(name || "").toLowerCase();
  if (s.includes("claude") || s.includes("anthropic")) return "claude";
  if (s.includes("codex") || s.includes("openai") || s.includes("gpt")) return "codex";
  return "other";
}

/**
 * Month-to-date cost for one instance, bucketed by provider. Always returns an
 * object (zeros when the DB / table / rows are absent) so callers can sum
 * across instances without null checks.
 */
export function readMonthProviderCost(dbPath) {
  const since = monthStartIso();
  return withDb(
    dbPath,
    (db) => {
      const base = { claude: 0, codex: 0, other: 0, total: 0 };
      if (!hasTable(db, "turn_usage")) return base;
      const rows = db
        .prepare(
          `SELECT provider_name AS p, COALESCE(SUM(total_cost_usd), 0) AS c
             FROM turn_usage WHERE completed_at >= ? GROUP BY provider_name`,
        )
        .all(since);
      for (const r of rows) {
        const bucket = normalizeProvider(r.p);
        base[bucket] += Number(r.c) || 0;
        base.total += Number(r.c) || 0;
      }
      return base;
    },
    { claude: 0, codex: 0, other: 0, total: 0 },
  );
}

/**
 * Individual turns since an instant, as {bucket, ts (ms), cost}. Used to build
 * a fleet-wide, per-provider view by concatenating across instances and then
 * running computeProviderWindows() over the merged array.
 */
export function readProviderTurns(dbPath, sinceIso) {
  return withDb(
    dbPath,
    (db) => {
      if (!hasTable(db, "turn_usage")) return [];
      const rows = db
        .prepare(
          `SELECT provider_name AS p, total_cost_usd AS c, completed_at AS t
             FROM turn_usage WHERE completed_at >= ? AND completed_at IS NOT NULL`,
        )
        .all(sinceIso);
      const out = [];
      for (const r of rows) {
        const ts = Date.parse(r.t);
        if (Number.isNaN(ts)) continue;
        out.push({ bucket: normalizeProvider(r.p), ts, cost: Number(r.c) || 0 });
      }
      return out;
    },
    [],
  );
}

/**
 * Fleet-wide current 5-hour session window per provider bucket.
 *
 * Semantics (must match the budget-check / dashboard agents): fixed 5-hour
 * blocks, re-anchored at the first turn that follows >= 5 hours of inactivity
 * for that provider across ALL instances combined. From the anchor, time is
 * partitioned into fixed 5h blocks; the "current" block is the one containing
 * `now`. usage = summed cost of turns since the current block start; reset =
 * block start + 5h. This is an APPROXIMATION of the provider's real limiter.
 *
 * @param turns array of {bucket, ts, cost} (any order, any providers)
 * @returns { claude|codex|other: {cost, blockStart, reset} | null }
 */
export function computeProviderWindows(turns, now = Date.now()) {
  const byBucket = { claude: [], codex: [], other: [] };
  for (const t of turns) {
    (byBucket[t.bucket] ??= []).push(t);
  }
  const result = {};
  for (const [bucket, arr] of Object.entries(byBucket)) {
    if (!arr.length) {
      result[bucket] = null;
      continue;
    }
    arr.sort((a, b) => a.ts - b.ts);
    let anchor = arr[0].ts;
    for (let i = 1; i < arr.length; i++) {
      if (arr[i].ts - arr[i - 1].ts >= WINDOW_MS) anchor = arr[i].ts;
    }
    const blockIndex = Math.max(0, Math.floor((now - anchor) / WINDOW_MS));
    const blockStart = anchor + blockIndex * WINDOW_MS;
    const reset = blockStart + WINDOW_MS;
    let cost = 0;
    for (const t of arr) if (t.ts >= blockStart) cost += t.cost;
    result[bucket] = { cost, blockStart, reset };
  }
  return result;
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
