/**
 * TurnUsageRepository - Append-only per-turn usage/cost ledger.
 *
 * One record per accepted provider `turn.completed` event. Consumed outside
 * the server by reading the `turn_usage` table in state.sqlite directly, so
 * the row shape mirrors the table schema (see migration 035_TurnUsageLedger).
 *
 * @module TurnUsageRepository
 */
import { IsoDateTime } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const TurnUsageRecord = Schema.Struct({
  eventId: Schema.String,
  threadId: Schema.String,
  projectId: Schema.NullOr(Schema.String),
  turnId: Schema.NullOr(Schema.String),
  providerName: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  totalCostUsd: Schema.NullOr(Schema.Number),
  inputTokens: Schema.NullOr(Schema.Int),
  outputTokens: Schema.NullOr(Schema.Int),
  cachedInputTokens: Schema.NullOr(Schema.Int),
  cacheCreationInputTokens: Schema.NullOr(Schema.Int),
  reasoningOutputTokens: Schema.NullOr(Schema.Int),
  durationMs: Schema.NullOr(Schema.Int),
  usageJson: Schema.NullOr(Schema.String),
  completedAt: IsoDateTime,
});
export type TurnUsageRecord = typeof TurnUsageRecord.Type;

/**
 * TurnUsageLedgerRow - Slim projection of a ledger row for budget aggregation
 * (provider, cost, completion time). Read by month-to-date / session-window
 * budget queries and the LateShift usage RPC.
 */
export const TurnUsageLedgerRow = Schema.Struct({
  providerName: Schema.NullOr(Schema.String),
  totalCostUsd: Schema.NullOr(Schema.Number),
  completedAt: IsoDateTime,
});
export type TurnUsageLedgerRow = typeof TurnUsageLedgerRow.Type;

/**
 * TurnUsageRepositoryShape - Service API for the per-turn usage ledger.
 */
export interface TurnUsageRepositoryShape {
  /**
   * Append one usage record. Never updates or deletes; the ledger is
   * append-only by design. Idempotent per `eventId`: replayed or duplicate
   * runtime events are ignored (INSERT OR IGNORE on the unique event_id).
   */
  readonly insert: (row: TurnUsageRecord) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Ledger rows whose `completed_at` is >= `sinceIso`, ordered oldest-first.
   * Used to aggregate month-to-date and rolling 5-hour-session budget totals.
   */
  readonly listCompletedSince: (
    sinceIso: string,
  ) => Effect.Effect<ReadonlyArray<TurnUsageLedgerRow>, ProjectionRepositoryError>;
}

/**
 * TurnUsageRepository - Service tag for the per-turn usage ledger.
 */
export class TurnUsageRepository extends Context.Service<
  TurnUsageRepository,
  TurnUsageRepositoryShape
>()("t3/persistence/Services/TurnUsage/TurnUsageRepository") {}
