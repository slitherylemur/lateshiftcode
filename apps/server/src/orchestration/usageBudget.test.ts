import { describe, expect, it } from "@effect/vitest";

import {
  budgetBucketForProvider,
  buildUsageBudget,
  computeCurrentWindow,
  computeUsageSnapshot,
  evaluateTurnBudget,
  hasAnyLimit,
  parseUsdLimit,
  resolveLateShiftLimits,
  startOfUtcMonthMs,
  WINDOW_MS,
  type UsageRow,
} from "./usageBudget.ts";

const NOW = Date.parse("2026-01-15T12:00:00.000Z");
const HOUR = 60 * 60 * 1_000;

describe("parseUsdLimit", () => {
  it("treats unset / empty / non-positive / non-finite as unlimited (null)", () => {
    for (const raw of [undefined, "", "   ", "0", "-5", "banana", "NaN"]) {
      expect(parseUsdLimit(raw)).toBeNull();
    }
  });
  it("parses positive decimals, trimming whitespace", () => {
    expect(parseUsdLimit("50")).toBe(50);
    expect(parseUsdLimit(" 12.50 ")).toBe(12.5);
  });
});

describe("resolveLateShiftLimits / hasAnyLimit", () => {
  it("reads all five env vars and reports whether anything is limited", () => {
    const none = resolveLateShiftLimits({});
    expect(none.totalUsd).toBeNull();
    expect(none.byProvider.claude.monthUsd).toBeNull();
    expect(hasAnyLimit(none)).toBe(false);

    const some = resolveLateShiftLimits({
      LSC_LIMIT_TOTAL_USD: "100",
      LSC_LIMIT_CLAUDE_USD: "50",
      LSC_LIMIT_CLAUDE_5H_USD: "10",
      LSC_LIMIT_CODEX_USD: "0",
      LSC_LIMIT_CODEX_5H_USD: "",
    });
    expect(some.totalUsd).toBe(100);
    expect(some.byProvider.claude.monthUsd).toBe(50);
    expect(some.byProvider.claude.windowUsd).toBe(10);
    expect(some.byProvider.codex.monthUsd).toBeNull();
    expect(some.byProvider.codex.windowUsd).toBeNull();
    expect(hasAnyLimit(some)).toBe(true);
  });
});

describe("budgetBucketForProvider", () => {
  it("maps provider names to buckets by case-insensitive substring", () => {
    expect(budgetBucketForProvider("claude")).toBe("claude");
    expect(budgetBucketForProvider("claudeAgent")).toBe("claude");
    expect(budgetBucketForProvider("anthropic-sonnet")).toBe("claude");
    expect(budgetBucketForProvider("codex")).toBe("codex");
    expect(budgetBucketForProvider("codex_work")).toBe("codex");
    expect(budgetBucketForProvider("openai")).toBe("codex");
    expect(budgetBucketForProvider("gpt-5")).toBe("codex");
    expect(budgetBucketForProvider("opencode")).toBeNull();
    expect(budgetBucketForProvider(null)).toBeNull();
    expect(budgetBucketForProvider("")).toBeNull();
  });
});

describe("startOfUtcMonthMs", () => {
  it("returns midnight on the 1st of the current UTC month", () => {
    expect(startOfUtcMonthMs(NOW)).toBe(Date.parse("2026-01-01T00:00:00.000Z"));
  });
});

describe("computeCurrentWindow", () => {
  it("returns null for no turns", () => {
    expect(computeCurrentWindow([], NOW)).toBeNull();
  });
  it("anchors at the first turn of a contiguous block and sums since the anchor", () => {
    const turns = [
      { completedAtMs: NOW - 2 * HOUR, costUsd: 3 },
      { completedAtMs: NOW - 1 * HOUR, costUsd: 4 },
    ];
    const window = computeCurrentWindow(turns, NOW);
    expect(window).not.toBeNull();
    expect(window?.startMs).toBe(NOW - 2 * HOUR);
    expect(window?.usedUsd).toBe(7);
    expect(window?.resetsAtMs).toBe(NOW - 2 * HOUR + WINDOW_MS);
  });
  it("re-anchors after a >= 5h inactivity gap", () => {
    const turns = [
      { completedAtMs: NOW - 10 * HOUR, costUsd: 100 },
      { completedAtMs: NOW - 1 * HOUR, costUsd: 5 },
    ];
    const window = computeCurrentWindow(turns, NOW);
    expect(window?.startMs).toBe(NOW - 1 * HOUR);
    expect(window?.usedUsd).toBe(5);
  });
  it("returns null when the most recent block has fully elapsed", () => {
    const turns = [{ completedAtMs: NOW - 6 * HOUR, costUsd: 9 }];
    expect(computeCurrentWindow(turns, NOW)).toBeNull();
  });
});

