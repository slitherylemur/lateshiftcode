// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - This
// store deliberately writes a plain JSON file with node:fs/promises rather
// than through FileSystem/Schema. It is read by the PORTAL, an ordinary Node
// process outside any Effect runtime, so the on-disk shape must stay a hand-
// readable JSON document with no Effect encoding; and the write must survive
// a read-only mount (missing telemetry must never take a workspace down),
// which is handled by the local try/catch here.
/**
 * LateShift: durable store for the latest provider rate-limit window snapshot.
 *
 * ## Why a file and not a table
 *
 * Rate-limit state is a property of the *subscription*, not of a user: there is
 * one Claude Max account and one Codex account behind every workspace, so every
 * instance observes the same numbers. Storing it per-instance in `state.sqlite`
 * would mean N copies of one fact, and the portal would have to guess which
 * instance's copy is freshest. It would also mean a new migration in
 * `Migrations.ts`, an upstream hot file that `update-from-upstream.sh` aborts on.
 *
 * So: one JSON file per provider, in a directory shared by every instance,
 * last-writer-wins. The instance that most recently talked to the provider has
 * the freshest truth and overwrites. Reads are a single `readFile` for the
 * portal - no SQLite handle against a live instance DB.
 *
 * ## Enabling
 *
 * The store is a no-op unless `T3CODE_RATE_LIMIT_SNAPSHOT_DIR` is set. Desktop
 * and upstream-dev runs therefore see zero behaviour change; only LateShift
 * instances (which get the env var from `t3code@.service`) write anything.
 *
 * ## Failure policy
 *
 * Writes are best-effort and fail-open, exactly like the `turn_usage` ledger:
 * a full disk or a permissions mistake must never break turn ingestion. Errors
 * are logged at warning level and swallowed.
 *
 * ## Concurrency
 *
 * Multiple instances write the same path. Each write is `writeFile(tmp)` +
 * `rename(tmp, final)`, which is atomic within a filesystem, so a reader never
 * observes a torn file. Interleaved writers can still lose an update
 * (last-writer-wins); that is acceptable because every writer is reporting the
 * same subscription-wide fact and the loser's value differs only by staleness.
 *
 * @module lateshift/RateLimitSnapshotStore
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { RateLimitProvider, RateLimitWindowSnapshot } from "./rateLimitSnapshot.ts";

/** Env var naming the directory the snapshot files live in. */
export const RATE_LIMIT_SNAPSHOT_DIR_ENV = "T3CODE_RATE_LIMIT_SNAPSHOT_DIR";

/**
 * On-disk shape, one file per provider: `<dir>/<provider>.json`.
 *
 * `windows` is keyed by the provider's own window label. Windows accumulate:
 * a sparse update (Codex explicitly sends these) merges into whatever was
 * already known rather than clearing it.
 *
 * This file is read by the LateShift portal. Treat the shape as a contract;
 * add fields, never rename or repurpose them.
 */
export interface RateLimitSnapshotFile {
  readonly version: 1;
  readonly provider: RateLimitProvider;
  /** Most recent `observedAt` across all windows in this file. */
  readonly updatedAt: string;
  readonly windows: Record<string, RateLimitWindowSnapshot>;
}

export interface RateLimitSnapshotStoreShape {
  /**
   * Merge observed windows into the provider's file and persist.
   * Never fails: errors are logged and swallowed.
   */
  readonly record: (windows: ReadonlyArray<RateLimitWindowSnapshot>) => Effect.Effect<void>;
}

export class RateLimitSnapshotStore extends Context.Service<
  RateLimitSnapshotStore,
  RateLimitSnapshotStoreShape
>()("t3/lateshift/RateLimitSnapshotStore") {}

/** File name for a provider. Constrained to the closed provider union. */
export function snapshotFileName(provider: RateLimitProvider): string {
  return `${provider}.json`;
}

const noopStore: RateLimitSnapshotStoreShape = {
  record: () => Effect.void,
};

const makeFsStore = (dir: string): RateLimitSnapshotStoreShape => {
  // In-memory mirror of what this process has written, so a sparse update
  // merges with earlier windows without a read-modify-write race against
  // ourselves. We deliberately do NOT read other processes' files back in:
  // every instance sees the same subscription, so the union converges anyway,
  // and re-reading would let one stale instance resurrect old windows.
  const byProvider = new Map<RateLimitProvider, Record<string, RateLimitWindowSnapshot>>();

  const writeProvider = (provider: RateLimitProvider) =>
    Effect.tryPromise(async () => {
      const windows = byProvider.get(provider) ?? {};
      const updatedAt = Object.values(windows).reduce<string>(
        (latest, w) => (w.observedAt > latest ? w.observedAt : latest),
        "",
      );
      const file: RateLimitSnapshotFile = {
        version: 1,
        provider,
        updatedAt,
        windows,
      };
      const target = NodePath.join(dir, snapshotFileName(provider));
      const tmp = `${target}.${process.pid}.tmp`;
      await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
      await NodeFSP.writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o644 });
      await NodeFSP.rename(tmp, target);
    });

  return {
    record: (windows) =>
      Effect.gen(function* () {
        if (windows.length === 0) return;
        const touched = new Set<RateLimitProvider>();
        for (const window of windows) {
          // "other" is not a subscription we track; drop rather than invent.
          if (window.provider === "other") continue;
          const existing = byProvider.get(window.provider) ?? {};
          existing[window.windowKey] = window;
          byProvider.set(window.provider, existing);
          touched.add(window.provider);
        }
        for (const provider of touched) {
          yield* writeProvider(provider).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("lateshift rate-limit snapshot write failed", {
                provider,
                dir,
                cause,
              }),
            ),
          );
        }
      }),
  };
};

/**
 * Live layer. Reads `T3CODE_RATE_LIMIT_SNAPSHOT_DIR` once at construction; when
 * it is unset or blank the service is an explicit no-op.
 */
export const RateLimitSnapshotStoreLive = Layer.sync(RateLimitSnapshotStore, () => {
  const dir = process.env[RATE_LIMIT_SNAPSHOT_DIR_ENV]?.trim();
  return dir ? makeFsStore(dir) : noopStore;
});

/** Test/no-op layer: accepts everything, persists nothing. */
export const RateLimitSnapshotStoreNoop = Layer.succeed(RateLimitSnapshotStore, noopStore);
