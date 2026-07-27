import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { TurnUsageRepository } from "../../persistence/Services/TurnUsage.ts";
import { TurnUsageRepositoryLive } from "../../persistence/Layers/TurnUsage.ts";
import { TurnBudgetGuard, type TurnBudgetGuardShape } from "../Services/TurnBudgetGuard.ts";
import {
  computeUsageSnapshot,
  evaluateTurnBudget,
  hasAnyLimit,
  resolveLateShiftLimits,
  startOfUtcMonthMs,
} from "../usageBudget.ts";

// Fetch a little more than the current month so the 5h session window can be
// anchored correctly across a month boundary.
const WINDOW_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1_000;

const makeTurnBudgetGuard = Effect.gen(function* () {
  const repository = yield* TurnUsageRepository;

  const evaluateTurnStart: TurnBudgetGuardShape["evaluateTurnStart"] = ({ instanceId, nowIso }) =>
    Effect.gen(function* () {
      const limits = resolveLateShiftLimits();
      // Nothing is limited: never read the ledger, always allow.
      if (!hasAnyLimit(limits)) return Option.none<string>();
      const parsedNow = Date.parse(nowIso);
      const nowMs = Number.isFinite(parsedNow)
        ? parsedNow
        : (yield* DateTime.now).epochMilliseconds;
      const sinceMs = Math.min(startOfUtcMonthMs(nowMs), nowMs - WINDOW_LOOKBACK_MS);
      const sinceIso = DateTime.formatIso(DateTime.makeUnsafe(sinceMs));
      const rows = yield* repository.listCompletedSince(sinceIso);
      const snapshot = computeUsageSnapshot(
        rows.flatMap((row) => {
          const completedAtMs = Date.parse(row.completedAt);
          return Number.isFinite(completedAtMs)
            ? [{ provider: row.providerName, costUsd: row.totalCostUsd, completedAtMs }]
            : [];
        }),
        nowMs,
      );
      const detail = evaluateTurnBudget({ instanceId, snapshot, limits, nowMs });
      return detail === null ? Option.none<string>() : Option.some(detail);
    }).pipe(
      // Fail-open: budget enforcement must never crash or block a turn on error.
      Effect.catchCause((cause) =>
        Effect.logWarning("turn budget guard evaluation failed; allowing turn", {
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(Option.none<string>())),
      ),
    );

  return { evaluateTurnStart } satisfies TurnBudgetGuardShape;
});

export const TurnBudgetGuardLive = Layer.effect(TurnBudgetGuard, makeTurnBudgetGuard).pipe(
  Layer.provide(TurnUsageRepositoryLive),
);
