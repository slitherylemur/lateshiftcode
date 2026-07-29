/**
 * LateShift: give Codex `turn.completed` events a real usage payload.
 *
 * ## The problem
 *
 * `CodexAdapter`'s `turn/completed` mapping emits `turn.completed` with only
 * `{state, errorMessage?}` - no `usage`, no `modelUsage`, no `totalCostUsd`.
 * `ProviderRuntimeIngestion` appends one `turn_usage` ledger row per accepted
 * `turn.completed`, so every Codex turn writes a row of NULLs. Any leaderboard
 * built on that ledger is therefore systematically wrong in Claude's favour:
 * Codex work appears to cost nothing.
 *
 * ## The data that does exist
 *
 * Codex sends `thread/tokenUsage/updated` (mapped to the runtime event
 * `thread.token-usage.updated`) carrying
 * `{total: Breakdown, last: Breakdown, modelContextWindow?}` where `Breakdown`
 * is `{inputTokens, cachedInputTokens, cacheWriteInputTokens?, outputTokens,
 * reasoningOutputTokens, totalTokens}`. `last` is the most recent model
 * request; `total` is cumulative for the thread.
 *
 * ## What this tracker does
 *
 * One instance per Codex session (i.e. per thread's event loop). It watches the
 * raw provider events and, when a turn completes, attaches the tokens consumed
 * *during that turn* to the outgoing `turn.completed` event:
 *
 *  - `turn/started` records a baseline of the thread's cumulative
 *    `total.totalTokens`.
 *  - each `thread/tokenUsage/updated` adds its `last` breakdown to the
 *    in-flight turn's accumulator. Updates whose cumulative `total.totalTokens`
 *    is unchanged are treated as repeats and skipped, so a redelivered
 *    notification cannot double-count.
 *  - `turn/completed` emits the accumulated per-field counts, plus
 *    `total_tokens` taken from the cumulative delta when the baseline is known
 *    (that is the authoritative figure) and from the accumulator otherwise.
 *
 * Key shapes are the snake_case aliases `ProviderRuntimeIngestion` already
 * looks for (`input_tokens`, `output_tokens`, `cache_read_input_tokens`,
 * `cache_creation_input_tokens`, `reasoning_output_tokens`), so the ledger
 * columns populate with no change to the reader.
 *
 * ## What it deliberately does not do
 *
 *  - It never invents a dollar cost. Codex reports none, `totalCostUsd` stays
 *    absent, and the ledger's `total_cost_usd` stays NULL. Cost for Codex is
 *    unknown, and "unknown" is the honest answer (architecture-v2 principle 3).
 *  - If no token data was seen for a turn, it leaves the event exactly as it
 *    was. A NULL row is better than a fabricated one.
 *  - It never overwrites a `usage` payload that the adapter already produced.
 *
 * ## Known ordering assumption (not verified against a live Codex session)
 *
 * We assume the final `thread/tokenUsage/updated` for a turn is delivered
 * before that turn's `turn/completed`. Both arrive on the same ordered
 * notification stream, but this has not been observed end-to-end. If Codex ever
 * emits the last usage update *after* completion, the affected turn undercounts
 * by its final request rather than failing - and the next turn's baseline still
 * comes from the cumulative total, so the error does not compound.
 *
 * @module lateshift/codexTurnUsage
 */

/** Per-turn token accumulator, in the key names the ledger reader expects. */
interface TokenAccumulator {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
}

/** Usage object attached to `turn.completed`. Fields present only when > 0. */
export interface CodexTurnUsagePayload {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cache_read_input_tokens?: number;
  readonly cache_creation_input_tokens?: number;
  readonly reasoning_output_tokens?: number;
  readonly total_tokens?: number;
  /** Provenance marker so a ledger row's `usage_json` is self-describing. */
  readonly source: "codex.thread.token-usage";
}

interface TurnState {
  /** Cumulative `total.totalTokens` at turn start, or null if unknown. */
  readonly baselineTotal: number | null;
  readonly acc: TokenAccumulator;
  sawUpdate: boolean;
}

