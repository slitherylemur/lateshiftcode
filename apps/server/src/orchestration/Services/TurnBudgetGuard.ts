/**
 * TurnBudgetGuard - LateShift Cloud per-provider soft budget gate.
 *
 * Consulted by the orchestration decider at the single `thread.turn.start`
 * choke point (the same place `T3CODE_MAX_PROJECTS` is enforced). Given the
 * model-selection instance id of a turn about to start, it decides whether the
 * turn is allowed under the per-instance budget limits (LSC_LIMIT_*), returning
 * a friendly rejection message or `None` to allow.
 *
 * The decider reads this via `Effect.serviceOption`, so when the layer is not
 * provided (unit tests, non-LateShift builds) gating is simply off.
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

export interface TurnBudgetGuardShape {
  /**
   * Evaluate whether a turn on `instanceId` may start now. Returns
   * `Some(message)` to reject with that friendly detail, or `None` to allow.
   * Fail-open: never fails; a budget lookup error resolves to `None`.
   */
  readonly evaluateTurnStart: (input: {
    readonly instanceId: string;
    readonly nowIso: string;
  }) => Effect.Effect<Option.Option<string>>;
}

export class TurnBudgetGuard extends Context.Service<TurnBudgetGuard, TurnBudgetGuardShape>()(
  "t3/orchestration/Services/TurnBudgetGuard",
) {}
