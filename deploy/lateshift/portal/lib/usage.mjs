// usage.mjs — the account page's usage seam.
//
// architecture-v2.md §4 mandates TWO displays that must never be blended:
//
//   1. POOL REMAINING — provider truth, from the `account.rate-limits.updated`
//      runtime event (Claude's rate_limit_event and Codex's
//      account/rateLimits/updated both normalize into it). Subscription-wide,
//      identical for every user. If no event has been seen recently the answer
//      is "unknown" — NEVER an extrapolation (principle 3).
//   2. SHARE OF CONSUMPTION — our own attribution, from the turn_usage ledger.
//      Ours, per-user, an estimate of WHO consumed, never of how much is left.
//
// W3 owns the collector that consumes the event and keeps fleet-wide window
// state. That collector does not exist yet, so this module DEFINES THE
// INTERFACE W4 consumes and stubs display (1) as honestly unknown. When W3
// lands, replace the body of `getPoolState()` with a read of its store; the
// shape below is the contract, and nothing else in the portal needs to change.
//
// Display (2) is NOT stubbed: it is computed here from the existing turn_usage
// ledger via history.mjs, which is real data available today. This module does
// not duplicate W3's pool logic — it only reads the ledger the portal already
// reads for the dashboard and the admin leaderboard.

import { readUsageSummary, readMonthProviderCost, stateDbPath } from "./history.mjs";

/**
 * ---- INTERFACE W4 EXPECTS FROM W3 ------------------------------------------
 *
 * getPoolState() -> PoolState | null
 *
 * PoolState = {
 *   asOf: string,                 // ISO instant the newest event was observed
 *   providers: PoolProvider[],
 * }
 * PoolProvider = {
 *   provider: "claude" | "codex", // normalized bucket
 *   windows: PoolWindow[],
 * }
 * PoolWindow = {
 *   // Verbatim provider label — e.g. "five_hour", "seven_day",
 *   // "seven_day_opus", "overage", or Codex's windowDurationMins rendered.
 *   // §4: never relabel a window "weekly"; both providers' reset behaviour is
 *   // reported as inconsistent with their labels.
 *   label: string,
 *   utilization: number | null,   // 0..100 percent consumed, null = unknown
 *   resetsAt: string | null,      // ISO instant, surfaced verbatim
 *   status: string | null,        // provider's own status string
 * }
 *
 * Returning null (or an empty providers array) MUST render as "unknown".
 * -----------------------------------------------------------------------------
 */
export function getPoolState() {
  // STUB — W3 has not landed. Returning null makes the account page render
  // "unknown", which is the correct answer today: no consumer of
  // account.rate-limits.updated exists yet, so the portal has seen no provider
  // window data at all. Do NOT replace this with an estimate.
  return null;
}

/** True when the pool display has real data to show. */
export function hasPoolData(pool) {
  return Boolean(pool && Array.isArray(pool.providers) && pool.providers.length);
}

/**
 * Share of consumption for one workspace, month-to-date, from turn_usage.
 *
 * `fleetTotals` is the sum across every workspace (pass null to skip the share
 * percentage — the token/turn counts are still returned).
 *
 * Returns { turns, inputTokens, outputTokens, costUsd, byProvider, sharePct }
 * or null when this workspace has recorded no usage at all.
 */
export function getUserShare(baseDir, fleetTotalCostUsd = null) {
  const dbPath = stateDbPath(baseDir);
  const summary = readUsageSummary(dbPath);
  if (!summary) return null;
  const byProvider = readMonthProviderCost(dbPath);
  const sharePct =
    typeof fleetTotalCostUsd === "number" && fleetTotalCostUsd > 0
      ? (byProvider.total / fleetTotalCostUsd) * 100
      : null;
  return {
    turns: summary.turns,
    inputTokens: summary.inputTokens,
    outputTokens: summary.outputTokens,
    costUsd: summary.totalCostUsd,
    monthCostUsd: byProvider.total,
    byProvider,
    sharePct,
  };
}

/**
 * Month-to-date cost across every registry workspace — the denominator for
 * `sharePct`. Cheap enough for the account page (one small read per workspace,
 * the same reads the admin leaderboard already does).
 */
export function fleetMonthCost(users) {
  let total = 0;
  for (const u of Object.values(users ?? {})) {
    if (!u?.baseDir) continue;
    total += readMonthProviderCost(stateDbPath(u.baseDir)).total;
  }
  return total;
}
