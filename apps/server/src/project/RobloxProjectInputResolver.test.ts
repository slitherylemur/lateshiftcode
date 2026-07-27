import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import * as RobloxProjectInputResolver from "./RobloxProjectInputResolver.ts";

const { parseRobloxLink } = RobloxProjectInputResolver;

function httpLayer(routes: (url: string) => Response) {
  const execute = (request: HttpClientRequest.HttpClientRequest) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, routes(request.url)));
  return RobloxProjectInputResolver.layer.pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, HttpClient.make(execute))),
  );
}

describe("parseRobloxLink", () => {
  it("parses a roblox.com/games place url", () => {
    expect(parseRobloxLink("https://www.roblox.com/games/100961538595186/Sky-Journey")).toEqual({
      universeId: null,
      placeId: 100961538595186,
    });
  });

  it("parses a create.roblox.com experience dashboard url", () => {
    expect(
      parseRobloxLink(
        "https://create.roblox.com/dashboard/creations/experiences/10558704030/overview",
      ),
    ).toEqual({ universeId: 10558704030, placeId: null });
  });

  it("parses a dashboard url that contains both a universe and a place", () => {
    expect(
      parseRobloxLink(
        "https://create.roblox.com/dashboard/creations/experiences/10558704030/places/100961538595186/configure",
      ),
    ).toEqual({ universeId: 10558704030, placeId: 100961538595186 });
  });

  it("treats a bare number as a place id", () => {
    expect(parseRobloxLink("  138759672758413 ")).toEqual({
      universeId: null,
      placeId: 138759672758413,
    });
  });

  it("returns null for junk", () => {
    expect(parseRobloxLink("not a link")).toBeNull();
    expect(parseRobloxLink("")).toBeNull();
  });
});

describe("RobloxProjectInputResolver.resolveExperience", () => {
  it.effect("resolves a place link to its universe", () =>
    Effect.gen(function* () {
      const resolver = yield* RobloxProjectInputResolver.RobloxProjectInputResolver;
      const resolved = yield* resolver.resolveExperience({
        link: "https://www.roblox.com/games/100961538595186/Sky",
        role: "workplace",
      });
      expect(resolved).toEqual({ universeId: 10558704030, placeId: 100961538595186 });
    }).pipe(
      Effect.provide(
        httpLayer((url) => {
          expect(url).toContain("/places/100961538595186/universe");
          return Response.json({ universeId: 10558704030 });
        }),
      ),
    ),
  );

  it.effect("resolves a universe-only link to its root place via the games api", () =>
    Effect.gen(function* () {
      const resolver = yield* RobloxProjectInputResolver.RobloxProjectInputResolver;
      const resolved = yield* resolver.resolveExperience({
        link: "https://create.roblox.com/dashboard/creations/experiences/10558727443/overview",
        role: "production",
      });
      expect(resolved).toEqual({ universeId: 10558727443, placeId: 138759672758413 });
    }).pipe(
      Effect.provide(
        httpLayer((url) => {
          expect(url).toContain("games?universeIds=10558727443");
          return Response.json({ data: [{ rootPlaceId: 138759672758413 }] });
        }),
      ),
    ),
  );

  it.effect("fails with a typed error when a private universe has no public root place", () =>
    Effect.gen(function* () {
      const resolver = yield* RobloxProjectInputResolver.RobloxProjectInputResolver;
      const result = yield* resolver
        .resolveExperience({
          link: "https://create.roblox.com/dashboard/creations/experiences/10558727443/overview",
          role: "production",
        })
        .pipe(Effect.flip);
      expect(result._tag).toBe("RobloxIdResolutionError");
      if (result._tag === "RobloxIdResolutionError") {
        expect(result.reason).toBe("not-found");
      }
    }).pipe(Effect.provide(httpLayer(() => Response.json({ data: [{ rootPlaceId: 0 }] })))),
  );

  it.effect("fails with a parse error when nothing usable is in the link", () =>
    Effect.gen(function* () {
      const resolver = yield* RobloxProjectInputResolver.RobloxProjectInputResolver;
      const result = yield* resolver
        .resolveExperience({ link: "nonsense", role: "workplace" })
        .pipe(Effect.flip);
      expect(result._tag).toBe("RobloxLinkParseError");
    }).pipe(Effect.provide(httpLayer(() => Response.json({})))),
  );
});
