/**
 * LateShift: normalization of the `account.rate-limits.updated` runtime event.
 *
 * Both provider adapters already receive real subscription rate-limit data and
 * (upstream) throw it away: the contract types the payload as `Schema.Unknown`
 * and no consumer exists. This module is the LateShift-owned consumer's pure
 * core: it turns either provider's opaque payload into a small, uniform record
 * per rate-limit *window*.
 *
 * Design rules (architecture-v2 section 4, principle 3 "never fabricate a
 * number"):
 *  - Every field is nullable. If the provider did not send it, it is `null`,
 *    never a default, never an extrapolation.
 *  - `resetsAt` is preserved verbatim as the provider's own integer in
 *    `resetsAtRaw`. `resetsAtIso` is a best-effort convenience only.
 *  - The window key is the provider's own label (`five_hour`, `primary`, ...).
 *    Callers must NOT rename these to "weekly"/"daily": both providers' reset
 *    behaviour is reported as inconsistent with their labels.
 *
 * This file is fork-owned and new; it contains no upstream code, so it cannot
 * conflict on rebase.
 *
 * @module lateshift/rateLimitSnapshot
 */

/** Provider bucket a snapshot belongs to. */
export type RateLimitProvider = "claude" | "codex" | "other";

/**
 * One rate-limit window as reported by a provider at one instant.
 *
 * `windowKey` is stable per provider and is the primary key together with
 * `provider`: a later observation of the same (provider, windowKey) replaces
 * the earlier one.
 */
export interface RateLimitWindowSnapshot {
  readonly provider: RateLimitProvider;
  /** Provider's own window label. Never renamed. */
  readonly windowKey: string;
  /** Window length in minutes when the provider states it; otherwise null. */
  readonly windowDurationMins: number | null;
  /**
   * Percent of the window consumed, 0-100, as the provider reports it.
   * Never rescaled or inferred. Null when absent.
   */
  readonly utilizationPercent: number | null;
  /** Provider status string (`allowed`, `allowed_warning`, `rejected`, ...). */
  readonly status: string | null;
  /** The provider's raw `resetsAt` integer, untouched. */
  readonly resetsAtRaw: number | null;
  /**
   * Best-effort ISO rendering of `resetsAtRaw`. Heuristic: values above 1e12
   * are treated as epoch milliseconds, otherwise epoch seconds. Null when the
   * value is absent or does not convert to a valid date. Display code should
   * prefer this but must be able to fall back to `resetsAtRaw`.
   */
  readonly resetsAtIso: string | null;
  /** When we observed the event. Set by the caller, not the provider. */
  readonly observedAt: string;
}

