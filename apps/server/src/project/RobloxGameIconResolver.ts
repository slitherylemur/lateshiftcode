/**
 * RobloxGameIconResolver - resolves a Roblox project's published game icon.
 *
 * For a workspace whose root contains `roblox.json` with a usable place id
 * (prod first, then test), this fetches the game's icon URL from the Roblox
 * public thumbnails API, downloads the PNG, and caches it on disk so the
 * sidebar does not hammer Roblox. The cached file is refreshed at most once
 * per day; when a refresh fails a previously cached icon is still served.
 *
 * Resolution is best-effort: any project without `roblox.json` / a usable place
 * id resolves to `null`, letting callers fall back to the folder icon.
 *
 * @module RobloxGameIconResolver
 */
import { robloxGameIconPlaceId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import * as RobloxProjectFileLoader from "./RobloxProjectFileLoader.ts";

/** Roblox public thumbnails endpoint for place (game) icons. */
const THUMBNAILS_ENDPOINT = "https://thumbnails.roblox.com/v1/places/gameicons";
/** Requested icon size; small, square, retina-friendly for a sidebar row. */
const THUMBNAIL_SIZE = "150x150";
/** Refresh a cached icon at most once per day. */
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Sub-directory (under the provider status cache dir) holding cached icons. */
export const ROBLOX_GAME_ICONS_CACHE_DIRNAME = "roblox-game-icons";

/** On-disk cache file name for the icon of a given place id. */
export function robloxGameIconCacheFileName(placeId: number): string {
  return `${placeId}.png`;
}

const ThumbnailsResponse = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      targetId: Schema.Number,
      state: Schema.String,
      imageUrl: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
});

