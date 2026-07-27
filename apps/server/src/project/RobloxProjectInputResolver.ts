/**
 * RobloxProjectInputResolver - turns the links pasted into the create-project
 * dialog into concrete Roblox universe + place ids.
 *
 * Accepts both create.roblox.com dashboard URLs and roblox.com/games URLs (and
 * bare numeric ids), parses them robustly, and resolves the missing side via
 * the Roblox public APIs:
 *   - place id -> universe id: GET apis.roblox.com/universes/v1/places/{p}/universe
 *   - universe id -> root place id: GET games.roblox.com/v1/games?universeIds={u}
 *
 * A universe/place link always yields a concrete `{ universeId, placeId }`, or
 * a typed error explaining what could not be parsed/resolved.
 *
 * @module RobloxProjectInputResolver
 */
import {
  RobloxIdResolutionError,
  RobloxLinkParseError,
  type RobloxProjectInputError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

const PLACE_UNIVERSE_ENDPOINT = "https://apis.roblox.com/universes/v1/places";
const GAMES_ENDPOINT = "https://games.roblox.com/v1/games";

/** A link may resolve to a universe id, a place id, or both. */
export interface ParsedRobloxLink {
  readonly universeId: number | null;
  readonly placeId: number | null;
}

/** A fully-resolved experience: both ids known. */
export interface ResolvedRobloxExperience {
  readonly universeId: number;
  readonly placeId: number;
}

/** Which of the two dialog inputs a link came from (for error messages). */
export type RobloxLinkRole = "workplace" | "production";

const PlaceUniverseResponse = Schema.Struct({ universeId: Schema.Number });
const GamesResponse = Schema.Struct({
  data: Schema.Array(Schema.Struct({ rootPlaceId: Schema.Number })),
});

const firstPositiveInt = (values: ReadonlyArray<string | undefined>): number | null => {
  for (const value of values) {
    if (value === undefined) continue;
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return null;
};

/**
 * Parse a pasted Roblox link into whatever ids can be found. Pure/synchronous.
 *
 * Handles:
 *   - roblox.com/games/{placeId}/...            -> place id
 *   - create.roblox.com/.../experiences/{u}/... -> universe id (+ place id if
 *     the URL also contains /places/{p})
 *   - a bare numeric id                         -> treated as a place id
 * Returns `null` when nothing usable is found.
 */
export function parseRobloxLink(raw: string): ParsedRobloxLink | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  // Bare numeric id: interpret as a place id (the common share value).
  if (/^\d+$/.test(trimmed)) {
    const placeId = firstPositiveInt([trimmed]);
    return placeId === null ? null : { universeId: null, placeId };
  }

  // Pull ids out of the path regardless of exact host, so we tolerate
  // create.roblox.com dashboard URLs and roblox.com/games URLs alike.
  const path = (() => {
    try {
      return new URL(trimmed).pathname;
    } catch {
      return trimmed;
    }
  })();

  const placeFromGames = /\/games\/(\d+)/i.exec(path);
  const placeFromPlaces = /\/places\/(\d+)/i.exec(path);
  const universeFromExperiences = /\/experiences\/(\d+)/i.exec(path);

  const placeId = firstPositiveInt([placeFromGames?.[1], placeFromPlaces?.[1]]);
  const universeId = firstPositiveInt([universeFromExperiences?.[1]]);

  if (placeId === null && universeId === null) return null;
  return { universeId, placeId };
}

/** Service tag for resolving pasted Roblox links into concrete ids. */
export class RobloxProjectInputResolver extends Context.Service<
  RobloxProjectInputResolver,
  {
    /**
     * Resolve a pasted link into a concrete `{ universeId, placeId }`,
     * fetching whichever id the link did not contain.
     */
    readonly resolveExperience: (input: {
      readonly link: string;
      readonly role: RobloxLinkRole;
    }) => Effect.Effect<ResolvedRobloxExperience, RobloxProjectInputError>;
  }
>()("t3/project/RobloxProjectInputResolver") {}

export const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;

  const getJson = <A, I>(url: string, schema: Schema.Codec<A, I>) =>
    httpClient
      .execute(HttpClientRequest.get(url))
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
      );

  const resolveUniverseForPlace = (placeId: number, role: RobloxLinkRole) =>
    getJson(`${PLACE_UNIVERSE_ENDPOINT}/${placeId}/universe`, PlaceUniverseResponse).pipe(
      Effect.mapError(
        (cause) =>
          new RobloxIdResolutionError({
            role,
            operation: "place-universe",
            id: placeId,
            reason: "request-failed",
            cause,
          }),
      ),
      Effect.flatMap((body) =>
        Number.isSafeInteger(body.universeId) && body.universeId > 0
          ? Effect.succeed(body.universeId)
          : Effect.fail(
              new RobloxIdResolutionError({
                role,
                operation: "place-universe",
                id: placeId,
                reason: "not-found",
              }),
            ),
      ),
    );

  const resolveRootPlaceForUniverse = (universeId: number, role: RobloxLinkRole) =>
    getJson(`${GAMES_ENDPOINT}?universeIds=${universeId}`, GamesResponse).pipe(
      Effect.mapError(
        (cause) =>
          new RobloxIdResolutionError({
            role,
            operation: "universe-root-place",
            id: universeId,
            reason: "request-failed",
            cause,
          }),
      ),
      Effect.flatMap((body) => {
        const rootPlaceId = body.data[0]?.rootPlaceId ?? 0;
        return Number.isSafeInteger(rootPlaceId) && rootPlaceId > 0
          ? Effect.succeed(rootPlaceId)
          : Effect.fail(
              new RobloxIdResolutionError({
                role,
                operation: "universe-root-place",
                id: universeId,
                reason: "not-found",
              }),
            );
      }),
    );

  const resolveExperience: RobloxProjectInputResolver["Service"]["resolveExperience"] = Effect.fn(
    "RobloxProjectInputResolver.resolveExperience",
  )(function* ({ link, role }) {
    const parsed = parseRobloxLink(link);
    if (parsed === null) {
      return yield* new RobloxLinkParseError({ role, link });
    }

    if (parsed.placeId !== null) {
      const universeId =
        parsed.universeId ?? (yield* resolveUniverseForPlace(parsed.placeId, role));
      return { universeId, placeId: parsed.placeId };
    }

    // Only a universe id was found: resolve its root place via the public API.
    const universeId = parsed.universeId as number;
    const placeId = yield* resolveRootPlaceForUniverse(universeId, role);
    return { universeId, placeId };
  });

  return RobloxProjectInputResolver.of({ resolveExperience });
});

export const layer = Layer.effect(RobloxProjectInputResolver, make);
