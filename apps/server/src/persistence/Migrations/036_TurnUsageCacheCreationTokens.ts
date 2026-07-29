import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

/**
 * Add `cache_creation_input_tokens` to the per-turn usage ledger.
 *
 * The ledger (migration 035) normalised input, output, cache-*read* and
 * reasoning tokens but had no column for cache *writes*, and no alias list in
 * `ProviderRuntimeIngestion` matched `cache_creation_input_tokens`, so the
 * value survived only inside the opaque `usage_json` blob. Cache creation is
 * billed differently from cache reads and is a material share of consumption
 * on long agent turns, so attribution needs it as a first-class column.
 *
 * LateShift-owned migration. Note the rebase hazard already introduced by 035:
 * if upstream ever adds its own migration 36 the numbers collide and
 * `update-from-upstream.sh` will need a manual renumber of the LateShift
 * entries. Keep LateShift migrations contiguous at the end of the list so that
 * renumbering is mechanical.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE turn_usage ADD COLUMN cache_creation_input_tokens INTEGER
  `;
});
