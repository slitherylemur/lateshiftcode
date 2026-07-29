import { describe, expect, it } from "vite-plus/test";

import { makeCodexTurnUsageTracker } from "./codexTurnUsage.ts";

function breakdown(input: number, output: number, cachedRead = 0, cacheWrite = 0, reasoning = 0) {
  return {
    inputTokens: input,
    cachedInputTokens: cachedRead,
    cacheWriteInputTokens: cacheWrite,
    outputTokens: output,
    reasoningOutputTokens: reasoning,
    totalTokens: input + output + cachedRead + cacheWrite + reasoning,
  };
}

function usageEvent(total: number, last: ReturnType<typeof breakdown>) {
  return {
    method: "thread/tokenUsage/updated",
    payload: { tokenUsage: { total: { ...last, totalTokens: total }, last } },
  };
}

describe("makeCodexTurnUsageTracker", () => {
  it("accumulates the per-request breakdowns seen during a turn", () => {
    const t = makeCodexTurnUsageTracker();
    t.observe({ method: "turn/started" });
    t.observe(usageEvent(100, breakdown(60, 40)));
    t.observe(usageEvent(260, breakdown(100, 50, 10)));
    const usage = t.takeCompletedTurnUsage();
    expect(usage).toEqual({
      source: "codex.thread.token-usage",
      input_tokens: 160,
      output_tokens: 90,
      cache_read_input_tokens: 10,
      total_tokens: 260,
    });
  });

  it("attributes only the current turn, using the cumulative baseline", () => {
    const t = makeCodexTurnUsageTracker();
    t.observe({ method: "turn/started" });
    t.observe(usageEvent(100, breakdown(60, 40)));
    expect(t.takeCompletedTurnUsage()).toMatchObject({ total_tokens: 100 });

    t.observe({ method: "turn/started" });
    t.observe(usageEvent(180, breakdown(50, 30)));
    // 180 cumulative - 100 baseline = 80 for this turn, not 180.
    expect(t.takeCompletedTurnUsage()).toMatchObject({
      input_tokens: 50,
      output_tokens: 30,
      total_tokens: 80,
    });
  });

  it("ignores a redelivered notification (unchanged cumulative total)", () => {
    const t = makeCodexTurnUsageTracker();
    t.observe({ method: "turn/started" });
    t.observe(usageEvent(100, breakdown(60, 40)));
    t.observe(usageEvent(100, breakdown(60, 40)));
    expect(t.takeCompletedTurnUsage()).toMatchObject({
      input_tokens: 60,
      output_tokens: 40,
      total_tokens: 100,
    });
  });

  it("returns undefined when no token data was observed - never a zero row", () => {
    const t = makeCodexTurnUsageTracker();
    t.observe({ method: "turn/started" });
    expect(t.takeCompletedTurnUsage()).toBeUndefined();
  });

  it("returns undefined when a turn never started", () => {
    const t = makeCodexTurnUsageTracker();
    t.observe(usageEvent(100, breakdown(60, 40)));
    expect(t.takeCompletedTurnUsage()).toBeUndefined();
  });

  it("clears state so a second call for the same turn yields nothing", () => {
    const t = makeCodexTurnUsageTracker();
    t.observe({ method: "turn/started" });
    t.observe(usageEvent(100, breakdown(60, 40)));
    expect(t.takeCompletedTurnUsage()).toBeDefined();
    expect(t.takeCompletedTurnUsage()).toBeUndefined();
  });

  it("carries cache write tokens through under the cache_creation alias", () => {
    const t = makeCodexTurnUsageTracker();
    t.observe({ method: "turn/started" });
    t.observe(usageEvent(300, breakdown(100, 50, 25, 125, 0)));
    expect(t.takeCompletedTurnUsage()).toMatchObject({
      cache_creation_input_tokens: 125,
      cache_read_input_tokens: 25,
    });
  });

  it("survives malformed payloads without throwing or inventing numbers", () => {
    const t = makeCodexTurnUsageTracker();
    t.observe({ method: "turn/started" });
    t.observe({ method: "thread/tokenUsage/updated", payload: null });
    t.observe({ method: "thread/tokenUsage/updated", payload: { tokenUsage: {} } });
    t.observe({ method: "thread/tokenUsage/updated" });
    expect(t.takeCompletedTurnUsage()).toBeUndefined();
  });
});
