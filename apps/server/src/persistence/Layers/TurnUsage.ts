import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  TurnUsageRecord,
  TurnUsageRepository,
  type TurnUsageRepositoryShape,
} from "../Services/TurnUsage.ts";

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

  const insert: TurnUsageRepositoryShape["insert"] = (row) =>
    insertTurnUsageRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("TurnUsageRepository.insert:query")),
    );

  return {
    insert,
  } satisfies TurnUsageRepositoryShape;
});

export const TurnUsageRepositoryLive = Layer.effect(TurnUsageRepository, makeTurnUsageRepository);