export class RobloxGameIconResolutionError extends Schema.TaggedErrorClass<RobloxGameIconResolutionError>()(
  "RobloxGameIconResolutionError",
  {
    operation: Schema.Literals([
      "inspect-cache",
      "fetch-thumbnail",
      "download-image",
      "write-cache",
    ]),
    workspaceRoot: Schema.String,
    placeId: Schema.optional(Schema.Number),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to resolve Roblox game icon during ${this.operation} for workspace ${this.workspaceRoot}.`;
  }
}

export interface ResolvedRobloxGameIcon {
  readonly placeId: number;
  readonly filePath: string;
}

/** Service tag for Roblox game icon resolution. */
export class RobloxGameIconResolver extends Context.Service<
  RobloxGameIconResolver,
  {
    /**
     * Resolve the cached game-icon file for the provided workspace root.
     *
     * Returns `null` when the workspace is not a Roblox project, has no usable
     * place id, or the icon could not be fetched and nothing was cached.
     */
    readonly resolveIcon: (
      workspaceRoot: string,
    ) => Effect.Effect<ResolvedRobloxGameIcon | null, RobloxGameIconResolutionError>;
  }
>()("t3/project/RobloxGameIconResolver") {}

const statOption = (fileSystem: FileSystem.FileSystem, filePath: string) =>
  fileSystem.stat(filePath).pipe(
    Effect.map(Option.some),
    Effect.catchTags({
      PlatformError: (error: PlatformError.PlatformError) =>
        error.reason._tag === "NotFound"
          ? Effect.succeed(Option.none<FileSystem.File.Info>())
          : Effect.fail(error),
    }),
  );

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const httpClient = yield* HttpClient.HttpClient;
  const loader = yield* RobloxProjectFileLoader.RobloxProjectFileLoader;
  const config = yield* ServerConfig.ServerConfig;

  const cacheDir = path.join(config.providerStatusCacheDir, ROBLOX_GAME_ICONS_CACHE_DIRNAME);

  const fetchAndCache = (workspaceRoot: string, placeId: number, filePath: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const apiUrl = `${THUMBNAILS_ENDPOINT}?placeIds=${placeId}&size=${THUMBNAIL_SIZE}&format=Png`;
        const apiResponse = yield* httpClient.execute(HttpClientRequest.get(apiUrl)).pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.mapError(
            (cause) =>
              new RobloxGameIconResolutionError({
                operation: "fetch-thumbnail",
                workspaceRoot,
                placeId,
                cause,
              }),
          ),
        );
        const parsed = yield* HttpClientResponse.schemaBodyJson(ThumbnailsResponse)(
          apiResponse,
        ).pipe(
          Effect.mapError(
            (cause) =>
              new RobloxGameIconResolutionError({
                operation: "fetch-thumbnail",
                workspaceRoot,
                placeId,
                cause,
              }),
          ),
        );
        const entry = parsed.data.find(
          (candidate) =>
            candidate.targetId === placeId &&
            candidate.state === "Completed" &&
            typeof candidate.imageUrl === "string" &&
            candidate.imageUrl.length > 0,
        );
        if (!entry || !entry.imageUrl) {
          return yield* new RobloxGameIconResolutionError({
            operation: "fetch-thumbnail",
            workspaceRoot,
            placeId,
            cause: `Thumbnail not available for place ${placeId}.`,
          });
        }

        const imageResponse = yield* httpClient.execute(HttpClientRequest.get(entry.imageUrl)).pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.mapError(
            (cause) =>
              new RobloxGameIconResolutionError({
                operation: "download-image",
                workspaceRoot,
                placeId,
                cause,
              }),
          ),
        );
        const bytes = new Uint8Array(
          yield* imageResponse.arrayBuffer.pipe(
            Effect.mapError(
              (cause) =>
                new RobloxGameIconResolutionError({
                  operation: "download-image",
                  workspaceRoot,
                  placeId,
                  cause,
                }),
            ),
          ),
        );

        yield* Effect.gen(function* () {
          yield* fileSystem.makeDirectory(cacheDir, { recursive: true });
          const tempDirectory = yield* fileSystem.makeTempDirectoryScoped({
            directory: cacheDir,
            prefix: `${robloxGameIconCacheFileName(placeId)}.`,
          });
          const tempPath = path.join(tempDirectory, "icon.tmp");
          yield* fileSystem.writeFile(tempPath, bytes);
          yield* fileSystem.rename(tempPath, filePath);
        }).pipe(
          Effect.mapError(
            (cause) =>
              new RobloxGameIconResolutionError({
                operation: "write-cache",
                workspaceRoot,
                placeId,
                cause,
              }),
          ),
        );
      }),
    );

  const resolveIcon: RobloxGameIconResolver["Service"]["resolveIcon"] = Effect.fn(
    "RobloxGameIconResolver.resolveIcon",
  )(function* (workspaceRoot) {
    const file = yield* loader.load(workspaceRoot);
    if (Option.isNone(file)) {
      return null;
    }
    const placeId = robloxGameIconPlaceId(file.value);
    if (placeId === null) {
      return null;
    }

    const filePath = path.join(cacheDir, robloxGameIconCacheFileName(placeId));
    const cached = yield* statOption(fileSystem, filePath).pipe(
      Effect.mapError(
        (cause) =>
          new RobloxGameIconResolutionError({
            operation: "inspect-cache",
            workspaceRoot,
            placeId,
            cause,
          }),
      ),
    );
    const now = yield* Clock.currentTimeMillis;
    const cachedFileExists = Option.isSome(cached) && cached.value.type === "File";
    const isFresh =
      cachedFileExists &&
      Option.match((cached as Option.Some<FileSystem.File.Info>).value.mtime, {
        onNone: () => false,
        onSome: (mtime) => now - mtime.getTime() < REFRESH_INTERVAL_MS,
      });
    if (isFresh) {
      return { placeId, filePath };
    }

    const refreshed = yield* fetchAndCache(workspaceRoot, placeId, filePath).pipe(
      Effect.as(true),
      Effect.catch((error) =>
        Effect.logWarning("Failed to refresh Roblox game icon; serving cached icon if present.", {
          workspaceRoot,
          placeId,
          cause: error,
        }).pipe(Effect.as(false)),
      ),
    );
    if (refreshed || cachedFileExists) {
      return { placeId, filePath };
    }
    return null;
  });

  return RobloxGameIconResolver.of({ resolveIcon });
});

// Note: `HttpClient` is an external dependency so callers (and tests) control
// the transport. Server wiring provides `FetchHttpClient.layer`.
export const layer = Layer.effect(RobloxGameIconResolver, make);
