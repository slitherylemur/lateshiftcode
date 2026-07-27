import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import * as RobloxGameIconResolver from "./RobloxGameIconResolver.ts";
import * as RobloxProjectFileLoader from "./RobloxProjectFileLoader.ts";

const ICON_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
const IMAGE_URL = "https://tr.rbxcdn.com/test-game-icon/150/150/GameIcon/Png/noFilter";

interface StubState {
  thumbnailCalls: number;
  imageCalls: number;
  thumbnailStatus: number;
}

function makeHttpClientLayer(state: StubState, placeId: number) {
  const execute = (request: HttpClientRequest.HttpClientRequest) => {
    if (request.url.includes("thumbnails.roblox.com")) {
      state.thumbnailCalls += 1;
      if (state.thumbnailStatus !== 200) {
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response("nope", { status: state.thumbnailStatus }),
          ),
        );
      }
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({
            data: [{ targetId: placeId, state: "Completed", imageUrl: IMAGE_URL }],
          }),
        ),
      );
    }
    state.imageCalls += 1;
    return Effect.succeed(
      HttpClientResponse.fromWeb(request, new Response(ICON_BYTES, { status: 200 })),
    );
  };
  return Layer.succeed(HttpClient.HttpClient, HttpClient.make(execute));
}

function makeTestLayer(state: StubState, placeId: number) {
  const configLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-roblox-icon-test-",
  });
  return Layer.mergeAll(
    RobloxGameIconResolver.layer.pipe(
      Layer.provide(RobloxProjectFileLoader.layer),
      Layer.provide(makeHttpClientLayer(state, placeId)),
      Layer.provide(configLayer),
    ),
  ).pipe(Layer.provideMerge(NodeServices.layer));
}

interface RobloxJsonFields {
  readonly devUniverseId: number;
  readonly testPlaceId: number;
  readonly workplacePlaceId: number;
  readonly prodUniverseId: number;
  readonly prodPlaceId: number;
}

// Serialize without JSON.stringify to satisfy the repo's prefer-Schema lint;
// the shape is fixed and all values are numbers.
const serializeRobloxJson = (fields: RobloxJsonFields): string =>
  [
    "{",
    `\t"devUniverseId": ${fields.devUniverseId},`,
    `\t"testPlaceId": ${fields.testPlaceId},`,
    `\t"workplacePlaceId": ${fields.workplacePlaceId},`,
    `\t"prodUniverseId": ${fields.prodUniverseId},`,
    `\t"prodPlaceId": ${fields.prodPlaceId}`,
    "}",
    "",
  ].join("\n");

const writeRobloxJson = (root: string, fields: RobloxJsonFields) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fileSystem.writeFileString(path.join(root, "roblox.json"), serializeRobloxJson(fields));
  });

