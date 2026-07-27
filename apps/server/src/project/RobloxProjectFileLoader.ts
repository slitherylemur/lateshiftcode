/**
 * RobloxProjectFileLoader - Effect service that loads the checked-in
 * `roblox.json` descriptor from a workspace root.
 *
 * Loading is best-effort: a missing file resolves to `Option.none`, and
 * unreadable or invalid files are logged and treated as absent so callers can
 * fall back to their defaults (mirrors {@link T3ProjectFileLoader}).
 *
 * @module RobloxProjectFileLoader
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { ROBLOX_PROJECT_FILE_NAME, type RobloxProjectFile } from "@t3tools/contracts";
import { RobloxProjectFileFromJson } from "@t3tools/shared/robloxProjectFile";

const decodeRobloxProjectFileJson = Schema.decodeEffect(RobloxProjectFileFromJson);

export class RobloxProjectFileLoadError extends Schema.TaggedErrorClass<RobloxProjectFileLoadError>()(
  "RobloxProjectFileLoadError",
  {
    operation: Schema.Literals(["read", "decode"]),
    workspaceRoot: Schema.String,
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} ${ROBLOX_PROJECT_FILE_NAME} at ${this.filePath}.`;
  }
}

/** Service tag for roblox.json project file loading. */
export class RobloxProjectFileLoader extends Context.Service<
  RobloxProjectFileLoader,
  {
    /**
     * Load and decode `roblox.json` at the workspace root.
     *
     * Never fails: missing, unreadable, or invalid files resolve to
     * `Option.none` (invalid files are logged as warnings).
     */
    readonly load: (workspaceRoot: string) => Effect.Effect<Option.Option<RobloxProjectFile>>;
  }
>()("t3/project/RobloxProjectFileLoader") {}

const logRobloxProjectFileLoadError = (error: RobloxProjectFileLoadError) =>
  Effect.logWarning(error).pipe(
    Effect.annotateLogs({
      operation: error.operation,
      workspaceRoot: error.workspaceRoot,
      filePath: error.filePath,
      errorTag: error._tag,
    }),
  );

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const load: RobloxProjectFileLoader["Service"]["load"] = Effect.fn(
    "RobloxProjectFileLoader.load",
  )(function* (workspaceRoot) {
    const filePath = path.join(workspaceRoot, ROBLOX_PROJECT_FILE_NAME);
    const raw = yield* fileSystem.readFileString(filePath).pipe(
      Effect.map(Option.some),
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound"
            ? Effect.succeed(Option.none<string>())
            : logRobloxProjectFileLoadError(
                new RobloxProjectFileLoadError({
                  operation: "read",
                  workspaceRoot,
                  filePath,
                  cause: error,
                }),
              ).pipe(Effect.as(Option.none<string>())),
      }),
    );
    if (Option.isNone(raw)) {
      return Option.none<RobloxProjectFile>();
    }
    return yield* decodeRobloxProjectFileJson(raw.value).pipe(
      Effect.map(Option.some),
      Effect.catchTags({
        SchemaError: (error) =>
          logRobloxProjectFileLoadError(
            new RobloxProjectFileLoadError({
              operation: "decode",
              workspaceRoot,
              filePath,
              cause: error,
            }),
          ).pipe(Effect.as(Option.none<RobloxProjectFile>())),
      }),
    );
  });

  return RobloxProjectFileLoader.of({ load });
});

export const layer = Layer.effect(RobloxProjectFileLoader, make);
