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
  threadId: Schema.String,
  projectId: Schema.NullOr(Schema.String),
  turnId: Schema.NullOr(Schema.String),
  providerName: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  totalCostUsd: Schema.NullOr(Schema.Number),
  inputTokens: Schema.NullOr(Schema.Int),
  outputTokens: Schema.NullOr(Schema.Int),
  cachedInputTokens: Schema.NullOr(Schema.Int),
  reasoningOutputTokens: Schema.NullOr(Schema.Int),
  durationMs: Schema.NullOr(Schema.Int),
  usageJson: Schema.NullOr(Schema.String),
  completedAt: IsoDateTime,
});
export type TurnUsageRecord = typeof TurnUsageRecord.Type;

/**
 * TurnUsageRepositoryShape - Service API for the per-turn usage ledger.
 */
export interface TurnUsageRepositoryShape {
  /**
   * Append one usage record. Never updates or deletes; the ledger is
   * append-only by design.
   */
  readonly insert: (row: TurnUsageRecord) => Effect.Effect<void, ProjectionRepositoryError>;
}

/**
 * TurnUsageRepository - Service tag for the per-turn usage ledger.
 */
export class TurnUsageRepository extends Context.Service<
  TurnUsageRepository,
  TurnUsageRepositoryShape
>()("t3/persistence/Services/TurnUsage/TurnUsageRepository") {}
