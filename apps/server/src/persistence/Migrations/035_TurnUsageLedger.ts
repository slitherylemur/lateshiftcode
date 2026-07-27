import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

/**
 * Per-turn usage/cost ledger.
 *
 * One row is appended for every accepted provider `turn.completed` event.
 * Token/cost columns are nullable because not every provider reports usage
 * (e.g. codex omits it); `usage_json` preserves the raw provider payload for
 * consumers that want more detail than the normalized columns.
 *
 * This table is read directly from state.sqlite by external tooling (the
 * LateShift portal); treat the schema as a public contract.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS turn_usage (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      project_id TEXT,
      turn_id TEXT,
      provider_name TEXT,
      model TEXT,
      total_cost_usd REAL,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cached_input_tokens INTEGER,
      reasoning_output_tokens INTEGER,
      duration_ms INTEGER,
      usage_json TEXT,
      completed_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_turn_usage_completed_at
    ON turn_usage (completed_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_turn_usage_thread_id
    ON turn_usage (thread_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_turn_usage_project_id
    ON turn_usage (project_id)
  `;
});
