// history.mjs — read-only work-history / usage readers over a per-user T3
// instance state database (<baseDir>/userdata/state.sqlite).
//
// Every function opens the DB read-only and closes it before returning; the
// portal is low-traffic and this keeps us from ever holding locks against a
// live instance. turn_usage may be missing on older databases — handled by
// probing sqlite_master first.

import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";

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

// ------------------------------------------------- share of consumption
//
// This is OUR attribution, not provider truth. It answers "who used the shared
// subscription", and it is the only thing the leaderboard is allowed to be
// built on. It must never be mixed with the pool-remaining numbers that come
// from rateLimits.mjs.
//
// The headline metric is `billableTokens = input_tokens + output_tokens`.
// Deliberately NOT a sum of every token column:
//   * cache reads and cache writes are priced differently from fresh input and
//     adding them produces a number that means nothing;
//   * reasoning_output_tokens is (for Codex) reported alongside output tokens
//     and we cannot prove it is disjoint, so summing it in risks
//     double-counting Codex against Claude.
// The other columns are still returned so the account page can show them.
//
// Cost is returned separately and may be null-ish: Codex reports no dollar
// figure at all, so `costUsd` for Codex is 0 with `costKnown:false`. Callers
// must present cost as an API-equivalent estimate, never as spend.

function emptyProviderUsage() {
  return {
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: 0,
    billableTokens: 0,
    costUsd: 0,
    costRows: 0,
  };
}

function emptyProviderUsageMap() {
  return {
    claude: emptyProviderUsage(),
    codex: emptyProviderUsage(),
    other: emptyProviderUsage(),
    total: emptyProviderUsage(),
  };
}

function hasColumn(db, table, column) {
  try {
    return db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .some((c) => c.name === column);
  } catch {
    return false;
  }
}

function addUsage(target, row, cacheCreation) {
  target.turns += Number(row.turns) || 0;
  target.inputTokens += Number(row.inputTokens) || 0;
  target.outputTokens += Number(row.outputTokens) || 0;
  target.cachedInputTokens += Number(row.cachedInputTokens) || 0;
  target.cacheCreationInputTokens += cacheCreation;
  target.reasoningOutputTokens += Number(row.reasoningOutputTokens) || 0;
  target.billableTokens += (Number(row.inputTokens) || 0) + (Number(row.outputTokens) || 0);
  target.costUsd += Number(row.costUsd) || 0;
  target.costRows += Number(row.costRows) || 0;
}

/**
 * Token consumption for one instance since `sinceIso`, bucketed by provider.
 * Always returns the full shape (zeros when there is no DB, no table and no
 * rows) so callers can sum across users without null checks.
 *
 * `cache_creation_input_tokens` only exists after LateShift migration 036; on
 * an older database the column is absent and that bucket stays 0 rather than
 * failing the whole query.
 */
export function readProviderTokenUsage(dbPath, sinceIso = null) {
  return withDb(
    dbPath,
    (db) => {
      const out = emptyProviderUsageMap();
      if (!hasTable(db, "turn_usage")) return out;
      const cacheWriteCol = hasColumn(db, "turn_usage", "cache_creation_input_tokens")
        ? "COALESCE(SUM(cache_creation_input_tokens), 0)"
        : "0";
      const where = sinceIso ? "WHERE completed_at >= ?" : "";
      const rows = db
        .prepare(
          `SELECT provider_name AS provider,
                  COUNT(*) AS turns,
                  COALESCE(SUM(input_tokens), 0) AS inputTokens,
                  COALESCE(SUM(output_tokens), 0) AS outputTokens,
                  COALESCE(SUM(cached_input_tokens), 0) AS cachedInputTokens,
                  ${cacheWriteCol} AS cacheCreationInputTokens,
                  COALESCE(SUM(reasoning_output_tokens), 0) AS reasoningOutputTokens,
                  COALESCE(SUM(total_cost_usd), 0) AS costUsd,
                  SUM(CASE WHEN total_cost_usd IS NOT NULL THEN 1 ELSE 0 END) AS costRows
             FROM turn_usage ${where}
            GROUP BY provider_name`,
        )
        .all(...(sinceIso ? [sinceIso] : []));
      for (const row of rows) {
        const cacheCreation = Number(row.cacheCreationInputTokens) || 0;
        addUsage(out[normalizeProvider(row.provider)], row, cacheCreation);
        addUsage(out.total, row, cacheCreation);
      }
      return out;
    },
    emptyProviderUsageMap(),
  );
}

/** Month-to-date variant of {@link readProviderTokenUsage}. */
export function readMonthProviderTokenUsage(dbPath) {
  return readProviderTokenUsage(dbPath, monthStartIso());
}

/** Add `b` into `a` in place. Used to aggregate across users. */
export function mergeProviderTokenUsage(a, b) {
  for (const bucket of ["claude", "codex", "other", "total"]) {
    for (const key of Object.keys(a[bucket])) a[bucket][key] += b[bucket][key];
  }
  return a;
}

export { emptyProviderUsageMap };