describe("RobloxGameIconResolver", () => {
  it.effect("downloads and caches the prod place game icon", () => {
    const state: StubState = { thumbnailCalls: 0, imageCalls: 0, thumbnailStatus: 200 };
    const placeId = 138759672758413;
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-roblox-ws-" });
      yield* writeRobloxJson(root, {
        devUniverseId: 1,
        testPlaceId: 100961538595186,
        workplacePlaceId: 100961538595186,
        prodUniverseId: 2,
        prodPlaceId: placeId,
      });

      const resolver = yield* RobloxGameIconResolver.RobloxGameIconResolver;
      const resolved = yield* resolver.resolveIcon(root);
      expect(resolved).not.toBeNull();
      expect(resolved?.placeId).toBe(placeId);

      const cachedBytes = yield* fileSystem.readFile(resolved!.filePath);
      expect(Array.from(cachedBytes)).toEqual(Array.from(ICON_BYTES));
      expect(state.thumbnailCalls).toBe(1);
      expect(state.imageCalls).toBe(1);

      // A second resolve within the refresh window serves the cached file
      // without hitting Roblox again.
      const again = yield* resolver.resolveIcon(root);
      expect(again?.filePath).toBe(resolved?.filePath);
      expect(state.thumbnailCalls).toBe(1);
      expect(state.imageCalls).toBe(1);
    }).pipe(Effect.provide(makeTestLayer(state, placeId)));
  });

  it.effect("falls back to the test place id when prod is unset", () => {
    const state: StubState = { thumbnailCalls: 0, imageCalls: 0, thumbnailStatus: 200 };
    const placeId = 100961538595186;
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-roblox-ws-" });
      yield* writeRobloxJson(root, {
        devUniverseId: 1,
        testPlaceId: placeId,
        workplacePlaceId: placeId,
        prodUniverseId: 0,
        prodPlaceId: 0,
      });

      const resolver = yield* RobloxGameIconResolver.RobloxGameIconResolver;
      const resolved = yield* resolver.resolveIcon(root);
      expect(resolved?.placeId).toBe(placeId);
    }).pipe(Effect.provide(makeTestLayer(state, placeId)));
  });

  it.effect("returns null when there is no roblox.json", () => {
    const state: StubState = { thumbnailCalls: 0, imageCalls: 0, thumbnailStatus: 200 };
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-roblox-ws-" });
      const resolver = yield* RobloxGameIconResolver.RobloxGameIconResolver;
      const resolved = yield* resolver.resolveIcon(root);
      expect(resolved).toBeNull();
      expect(state.thumbnailCalls).toBe(0);
    }).pipe(Effect.provide(makeTestLayer(state, 1)));
  });

  it.effect("returns null when all place ids are unset", () => {
    const state: StubState = { thumbnailCalls: 0, imageCalls: 0, thumbnailStatus: 200 };
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-roblox-ws-" });
      yield* writeRobloxJson(root, {
        devUniverseId: 1,
        testPlaceId: 0,
        workplacePlaceId: 0,
        prodUniverseId: 0,
        prodPlaceId: 0,
      });
      const resolver = yield* RobloxGameIconResolver.RobloxGameIconResolver;
      const resolved = yield* resolver.resolveIcon(root);
      expect(resolved).toBeNull();
      expect(state.thumbnailCalls).toBe(0);
    }).pipe(Effect.provide(makeTestLayer(state, 1)));
  });

  it.effect("returns null when the thumbnail fetch fails and nothing is cached", () => {
    const state: StubState = { thumbnailCalls: 0, imageCalls: 0, thumbnailStatus: 503 };
    const placeId = 138759672758413;
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-roblox-ws-" });
      yield* writeRobloxJson(root, {
        devUniverseId: 1,
        testPlaceId: 0,
        workplacePlaceId: 0,
        prodUniverseId: 2,
        prodPlaceId: placeId,
      });
      const resolver = yield* RobloxGameIconResolver.RobloxGameIconResolver;
      const resolved = yield* resolver.resolveIcon(root);
      expect(resolved).toBeNull();
    }).pipe(Effect.provide(makeTestLayer(state, placeId)));
  });

  it.effect("serves a previously cached icon when a later refresh fails", () => {
    const state: StubState = { thumbnailCalls: 0, imageCalls: 0, thumbnailStatus: 200 };
    const placeId = 138759672758413;
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-roblox-ws-" });
      yield* writeRobloxJson(root, {
        devUniverseId: 1,
        testPlaceId: 0,
        workplacePlaceId: 0,
        prodUniverseId: 2,
        prodPlaceId: placeId,
      });
      const resolver = yield* RobloxGameIconResolver.RobloxGameIconResolver;
      const first = yield* resolver.resolveIcon(root);
      expect(first).not.toBeNull();

      // Force the cached file to look stale so the next resolve attempts a
      // refresh, then make that refresh fail: the stale icon is still served.
      // The value is far enough in the past to read as stale regardless of the
      // second/millisecond unit interpretation of utimes.
      const nowMs = yield* Clock.currentTimeMillis;
      const staleTime = nowMs / 1000 - 60 * 60 * 48;
      yield* fileSystem.utimes(first!.filePath, staleTime, staleTime);
      state.thumbnailStatus = 500;

      const second = yield* resolver.resolveIcon(root);
      expect(second?.filePath).toBe(first?.filePath);
    }).pipe(Effect.provide(makeTestLayer(state, placeId)));
  });
});