function emptyAccumulator(): TokenAccumulator {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function asOptionalCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Minimal shape of the raw Codex provider event we need. */
export interface CodexProviderEventLike {
  readonly method: string;
  readonly payload?: unknown;
}

/**
 * Tracker for one Codex session. Not thread-safe and not shared: create one per
 * session event loop, where events for a single thread arrive in order.
 */
export interface CodexTurnUsageTracker {
  /**
   * Fold a raw provider event into the tracker. Call this for every event,
   * before the mapped runtime events are enqueued.
   */
  readonly observe: (event: CodexProviderEventLike) => void;
  /**
   * Usage for the turn that just completed, or `undefined` when nothing real
   * was observed. Calling this clears the in-flight turn state, so call it
   * exactly once per `turn/completed`.
   */
  readonly takeCompletedTurnUsage: () => CodexTurnUsagePayload | undefined;
}

export function makeCodexTurnUsageTracker(): CodexTurnUsageTracker {
  /** Latest cumulative `total.totalTokens` seen for this thread. */
  let cumulativeTotal: number | null = null;
  let turn: TurnState | null = null;

  const startTurn = (): void => {
    turn = { baselineTotal: cumulativeTotal, acc: emptyAccumulator(), sawUpdate: false };
  };

  const applyTokenUsage = (payload: unknown): void => {
    const record = asRecord(payload);
    const tokenUsage = record ? asRecord(record["tokenUsage"]) : null;
    if (tokenUsage === null) return;
    const total = asRecord(tokenUsage["total"]);
    const last = asRecord(tokenUsage["last"]);
    const totalTokens = total ? asOptionalCount(total["totalTokens"]) : null;

    // A repeated notification carries an unchanged cumulative total. Skip it so
    // its `last` breakdown is not counted twice.
    const isRepeat =
      totalTokens !== null && cumulativeTotal !== null && totalTokens === cumulativeTotal;
    if (totalTokens !== null) cumulativeTotal = totalTokens;
    if (isRepeat || last === null) return;

    // An update with no active turn (e.g. resumed thread, or usage arriving
    // between turns) only advances the cumulative total; it is not attributed.
    if (turn === null) return;

    const lastTotal = asCount(last["totalTokens"]);
    if (lastTotal === 0) return;

    turn.acc.input_tokens += asCount(last["inputTokens"]);
    turn.acc.output_tokens += asCount(last["outputTokens"]);
    turn.acc.cache_read_input_tokens += asCount(last["cachedInputTokens"]);
    turn.acc.cache_creation_input_tokens += asCount(last["cacheWriteInputTokens"]);
    turn.acc.reasoning_output_tokens += asCount(last["reasoningOutputTokens"]);
    turn.acc.total_tokens += lastTotal;
    turn.sawUpdate = true;
  };

  return {
    observe: (event) => {
      switch (event.method) {
        case "turn/started":
          startTurn();
          return;
        case "thread/tokenUsage/updated":
          applyTokenUsage(event.payload);
          return;
        default:
          return;
      }
    },

    takeCompletedTurnUsage: () => {
      const completed = turn;
      turn = null;
      if (completed === null || !completed.sawUpdate) return undefined;

      // Prefer the cumulative delta for the headline total: it is the
      // provider's own arithmetic and survives a missed intermediate update.
      const delta =
        completed.baselineTotal !== null && cumulativeTotal !== null
          ? cumulativeTotal - completed.baselineTotal
          : null;
      const totalTokens = delta !== null && delta > 0 ? delta : completed.acc.total_tokens;

      const usage: Record<string, number | string> = { source: "codex.thread.token-usage" };
      for (const [key, value] of Object.entries(completed.acc)) {
        if (key === "total_tokens") continue;
        if (value > 0) usage[key] = value;
      }
      if (totalTokens > 0) usage["total_tokens"] = totalTokens;
      return usage as unknown as CodexTurnUsagePayload;
    },
  };
}

/**
 * Fold a raw Codex provider event into `tracker`, then attach the resulting
 * per-turn usage to any `turn.completed` runtime event the adapter produced
 * from it.
 *
 * Generic over the runtime-event type so this module stays free of a
 * `@t3tools/contracts` import and cannot conflict with upstream schema churn.
 * An existing `usage` payload is never overwritten.
 */
export function attachCodexTurnUsage<
  E extends { readonly type: string; readonly payload: unknown },
>(
  tracker: CodexTurnUsageTracker,
  rawEvent: CodexProviderEventLike,
  events: ReadonlyArray<E>,
): ReadonlyArray<E> {
  tracker.observe(rawEvent);
  if (!events.some((event) => event.type === "turn.completed")) return events;

  const usage = tracker.takeCompletedTurnUsage();
  if (usage === undefined) return events;

  return events.map((event) => {
    if (event.type !== "turn.completed") return event;
    const payload = asRecord(event.payload);
    if (payload === null || payload["usage"] !== undefined) return event;
    return { ...event, payload: { ...payload, usage } } as E;
  });
}
