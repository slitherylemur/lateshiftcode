import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import * as RobloxProjectInputResolver from "./RobloxProjectInputResolver.ts";
import * as RobloxProjectScaffolder from "./RobloxProjectScaffolder.ts";

const {
  buildJoinablePlaceLink,
  buildRobloxProjectFile,
  robloxProjectFileToScriptArg,
  validateProjectName,
} = RobloxProjectScaffolder;

describe("validateProjectName", () => {
  it("accepts simple names", () => {
    expect(validateProjectName("sky-journey")).toBeNull();
    expect(validateProjectName("Game2")).toBeNull();
  });

  it("rejects empty and invalid names", () => {
    expect(validateProjectName("")).not.toBeNull();
    expect(validateProjectName("-leading")).not.toBeNull();
    expect(validateProjectName("has space")).not.toBeNull();
    expect(validateProjectName("bad/slash")).not.toBeNull();
  });
});

describe("buildRobloxProjectFile", () => {
  it("maps the workplace start place to both the test and workplace place", () => {
    const file = buildRobloxProjectFile({
      workplace: { universeId: 10558704030, placeId: 100961538595186 },
      production: { universeId: 10558727443, placeId: 138759672758413 },
    });
    expect(file).toEqual({
      devUniverseId: 10558704030,
      testPlaceId: 100961538595186,
      workplacePlaceId: 100961538595186,
      prodUniverseId: 10558727443,
      prodPlaceId: 138759672758413,
    });
  });
});

describe("robloxProjectFileToScriptArg", () => {
  it("produces compact JSON that the scripts can parse", () => {
    const arg = robloxProjectFileToScriptArg({
      devUniverseId: 1,
      testPlaceId: 2,
      workplacePlaceId: 2,
      prodUniverseId: 3,
      prodPlaceId: 4,
    });
    expect(arg).toBe(
      '{"devUniverseId":1,"testPlaceId":2,"workplacePlaceId":2,"prodUniverseId":3,"prodPlaceId":4}',
    );
  });
});

