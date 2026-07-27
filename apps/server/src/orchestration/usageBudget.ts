/**
 * LateShift Cloud — per-user usage budget math.
 *
 * Pure helpers shared by the `server.getUsageBudget` RPC (display) and the
 * orchestration decider (soft gating). No IO: callers hand in the raw
 * `turn_usage` rows they read from SQLite and the current time; everything
 * here is deterministic and unit-testable.
 *
 * Budget model
 * ------------
 * - Monthly: sum of `total_cost_usd` for a provider since the start of the
 *   current UTC month.
 * - Rolling 5-hour session window: approximates Claude/ChatGPT session windows.
 *   Turns are grouped into fixed 5-hour blocks; a new block is anchored at the
 *   first turn that lands at or after the previous block has elapsed (which also
 *   covers the ">= 5 hours of inactivity" case). The current block is the most
 *   recent one; if it has fully elapsed (no turn within the last 5h) there is no
 *   active window. Current-window usage is the sum of costs since the block
 *   start; the window resets at `blockStart + 5h`.
 *
 * Limits come from `instance.env`. A limit of `null` (env unset, empty, or
 * <= 0) means unlimited. All amounts are USD.
 */

import type { LateShiftUsageBudget } from "@t3tools/contracts";

export const WINDOW_MS = 5 * 60 * 60 * 1_000;

/** Providers that carry configurable budgets, in display order. */
export const BUDGET_PROVIDERS = [
  {
    id: "claude",
    label: "Claude",
    monthEnv: "LSC_LIMIT_CLAUDE_USD",
    windowEnv: "LSC_LIMIT_CLAUDE_5H_USD",
  },
  {
    id: "codex",
    label: "Codex",
    monthEnv: "LSC_LIMIT_CODEX_USD",
    windowEnv: "LSC_LIMIT_CODEX_5H_USD",
  },
] as const;

export type BudgetProviderId = (typeof BUDGET_PROVIDERS)[number]["id"];

export interface ProviderLimits {
  readonly monthUsd: number | null;
  readonly windowUsd: number | null;
}

export interface LateShiftLimits {
  readonly totalUsd: number | null;
  readonly byProvider: Readonly<Record<BudgetProviderId, ProviderLimits>>;
}

export interface UsageTurn {
  readonly completedAtMs: number;
  readonly costUsd: number;
}

export interface WindowUsage {
  readonly startMs: number;
  readonly usedUsd: number;
  readonly resetsAtMs: number;
}

export interface ProviderAggregate {
  readonly monthUsedUsd: number;
  readonly window: WindowUsage | null;
}

export interface UsageSnapshot {
  readonly totalMonthUsedUsd: number;
  readonly byProvider: ReadonlyMap<string, ProviderAggregate>;
}

/** Parse a USD limit env var. Unset / empty / non-finite / <= 0 => unlimited (null). */
export const parseUsdLimit = (raw: string | undefined): number | null => {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
};

/** Resolve all LateShift budget limits from the environment (defaults to process.env). */
export const resolveLateShiftLimits = (
  env: Record<string, string | undefined> = process.env,
): LateShiftLimits => ({
  totalUsd: parseUsdLimit(env["LSC_LIMIT_TOTAL_USD"]),
  byProvider: Object.fromEntries(
    BUDGET_PROVIDERS.map((provider) => [
      provider.id,
      {
        monthUsd: parseUsdLimit(env[provider.monthEnv]),
        windowUsd: parseUsdLimit(env[provider.windowEnv]),
      },
    ]),
  ) as Record<BudgetProviderId, ProviderLimits>,
});

export const hasAnyLimit = (limits: LateShiftLimits): boolean =>
  limits.totalUsd !== null ||
  BUDGET_PROVIDERS.some(
    (provider) =>
      limits.byProvider[provider.id].monthUsd !== null ||
      limits.byProvider[provider.id].windowUsd !== null,
  );

/** Start of the current UTC month, in epoch ms. */
export const startOfUtcMonthMs = (nowMs: number): number => {
  const now = new Date(nowMs);
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
};

/**
 * Current 5-hour session window for a single provider, or null when no window
 * is active (no turns within the last 5h). `turns` MUST be sorted ascending by
 * `completedAtMs`.
 */
export const computeCurrentWindow = (
  turns: ReadonlyArray<UsageTurn>,
  nowMs: number,
): WindowUsage | null => {
  if (turns.length === 0) return null;
  let anchorMs = turns[0].completedAtMs;
  for (const turn of turns) {
    // A turn at or after the current block has elapsed opens a fresh block.
    // This also covers a >= 5h inactivity gap (the gap pushes the turn past
    // anchor + WINDOW_MS).
    if (turn.completedAtMs >= anchorMs + WINDOW_MS) {
      anchorMs = turn.completedAtMs;
    }
  }
  const resetsAtMs = anchorMs + WINDOW_MS;
  // The most recent block has fully elapsed: the session window has reset and
  // no new turn has opened a new one yet.
  if (nowMs >= resetsAtMs) return null;
  let usedUsd = 0;
  for (const turn of turns) {
    if (turn.completedAtMs >= anchorMs) usedUsd += turn.costUsd;
  }
  return { startMs: anchorMs, usedUsd, resetsAtMs };
};

export interface UsageRow {
  readonly provider: string | null;
  readonly costUsd: number | null;
  readonly completedAtMs: number;
}

/**
 * Aggregate raw ledger rows into month-to-date and current-window usage,
 * bucketed by budget provider (claude / codex). Rows whose `provider_name`
 * maps to no bucket still count toward the total. Rows may span more than the
 * current month (needed to anchor the 5h window across a month boundary); only
 * rows in the current UTC month count toward monthly totals. Null costs count
 * as 0.
 */
