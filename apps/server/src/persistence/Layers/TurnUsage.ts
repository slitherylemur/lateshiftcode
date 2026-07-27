import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  TurnUsageLedgerRow,
  TurnUsageRecord,
  TurnUsageRepository,
  type TurnUsageRepositoryShape,
} from "../Services/TurnUsage.ts";

const ListCompletedSinceInput = Schema.Struct({ sinceIso: Schema.String });

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeTurnUsageRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertTurnUsageRow = SqlSchema.void({
    Request: TurnUsageRecord,
    execute: (row) =>
      sql`
        INSERT OR IGNORE INTO turn_usage (
          event_id,
          thread_id,
          project_id,
          turn_id,
          provider_name,
          model,
          total_cost_usd,
          input_tokens,
          output_tokens,
          cached_input_tokens,
          reasoning_output_tokens,
          duration_ms,
          usage_json,
          completed_at
        )
        VALUES (
          ${row.eventId},
          ${row.threadId},
          ${row.projectId},
          ${row.turnId},
          ${row.providerName},
          ${row.model},
          ${row.totalCostUsd},
          ${row.inputTokens},
          ${row.outputTokens},
          ${row.cachedInputTokens},
          ${row.reasoningOutputTokens},
          ${row.durationMs},
          ${row.usageJson},
          ${row.completedAt}
        )
      `,
  });

  const listCompletedSinceRows = SqlSchema.findAll({
    Request: ListCompletedSinceInput,
    Result: TurnUsageLedgerRow,
    execute: ({ sinceIso }) =>
      sql`
        SELECT
          provider_name AS "providerName",
          total_cost_usd AS "totalCostUsd",
          completed_at AS "completedAt"
        FROM turn_usage
        WHERE completed_at >= ${sinceIso}
        ORDER BY completed_at ASC
      `,
  });

  const insert: TurnUsageRepositoryShape["insert"] = (row) =>
    insertTurnUsageRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("TurnUsageRepository.insert:query")),
    );

  const listCompletedSince: TurnUsageRepositoryShape["listCompletedSince"] = (sinceIso) =>
    listCompletedSinceRows({ sinceIso }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "TurnUsageRepository.listCompletedSince:query",
          "TurnUsageRepository.listCompletedSince:decodeRows",
        ),
      ),
    );

  return {
    insert,
    listCompletedSince,
  } satisfies TurnUsageRepositoryShape;
});

export const TurnUsageRepositoryLive = Layer.effect(TurnUsageRepository, makeTurnUsageRepository);
