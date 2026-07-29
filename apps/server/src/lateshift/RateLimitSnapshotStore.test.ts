// @effect-diagnostics nodeBuiltinImport:off - The test asserts the exact
// bytes this store leaves on disk (the portal parses them), so it reads them
// back with node:fs directly rather than through FileSystem.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  RATE_LIMIT_SNAPSHOT_DIR_ENV,
  RateLimitSnapshotStore,
  RateLimitSnapshotStoreLive,
} from "./RateLimitSnapshotStore.ts";
import { normalizeRateLimitsEvent } from "./rateLimitSnapshot.ts";

/**
 * The live layer reads the directory from the environment at construction, so
 * each case points the env var at its own temp dir and builds the layer inside
 * the test. `Effect.provide` is applied per-effect for that reason.
 */
const withDir = <A, E>(
  dir: string | undefined,
  effect: Effect.Effect<A, E, RateLimitSnapshotStore>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env[RATE_LIMIT_SNAPSHOT_DIR_ENV];
      if (dir === undefined) delete process.env[RATE_LIMIT_SNAPSHOT_DIR_ENV];
      else process.env[RATE_LIMIT_SNAPSHOT_DIR_ENV] = dir;
      return previous;
    }),
    () => Effect.provide(effect, RateLimitSnapshotStoreLive),
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env[RATE_LIMIT_SNAPSHOT_DIR_ENV];
        else process.env[RATE_LIMIT_SNAPSHOT_DIR_ENV] = previous;
      }),
  );

const tempDir = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lsc-rl-"));

const readSnapshot = (dir: string, provider: string) =>
  JSON.parse(NodeFS.readFileSync(NodePath.join(dir, `${provider}.json`), "utf8")) as {
    version: number;
    provider: string;
    updatedAt: string;
    windows: Record<string, { utilizationPercent: number | null; status: string | null }>;
  };

const record = (providerName: string, payload: unknown, observedAt: string) =>
  Effect.gen(function* () {
    const store = yield* RateLimitSnapshotStore;
    yield* store.record(normalizeRateLimitsEvent(providerName, payload, observedAt));
  });

describe("RateLimitSnapshotStore", () => {
  it.effect("writes a real Claude rate_limit_event to disk", () =>
    Effect.gen(function* () {
      const dir = tempDir();
      yield* withDir(
        dir,
        record(
          "claudeAgent",
          {
            rateLimits: {
              type: "rate_limit_event",
              rate_limit_info: {
                status: "allowed_warning",
                rateLimitType: "five_hour",
                utilization: 87,
                resetsAt: 1_800_000_000,
              },
            },
          },
          "2026-07-29T12:00:00.000Z",
        ),
      );
      const file = readSnapshot(dir, "claude");
      expect(file.version).toBe(1);
      expect(file.updatedAt).toBe("2026-07-29T12:00:00.000Z");
      expect(file.windows["five_hour"]?.utilizationPercent).toBe(87);
      expect(file.windows["five_hour"]?.status).toBe("allowed_warning");
    }),
  );

  it.effect("merges sparse Codex updates instead of clearing unseen windows", () =>
    Effect.gen(function* () {
      const dir = tempDir();
      yield* withDir(
        dir,
        Effect.gen(function* () {
          yield* record(
            "codex",
            {
              rateLimits: {
                rateLimits: { primary: { usedPercent: 10 }, secondary: { usedPercent: 20 } },
              },
            },
            "2026-07-29T12:00:00.000Z",
          );
          // Sparse follow-up carrying only `primary`. `secondary` must survive:
          // Codex documents these notifications as merge-into-latest, so a
          // missing window means "no news", not "zero".
          yield* record(
            "codex",
            { rateLimits: { rateLimits: { primary: { usedPercent: 55 } } } },
            "2026-07-29T12:05:00.000Z",
          );
        }),
      );
      const file = readSnapshot(dir, "codex");
      expect(file.windows["primary"]?.utilizationPercent).toBe(55);
      expect(file.windows["secondary"]?.utilizationPercent).toBe(20);
      expect(file.updatedAt).toBe("2026-07-29T12:05:00.000Z");
    }),
  );

  it.effect("is a silent no-op when the directory env var is unset", () =>
    withDir(
      undefined,
      record(
        "codex",
        { rateLimits: { rateLimits: { primary: { usedPercent: 10 } } } },
        "2026-07-29T12:00:00.000Z",
      ),
    ),
  );

  it.effect("fails open when the directory is unwritable", () =>
    // The unit file marks the snapshot directory ReadWritePaths=-... on
    // purpose, so an instance can legitimately run with it read-only. A write
    // failure must degrade to "unknown" in the portal, never break ingestion.
    withDir(
      "/etc/lsc-definitely-not-writable/snapshots",
      record(
        "claudeAgent",
        { rateLimits: { rate_limit_info: { status: "allowed", utilization: 1 } } },
        "2026-07-29T12:00:00.000Z",
      ),
    ),
  );
});