describe("buildJoinablePlaceLink", () => {
  it("builds a roblox.com/games link for a real place id", () => {
    expect(buildJoinablePlaceLink(100961538595186)).toBe(
      "https://www.roblox.com/games/100961538595186",
    );
  });
  it("returns null for an unset place id", () => {
    expect(buildJoinablePlaceLink(0)).toBeNull();
    expect(buildJoinablePlaceLink(-1)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Flow tests: stub the broker HTTP client + resolver so no real project/repo
// is created. The scaffolder never sees or forwards any API key.
// ---------------------------------------------------------------------------

interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly body: string;
}

function decodeBody(request: HttpClientRequest.HttpClientRequest): string {
  const body = request.body as { readonly _tag?: string; readonly body?: unknown };
  if (body && body._tag === "Uint8Array" && body.body instanceof Uint8Array) {
    return new TextDecoder().decode(body.body);
  }
  if (body && typeof body.body === "string") return body.body;
  return "";
}

function brokerLayer(response: unknown, status: number, recorded: Array<RecordedRequest>) {
  const execute = (request: HttpClientRequest.HttpClientRequest) => {
    recorded.push({ url: request.url, method: request.method, body: decodeBody(request) });
    return Effect.succeed(
      HttpClientResponse.fromWeb(request, Response.json(response as object, { status })),
    );
  };
  return Layer.succeed(HttpClient.HttpClient, HttpClient.make(execute));
}

const resolverLayer = Layer.succeed(
  RobloxProjectInputResolver.RobloxProjectInputResolver,
  RobloxProjectInputResolver.RobloxProjectInputResolver.of({
    resolveExperience: ({ role }) =>
      Effect.succeed(
        role === "workplace"
          ? { universeId: 111, placeId: 222 }
          : { universeId: 333, placeId: 444 },
      ),
  }),
);

function scaffolderLayer(broker: Layer.Layer<HttpClient.HttpClient>) {
  return RobloxProjectScaffolder.layer.pipe(Layer.provide([resolverLayer, broker, Path.layer]));
}

const baseInput = {
  name: "sky-journey",
  workplaceLink: "222",
  productionLink: "444",
  shareWithStaff: false,
} as const;

describe("RobloxProjectScaffolder.scaffold", () => {
  it.effect("resolves ids and POSTs the broker with no secrets, relaying the result", () => {
    const recorded: Array<RecordedRequest> = [];
    return Effect.gen(function* () {
      const scaffolder = yield* RobloxProjectScaffolder.RobloxProjectScaffolder;
      const result = yield* scaffolder.scaffold(baseInput);

      expect(result.stages).toEqual(["resolve", "scaffold", "repo", "wire", "deploy-triggered"]);
      expect(result.repositoryUrl).toBe("https://github.com/acme/sky-journey");
      expect(result.joinablePlaceLink).toBe("https://www.roblox.com/games/222");
      expect(result.roblox.workplacePlaceId).toBe(222);
      expect(result.roblox.prodPlaceId).toBe(444);

      // Exactly one broker call, carrying the resolved ids + targetDir and NO
      // API keys of any kind.
      expect(recorded).toHaveLength(1);
      const req = recorded[0];
      expect(req?.method).toBe("POST");
      expect(req?.url).toContain("/internal/roblox-create");
      // robloxJson is a nested JSON string, so its quotes are escaped in the
      // request body; assert the resolved ids + targetDir are carried, and that
      // no API key / secret of any kind is.
      expect(req?.body).toContain("workplacePlaceId");
      expect(req?.body).toContain("222");
      expect(req?.body).toContain("prodPlaceId");
      expect(req?.body).toContain("444");
      expect(req?.body).toContain('"targetDir"');
      expect(req?.body.toLowerCase()).not.toContain("apikey");
      expect(req?.body.toLowerCase()).not.toContain("secret");
    }).pipe(
      Effect.provide(
        scaffolderLayer(
          brokerLayer(
            {
              ok: true,
              stages: ["scaffold", "repo", "wire", "deploy-triggered"],
              repositoryUrl: "https://github.com/acme/sky-journey",
              output: "==> Done",
            },
            200,
            recorded,
          ),
        ),
      ),
    );
  });

  it.effect("surfaces the legacy-asset:manage hint when the broker reports verify-download", () =>
    Effect.gen(function* () {
      const scaffolder = yield* RobloxProjectScaffolder.RobloxProjectScaffolder;
      const error = yield* scaffolder.scaffold(baseInput).pipe(Effect.flip);
      expect(error._tag).toBe("RobloxProjectWireError");
      if (error._tag === "RobloxProjectWireError") {
        expect(error.operation).toBe("verify-download");
        expect(error.message).toContain("legacy-asset:manage");
      }
    }).pipe(
      Effect.provide(
        scaffolderLayer(
          brokerLayer(
            { ok: false, stage: "verify-download", repositoryUrl: "https://github.com/acme/x" },
            200,
            [],
          ),
        ),
      ),
    ),
  );

  it.effect("maps a broker wire-stage failure to a RobloxProjectWireError", () =>
    Effect.gen(function* () {
      const scaffolder = yield* RobloxProjectScaffolder.RobloxProjectScaffolder;
      const error = yield* scaffolder.scaffold(baseInput).pipe(Effect.flip);
      expect(error._tag).toBe("RobloxProjectWireError");
      if (error._tag === "RobloxProjectWireError") {
        expect(error.operation).toBe("run-script");
        expect(error.message).toContain("push rejected");
      }
    }).pipe(
      Effect.provide(
        scaffolderLayer(
          brokerLayer({ ok: false, stage: "wire", detail: "push rejected", code: 1 }, 200, []),
        ),
      ),
    ),
  );

  it.effect("maps a broker validate/scaffold failure to a RobloxProjectScaffoldError", () =>
    Effect.gen(function* () {
      const scaffolder = yield* RobloxProjectScaffolder.RobloxProjectScaffolder;
      const error = yield* scaffolder.scaffold(baseInput).pipe(Effect.flip);
      expect(error._tag).toBe("RobloxProjectScaffoldError");
      if (error._tag === "RobloxProjectScaffoldError") {
        expect(error.operation).toBe("run-script");
        expect(error.message).toContain("npm install failed");
      }
    }).pipe(
      Effect.provide(
        scaffolderLayer(
          brokerLayer(
            { ok: false, stage: "scaffold", detail: "npm install failed", code: 1 },
            200,
            [],
          ),
        ),
      ),
    ),
  );

  it.effect("rejects an invalid project name before hitting the broker", () => {
    const recorded: Array<RecordedRequest> = [];
    return Effect.gen(function* () {
      const scaffolder = yield* RobloxProjectScaffolder.RobloxProjectScaffolder;
      const error = yield* scaffolder
        .scaffold({ ...baseInput, name: "bad/name" })
        .pipe(Effect.flip);
      expect(error._tag).toBe("RobloxProjectScaffoldError");
      if (error._tag === "RobloxProjectScaffoldError") {
        expect(error.operation).toBe("validate-name");
      }
      expect(recorded).toHaveLength(0);
    }).pipe(Effect.provide(scaffolderLayer(brokerLayer({ ok: true }, 200, recorded))));
  });
});
