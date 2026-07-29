// rateLimits.mjs — read-only reader for the provider rate-limit snapshots that
// the T3 server writes (apps/server/src/lateshift/RateLimitSnapshotStore.ts).
//
// This is POOL REMAINING: provider truth about the shared subscription. It is
// deliberately kept separate from SHARE OF CONSUMPTION (history.mjs, our own
// turn_usage attribution). The two must never be blended: one is what the
// provider says is left, the other is who used it according to us.
//
// Rules enforced here (architecture-v2 section 4):
//   * Never extrapolate. A window we have not heard about recently is
//     "unknown", not "probably still N%".
//   * Never rename a provider's window label. Both providers' reset behaviour
//     is inconsistent with their own labels, so "seven_day" is displayed as
//     "seven_day", not "weekly".
//   * resetsAt is passed through verbatim alongside the best-effort ISO.

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Directory the instances write snapshot files into. Mirrors the unit file. */
export const DEFAULT_SNAPSHOT_DIR = "/home/dev/services/lateshift/state/rate-limits";

/**
 * A snapshot older than this is reported as stale. Both providers emit on
 * every turn that touches the account, so an hour of silence means either
 * nobody is working or we lost the feed — in both cases "unknown" is the
 * honest answer and the UI must say so rather than show an old number.
 */
export const STALE_AFTER_MS = 60 * 60 * 1000;

const PROVIDERS = ["claude", "codex"];

function readJson(path) {
  try {
    const text = readFileSync(path, "utf8");
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function ageMs(iso, now) {
  const t = Date.parse(String(iso ?? ""));
  return Number.isNaN(t) ? null : now - t;
}

function normalizeWindow(raw, now) {
  if (!raw || typeof raw !== "object") return null;
  const pct = Number(raw.utilizationPercent);
  const age = ageMs(raw.observedAt, now);
  return {
    windowKey: String(raw.windowKey ?? "unknown"),
    // Utilization is what the provider reported; remaining is the simple
    // complement, not an estimate of anything else.
    utilizationPercent: Number.isFinite(pct) ? pct : null,
    remainingPercent: Number.isFinite(pct) ? Math.max(0, 100 - pct) : null,
    status: typeof raw.status === "string" && raw.status ? raw.status : null,
    windowDurationMins: Number.isFinite(Number(raw.windowDurationMins))
      ? Number(raw.windowDurationMins)
      : null,
    resetsAtRaw: Number.isFinite(Number(raw.resetsAtRaw)) ? Number(raw.resetsAtRaw) : null,
    resetsAtIso: typeof raw.resetsAtIso === "string" ? raw.resetsAtIso : null,
    observedAt: typeof raw.observedAt === "string" ? raw.observedAt : null,
    ageMs: age,
    stale: age === null || age > STALE_AFTER_MS,
  };
}

/**
 * Read one provider's snapshot file.
 *
 * Always returns an object; `known:false` means we have no usable data and the
 * caller must render "unknown". Windows are sorted by window key for a stable
 * display order (the provider sends no ordering).
 */
export function readProviderPool(dir, provider, now = Date.now()) {
  const file = readJson(join(dir, `${provider}.json`));
  const windowsRaw = file && file.windows && typeof file.windows === "object" ? file.windows : null;
  if (!windowsRaw) return { provider, known: false, updatedAt: null, windows: [] };

  const windows = Object.values(windowsRaw)
    .map((w) => normalizeWindow(w, now))
    .filter((w) => w !== null && (w.utilizationPercent !== null || w.status !== null))
    .sort((a, b) => a.windowKey.localeCompare(b.windowKey));

  return {
    provider,
    known: windows.length > 0,
    updatedAt: typeof file.updatedAt === "string" ? file.updatedAt : null,
    // Fresh only if at least one window is fresh; a wholly stale file is
    // reported so the UI can degrade to "unknown".
    fresh: windows.some((w) => !w.stale),
    windows,
  };
}

/** Read every tracked provider. Shape is stable whether or not files exist. */
export function readPoolStatus(dir = DEFAULT_SNAPSHOT_DIR, now = Date.now()) {
  const out = {};
  for (const provider of PROVIDERS) out[provider] = readProviderPool(dir, provider, now);
  return out;
}

/**
 * The single window a compact header widget should show for a provider: the
 * fresh window closest to exhaustion. Returns null when nothing is known —
 * callers must render "unknown", never a placeholder number.
 */
export function headlineWindow(pool) {
  if (!pool || !pool.known) return null;
  const usable = pool.windows.filter((w) => !w.stale && w.utilizationPercent !== null);
  if (usable.length === 0) return null;
  return usable.reduce((worst, w) => (w.utilizationPercent > worst.utilizationPercent ? w : worst));
}