describe("computeUsageSnapshot", () => {
  const rows: ReadonlyArray<UsageRow> = [
    { provider: "claudeAgent", costUsd: 2, completedAtMs: NOW - 1 * HOUR },
    { provider: "claude", costUsd: 3, completedAtMs: NOW - 2 * HOUR },
    { provider: "codex", costUsd: null, completedAtMs: NOW - 1 * HOUR },
    { provider: "opencode", costUsd: 4, completedAtMs: NOW - 1 * HOUR },
    // Previous month: counts toward neither monthly total nor buckets.
    { provider: "claude", costUsd: 99, completedAtMs: Date.parse("2025-12-20T00:00:00.000Z") },
  ];
  it("buckets by substring, sums month + window, and totals across all providers", () => {
    const snapshot = computeUsageSnapshot(rows, NOW);
    // Total = current-month costs across ALL providers (null -> 0): 2 + 3 + 0 + 4 = 9.
    expect(snapshot.totalMonthUsedUsd).toBe(9);
    const claude = snapshot.byProvider.get("claude");
    expect(claude?.monthUsedUsd).toBe(5);
    expect(claude?.window?.usedUsd).toBe(5);
    const codex = snapshot.byProvider.get("codex");
    expect(codex?.monthUsedUsd).toBe(0);
    // opencode has no bucket.
    expect(snapshot.byProvider.get("opencode")).toBeUndefined();
  });
});

describe("evaluateTurnBudget", () => {
  const rows: ReadonlyArray<UsageRow> = [
    { provider: "claude", costUsd: 12, completedAtMs: NOW - 1 * HOUR },
    { provider: "codex", costUsd: 3, completedAtMs: NOW - 1 * HOUR },
  ];
  const snapshot = computeUsageSnapshot(rows, NOW);

  it("allows when nothing is limited", () => {
    const limits = resolveLateShiftLimits({});
    expect(evaluateTurnBudget({ instanceId: "claude", snapshot, limits, nowMs: NOW })).toBeNull();
  });

  it("rejects on the total budget first, for any provider", () => {
    const limits = resolveLateShiftLimits({ LSC_LIMIT_TOTAL_USD: "10" });
    const detail = evaluateTurnBudget({ instanceId: "codex", snapshot, limits, nowMs: NOW });
    expect(detail).toContain("Total budget reached ($10.00/mo)");
  });

  it("rejects a provider's monthly budget", () => {
    const limits = resolveLateShiftLimits({ LSC_LIMIT_CLAUDE_USD: "10" });
    const detail = evaluateTurnBudget({ instanceId: "claudeAgent", snapshot, limits, nowMs: NOW });
    expect(detail).toContain("Claude budget reached ($10.00/mo)");
  });

  it("rejects a provider's 5h session budget with a reset hint", () => {
    const limits = resolveLateShiftLimits({ LSC_LIMIT_CLAUDE_5H_USD: "10" });
    const detail = evaluateTurnBudget({ instanceId: "claude", snapshot, limits, nowMs: NOW });
    expect(detail).toContain("Claude session budget reached (~$10.00/5h)");
    expect(detail).toContain("Resets in");
  });

  it("does not gate a provider with no matching bucket", () => {
    const limits = resolveLateShiftLimits({ LSC_LIMIT_CLAUDE_USD: "1" });
    expect(evaluateTurnBudget({ instanceId: "opencode", snapshot, limits, nowMs: NOW })).toBeNull();
  });

  it("keeps other providers working when one is over budget", () => {
    const limits = resolveLateShiftLimits({ LSC_LIMIT_CLAUDE_USD: "1" });
    expect(evaluateTurnBudget({ instanceId: "codex", snapshot, limits, nowMs: NOW })).toBeNull();
    expect(
      evaluateTurnBudget({ instanceId: "claude", snapshot, limits, nowMs: NOW }),
    ).not.toBeNull();
  });
});

describe("buildUsageBudget", () => {
  it("shapes the RPC payload with per-provider lines and total", () => {
    const rows: ReadonlyArray<UsageRow> = [
      { provider: "claude", costUsd: 5, completedAtMs: NOW - 1 * HOUR },
    ];
    const snapshot = computeUsageSnapshot(rows, NOW);
    const limits = resolveLateShiftLimits({
      LSC_LIMIT_TOTAL_USD: "100",
      LSC_LIMIT_CLAUDE_USD: "50",
      LSC_LIMIT_CLAUDE_5H_USD: "10",
    });
    const budget = buildUsageBudget({ userName: "octocat", snapshot, limits, nowMs: NOW });
    expect(budget.userName).toBe("octocat");
    expect(budget.totalUsedUsd).toBe(5);
    expect(budget.totalLimitUsd).toBe(100);
    expect(budget.hasAnyLimit).toBe(true);
    const claude = budget.providers.find((provider) => provider.id === "claude");
    expect(claude?.monthUsedUsd).toBe(5);
    expect(claude?.monthLimitUsd).toBe(50);
    expect(claude?.windowUsedUsd).toBe(5);
    expect(claude?.windowLimitUsd).toBe(10);
    expect(claude?.windowLengthHours).toBe(5);
    expect(claude?.windowResetsAt).not.toBeNull();
  });
});
