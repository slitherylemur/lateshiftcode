// @effect-diagnostics globalDate:off - Fixed epoch literals converted with
// new Date() are the expected values these tests compare against; there is
// no clock involved.
import { describe, expect, it } from "vite-plus/test";

import {
  normalizeRateLimitsEvent,
  rateLimitProviderOf,
  resetsAtToIso,
} from "./rateLimitSnapshot.ts";

describe("rateLimitProviderOf", () => {
  it("buckets the driver names both adapters actually emit", () => {
    expect(rateLimitProviderOf("claudeAgent")).toBe("claude");
    expect(rateLimitProviderOf("codex")).toBe("codex");
    expect(rateLimitProviderOf("something-else")).toBe("other");
  });
});

describe("resetsAtToIso", () => {
  it("treats small integers as epoch seconds", () => {
    expect(resetsAtToIso(1_800_000_000)).toBe(new Date(1_800_000_000_000).toISOString());
  });

  it("treats large integers as epoch milliseconds", () => {
    expect(resetsAtToIso(1_800_000_000_000)).toBe(new Date(1_800_000_000_000).toISOString());
  });

  it("returns null rather than a bogus date", () => {
    expect(resetsAtToIso(null)).toBeNull();
    expect(resetsAtToIso(0)).toBeNull();
    expect(resetsAtToIso(-5)).toBeNull();
  });
});

const OBSERVED = "2026-07-29T12:00:00.000Z";

describe("normalizeRateLimitsEvent - claude", () => {
  it("reads the SDKRateLimitEvent shape the adapter forwards verbatim", () => {
    const windows = normalizeRateLimitsEvent(
      "claudeAgent",
      {
        rateLimits: {
          type: "rate_limit_event",
          uuid: "u",
          session_id: "s",
          rate_limit_info: {
            status: "allowed_warning",
            rateLimitType: "five_hour",
            utilization: 72,
            resetsAt: 1_800_000_000,
          },
        },
      },
      OBSERVED,
    );
    expect(windows).toEqual([
      {
        provider: "claude",
        windowKey: "five_hour",
        windowDurationMins: null,
        utilizationPercent: 72,
        status: "allowed_warning",
        resetsAtRaw: 1_800_000_000,
        resetsAtIso: new Date(1_800_000_000_000).toISOString(),
        observedAt: OBSERVED,
      },
    ]);
  });

  it("emits overage as its own window", () => {
    const windows = normalizeRateLimitsEvent(
      "claudeAgent",
      {
        rateLimits: {
          rate_limit_info: {
            status: "allowed",
            rateLimitType: "seven_day_opus",
            utilization: 10,
            overageStatus: "rejected",
            overageResetsAt: 1_800_000_500,
          },
        },
      },
      OBSERVED,
    );
    expect(windows.map((w) => w.windowKey)).toEqual(["seven_day_opus", "overage"]);
    expect(windows[1]?.status).toBe("rejected");
    expect(windows[1]?.utilizationPercent).toBeNull();
  });

  it("falls back to an 'unknown' window rather than dropping a status-only event", () => {
    const windows = normalizeRateLimitsEvent(
      "claudeAgent",
      { rateLimits: { rate_limit_info: { status: "rejected" } } },
      OBSERVED,
    );
    expect(windows).toHaveLength(1);
    expect(windows[0]?.windowKey).toBe("unknown");
    expect(windows[0]?.utilizationPercent).toBeNull();
    expect(windows[0]?.resetsAtRaw).toBeNull();
  });

  it("returns nothing for an empty payload instead of zeros", () => {
    expect(normalizeRateLimitsEvent("claudeAgent", { rateLimits: {} }, OBSERVED)).toEqual([]);
    expect(normalizeRateLimitsEvent("claudeAgent", null, OBSERVED)).toEqual([]);
    expect(normalizeRateLimitsEvent("claudeAgent", "nope", OBSERVED)).toEqual([]);
  });
});

describe("normalizeRateLimitsEvent - codex", () => {
  it("emits one window per present RateLimitWindow", () => {
    const windows = normalizeRateLimitsEvent(
      "codex",
      {
        rateLimits: {
          primary: { usedPercent: 41, resetsAt: 1_800_000_000, windowDurationMins: 300 },
          secondary: { usedPercent: 8, windowDurationMins: 10_080 },
          rateLimitReachedType: null,
          planType: "pro",
        },
      },
      OBSERVED,
    );
    expect(windows).toHaveLength(2);
    expect(windows[0]).toMatchObject({
      provider: "codex",
      windowKey: "primary",
      utilizationPercent: 41,
      windowDurationMins: 300,
      resetsAtRaw: 1_800_000_000,
      status: null,
    });
    expect(windows[1]).toMatchObject({
      windowKey: "secondary",
      utilizationPercent: 8,
      windowDurationMins: 10_080,
      resetsAtRaw: null,
      resetsAtIso: null,
    });
  });

  it("omits absent windows entirely (sparse updates must not zero anything)", () => {
    const windows = normalizeRateLimitsEvent(
      "codex",
      { rateLimits: { primary: { usedPercent: 55 } } },
      OBSERVED,
    );
    expect(windows.map((w) => w.windowKey)).toEqual(["primary"]);
  });

  it("carries rateLimitReachedType onto the windows when a limit is hit", () => {
    const windows = normalizeRateLimitsEvent(
      "codex",
      {
        rateLimits: {
          primary: { usedPercent: 100 },
          rateLimitReachedType: "rate_limit_reached",
        },
      },
      OBSERVED,
    );
    expect(windows[0]?.status).toBe("rate_limit_reached");
  });
});

describe("normalizeRateLimitsEvent - unknown provider", () => {
  it("returns nothing rather than guessing a shape", () => {
    expect(normalizeRateLimitsEvent("mystery", { rateLimits: { primary: {} } }, OBSERVED)).toEqual(
      [],
    );
  });
});