export const computeUsageSnapshot = (
  rows: ReadonlyArray<UsageRow>,
  nowMs: number,
): UsageSnapshot => {
  const monthStartMs = startOfUtcMonthMs(nowMs);
  const turnsByBucket = new Map<string, UsageTurn[]>();
  let totalMonthUsedUsd = 0;
  for (const row of rows) {
    const costUsd = row.costUsd ?? 0;
    if (row.completedAtMs >= monthStartMs) totalMonthUsedUsd += costUsd;
    const bucket = budgetBucketForProvider(row.provider);
    if (bucket === null) continue;
    const list = turnsByBucket.get(bucket) ?? [];
    list.push({ completedAtMs: row.completedAtMs, costUsd });
    turnsByBucket.set(bucket, list);
  }
  const byProvider = new Map<string, ProviderAggregate>();
  for (const [bucket, turns] of turnsByBucket) {
    turns.sort((a, b) => a.completedAtMs - b.completedAtMs);
    const monthUsedUsd = turns.reduce(
      (sum, turn) => (turn.completedAtMs >= monthStartMs ? sum + turn.costUsd : sum),
      0,
    );
    byProvider.set(bucket, {
      monthUsedUsd,
      window: computeCurrentWindow(turns, nowMs),
    });
  }
  return { totalMonthUsedUsd, byProvider };
};

const EMPTY_AGGREGATE: ProviderAggregate = { monthUsedUsd: 0, window: null };

export const providerAggregate = (snapshot: UsageSnapshot, providerId: string): ProviderAggregate =>
  snapshot.byProvider.get(providerId) ?? EMPTY_AGGREGATE;

export const formatUsd = (value: number): string => `$${value.toFixed(2)}`;

const formatDuration = (ms: number): string => {
  const totalMinutes = Math.max(0, Math.ceil(ms / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
};

/**
 * Map a provider identifier to its budget bucket by case-insensitive substring.
 * Used both for `turn_usage.provider_name` values (which the runtime writes as
 * driver ids like `claude`, `claudeAgent`, `codex`) and for the model
 * selection instance id of a turn about to start (`claude`, `codex_work`).
 *
 *   contains claude / anthropic -> claude
 *   contains codex / openai / gpt -> codex
 *   anything else -> null (no per-provider budget; still counts toward total)
 */
export const budgetBucketForProvider = (id: string | null): BudgetProviderId | null => {
  if (id === null) return null;
  const normalized = id.trim().toLowerCase();
  if (normalized === "") return null;
  if (normalized.includes("claude") || normalized.includes("anthropic")) return "claude";
  if (normalized.includes("codex") || normalized.includes("openai") || normalized.includes("gpt")) {
    return "codex";
  }
  return null;
};

/**
 * Build the wire payload for the `server.getUsageBudget` RPC from a computed
 * snapshot, the resolved limits, and the signed-in user name.
 */
export const buildUsageBudget = (input: {
  readonly userName: string | null;
  readonly snapshot: UsageSnapshot;
  readonly limits: LateShiftLimits;
  readonly nowMs: number;
}): LateShiftUsageBudget => {
  const providers = BUDGET_PROVIDERS.map((provider) => {
    const aggregate = providerAggregate(input.snapshot, provider.id);
    const providerLimits = input.limits.byProvider[provider.id];
    return {
      id: provider.id,
      label: provider.label,
      monthUsedUsd: aggregate.monthUsedUsd,
      monthLimitUsd: providerLimits.monthUsd,
      windowUsedUsd: aggregate.window?.usedUsd ?? 0,
      windowLimitUsd: providerLimits.windowUsd,
      windowResetsAt:
        aggregate.window === null ? null : new Date(aggregate.window.resetsAtMs).toISOString(),
      windowLengthHours: WINDOW_MS / (60 * 60 * 1_000),
    };
  });
  return {
    userName: input.userName,
    totalUsedUsd: input.snapshot.totalMonthUsedUsd,
    totalLimitUsd: input.limits.totalUsd,
    hasAnyLimit: hasAnyLimit(input.limits),
    providers,
  };
};

/**
 * Soft-gating decision for a turn about to start on `instanceId`. Returns a
 * friendly rejection message when a budget is reached, or null to allow. The
 * "worst" (longest-lived) constraint wins: total, then monthly, then the 5h
 * window.
 */
export const evaluateTurnBudget = (input: {
  readonly instanceId: string;
  readonly snapshot: UsageSnapshot;
  readonly limits: LateShiftLimits;
  readonly nowMs: number;
}): string | null => {
  const { instanceId, snapshot, limits, nowMs } = input;
  if (limits.totalUsd !== null && snapshot.totalMonthUsedUsd >= limits.totalUsd) {
    return `Total budget reached (${formatUsd(limits.totalUsd)}/mo). Ask your admin.`;
  }
  const bucket = budgetBucketForProvider(instanceId);
  if (bucket === null) return null;
  const label = BUDGET_PROVIDERS.find((provider) => provider.id === bucket)?.label ?? bucket;
  const providerLimits = limits.byProvider[bucket];
  const aggregate = providerAggregate(snapshot, bucket);
  if (providerLimits.monthUsd !== null && aggregate.monthUsedUsd >= providerLimits.monthUsd) {
    return `${label} budget reached (${formatUsd(providerLimits.monthUsd)}/mo). Ask your admin.`;
  }
  if (
    providerLimits.windowUsd !== null &&
    aggregate.window !== null &&
    aggregate.window.usedUsd >= providerLimits.windowUsd
  ) {
    return `${label} session budget reached (~${formatUsd(
      providerLimits.windowUsd,
    )}/5h). Resets in ${formatDuration(aggregate.window.resetsAtMs - nowMs)}.`;
  }
  return null;
};