/** Bucket a raw provider/driver name into a subscription bucket. */
export function rateLimitProviderOf(providerName: string): RateLimitProvider {
  const s = providerName.toLowerCase();
  if (s.includes("claude") || s.includes("anthropic")) return "claude";
  if (s.includes("codex") || s.includes("openai") || s.includes("gpt")) return "codex";
  return "other";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Convert a provider `resetsAt` integer to ISO. Epoch seconds vs milliseconds
 * is not stated by either provider's schema, so we use a magnitude heuristic:
 * anything above 1e12 must be milliseconds (1e12 seconds is the year 33658).
 */
export function resetsAtToIso(raw: number | null): string | null {
  if (raw === null || !Number.isFinite(raw) || raw <= 0) return null;
  const ms = raw > 1e12 ? raw : raw * 1000;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function makeWindow(
  provider: RateLimitProvider,
  windowKey: string,
  fields: {
    readonly windowDurationMins?: number | null;
    readonly utilizationPercent?: number | null;
    readonly status?: string | null;
    readonly resetsAtRaw?: number | null;
  },
  observedAt: string,
): RateLimitWindowSnapshot {
  const resetsAtRaw = fields.resetsAtRaw ?? null;
  return {
    provider,
    windowKey,
    windowDurationMins: fields.windowDurationMins ?? null,
    utilizationPercent: fields.utilizationPercent ?? null,
    status: fields.status ?? null,
    resetsAtRaw,
    resetsAtIso: resetsAtToIso(resetsAtRaw),
    observedAt,
  };
}

/**
 * Claude: the adapter forwards the whole `SDKRateLimitEvent`, so the useful
 * fields live at `rateLimits.rate_limit_info`. Defensive: alternate shapes that
 * put them directly on `rateLimits` are also accepted.
 *
 * `SDKRateLimitInfo` = {status, resetsAt?, rateLimitType?, utilization?,
 * overageStatus?, overageResetsAt?, ...}. `rateLimitType` is the window label
 * (`five_hour` | `seven_day` | `seven_day_opus` | `seven_day_sonnet` |
 * `overage`). It is optional, so an event without it yields window `unknown`
 * rather than being dropped - the status alone is still real information.
 */
function normalizeClaude(
  payload: Record<string, unknown>,
  observedAt: string,
): ReadonlyArray<RateLimitWindowSnapshot> {
  const info = asRecord(payload["rate_limit_info"]) ?? payload;
  const windowKey = asNonEmptyString(info["rateLimitType"]) ?? "unknown";
  const status = asNonEmptyString(info["status"]);
  const utilization = asFiniteNumber(info["utilization"]);
  const resetsAt = asFiniteNumber(info["resetsAt"]);
  if (status === null && utilization === null && resetsAt === null) return [];

  const windows: Array<RateLimitWindowSnapshot> = [
    makeWindow(
      "claude",
      windowKey,
      { utilizationPercent: utilization, status, resetsAtRaw: resetsAt },
      observedAt,
    ),
  ];

  // Overage is a genuinely separate pool with its own status/reset, reported
  // inline on the same event. Emit it as its own window when present.
  const overageStatus = asNonEmptyString(info["overageStatus"]);
  const overageResetsAt = asFiniteNumber(info["overageResetsAt"]);
  if (windowKey !== "overage" && (overageStatus !== null || overageResetsAt !== null)) {
    windows.push(
      makeWindow(
        "claude",
        "overage",
        { status: overageStatus, resetsAtRaw: overageResetsAt },
        observedAt,
      ),
    );
  }
  return windows;
}

/**
 * Codex: `rateLimits` is a `RateLimitSnapshot` = {primary?, secondary?,
 * planType?, rateLimitReachedType?, ...} where each window is
 * {usedPercent, resetsAt?, windowDurationMins?}.
 *
 * The notification is explicitly documented upstream as *sparse* ("clients
 * should merge available values into the most recent snapshot"), so a missing
 * window means "no news", not "zero". We therefore emit only the windows that
 * are actually present and let the store merge by key.
 */
function normalizeCodex(
  payload: Record<string, unknown>,
  observedAt: string,
): ReadonlyArray<RateLimitWindowSnapshot> {
  const snapshot = asRecord(payload["rateLimits"]) ?? payload;
  const reachedType = asNonEmptyString(snapshot["rateLimitReachedType"]);
  const windows: Array<RateLimitWindowSnapshot> = [];
  for (const key of ["primary", "secondary"] as const) {
    const window = asRecord(snapshot[key]);
    if (window === null) continue;
    const usedPercent = asFiniteNumber(window["usedPercent"]);
    const resetsAt = asFiniteNumber(window["resetsAt"]);
    const durationMins = asFiniteNumber(window["windowDurationMins"]);
    if (usedPercent === null && resetsAt === null) continue;
    windows.push(
      makeWindow(
        "codex",
        key,
        {
          utilizationPercent: usedPercent,
          resetsAtRaw: resetsAt,
          windowDurationMins: durationMins,
          // Codex has no per-window status; `rateLimitReachedType` is
          // account-level and only present once a limit is actually hit.
          status: reachedType,
        },
        observedAt,
      ),
    );
  }
  return windows;
}

/**
 * Normalize one `account.rate-limits.updated` payload into zero or more window
 * snapshots. Returns `[]` for anything unrecognised - a malformed or
 * unexpected payload must degrade to "we know nothing", never to a guess.
 *
 * @param providerName - the runtime event's `provider` field.
 * @param payload - the event payload, i.e. `{ rateLimits: unknown }`.
 * @param observedAt - ISO instant the event was ingested.
 */
export function normalizeRateLimitsEvent(
  providerName: string,
  payload: unknown,
  observedAt: string,
): ReadonlyArray<RateLimitWindowSnapshot> {
  const record = asRecord(payload);
  if (record === null) return [];
  const inner = asRecord(record["rateLimits"]) ?? record;
  const provider = rateLimitProviderOf(providerName);
  switch (provider) {
    case "claude":
      return normalizeClaude(inner, observedAt);
    case "codex":
      return normalizeCodex(inner, observedAt);
    default:
      return [];
  }
}
