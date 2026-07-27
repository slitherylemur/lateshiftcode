/**
 * LateShift Cloud — per-user usage/budget contract.
 *
 * Shape returned by the `server.getUsageBudget` RPC. The server reads the
 * per-instance limits from `instance.env` (LSC_LIMIT_*_USD, LSC_LIMIT_*_5H_USD)
 * and the signed-in user name from `LSC_USER_NAME`, and aggregates the
 * `turn_usage` ledger (migration 035) into month-to-date and rolling
 * 5-hour-session totals per provider.
 *
 * The 5-hour figures approximate the provider's own session windows (Claude /
 * ChatGPT reset on fixed 5h blocks anchored at the first turn of a session);
 * they are a best-effort local estimate, not the provider's authoritative
 * number.
 *
 * A `null` limit means unlimited (env var unset or <= 0). All money is USD.
 */
import * as Schema from "effect/Schema";

/** Per-provider usage line. `id` matches `turn_usage.provider_name` (the driver id). */
export const LateShiftUsageProvider = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  monthUsedUsd: Schema.Number,
  monthLimitUsd: Schema.NullOr(Schema.Number),
  windowUsedUsd: Schema.Number,
  windowLimitUsd: Schema.NullOr(Schema.Number),
  /** ISO instant the current 5h window resets, or null when no window is active. */
  windowResetsAt: Schema.NullOr(Schema.String),
  windowLengthHours: Schema.Number,
});
export type LateShiftUsageProvider = typeof LateShiftUsageProvider.Type;

export const LateShiftUsageBudget = Schema.Struct({
  /** Signed-in account name (LSC_USER_NAME); null when identity is not provided. */
  userName: Schema.NullOr(Schema.String),
  totalUsedUsd: Schema.Number,
  totalLimitUsd: Schema.NullOr(Schema.Number),
  /** True when at least one limit (total, per-provider month, or per-provider 5h) is set. */
  hasAnyLimit: Schema.Boolean,
  providers: Schema.Array(LateShiftUsageProvider),
});
export type LateShiftUsageBudget = typeof LateShiftUsageBudget.Type;
