import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as RobloxProjectInputResolver from "./RobloxProjectInputResolver.ts";
import * as RobloxProjectScaffolder from "./RobloxProjectScaffolder.ts";

const {
  buildJoinablePlaceLink,
  buildRobloxProjectFile,
  parseRepositoryUrl,
  redactSecrets,
  robloxProjectFileToScriptArg,
  validateProjectName,
  wireReportedDownloadFailure,
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

describe("parseRepositoryUrl", () => {
  it("pulls the repo url out of new-project.sh output", () => {
    expect(parseRepositoryUrl("Project sky ready\nRepo: https://github.com/acme/sky\nDone")).toBe(
      "https://github.com/acme/sky",
    );
  });
  it("returns null when absent", () => {
    expect(parseRepositoryUrl("no url here")).toBeNull();
  });
});

describe("wireReportedDownloadFailure", () => {
  it("detects the wire-roblox marker", () => {
    expect(wireReportedDownloadFailure("...\nWIRE_ASSET_DOWNLOAD_FAILED\n...")).toBe(true);
    expect(wireReportedDownloadFailure("asset-delivery download WORKS")).toBe(false);
  });
});

describe("redactSecrets", () => {
  it("scrubs every occurrence of each secret", () => {
    expect(redactSecrets("a KEY1 b KEY2 c KEY1", ["KEY1", "KEY2"])).toBe(
      "a <redacted> b <redacted> c <redacted>",
    );
  });
  it("ignores empty secrets", () => {
    expect(redactSecrets("unchanged", [""])).toBe("unchanged");
  });
});

// ---------------------------------------------------------------------------
// Flow tests: stub the shell + filesystem so no real project/repo is created.
// ---------------------------------------------------------------------------

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

interface RecordedSpawn {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Record<string, string | undefined> | undefined;
}

function stubHandle(stdout: string, stderr: string, code: number) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    stdout: stdout.length > 0 ? Stream.make(encode(stdout)) : Stream.empty,
    stderr: stderr.length > 0 ? Stream.make(encode(stderr)) : Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
}

function makeSpawnerLayer(options: {
  readonly recorded: Array<RecordedSpawn>;
  readonly wireStderr?: string;
  readonly wireCode?: number;
  readonly scaffoldCode?: number;
}) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const cmd = command as unknown as {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
        readonly options?: { readonly env?: Record<string, string | undefined> };
      };
      options.recorded.push({ command: cmd.command, args: cmd.args, env: cmd.options?.env });
      if (cmd.command.includes("wire-roblox")) {
        return Effect.succeed(
          stubHandle("==> Done\n", options.wireStderr ?? "", options.wireCode ?? 0),
        );
      }
      return Effect.succeed(
        stubHandle(
          "Project sky-journey ready\nRepo: https://github.com/acme/sky-journey\n",
          "",
          options.scaffoldCode ?? 0,
        ),
      );
    }),
  );
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

function scaffolderLayer(spawner: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>) {
  return RobloxProjectScaffolder.layer.pipe(
    Layer.provide([
      resolverLayer,
      spawner,
      FileSystem.layerNoop({ exists: () => Effect.succeed(false) }),
      Path.layer,
    ]),
  );
}

const baseInput = {
  name: "sky-journey",
  workplaceLink: "https://www.roblox.com/games/222/x",
  productionLink: "https://www.roblox.com/games/444/y",
  shareWithStaff: false,
} as const;

describe("RobloxProjectScaffolder.scaffold", () => {
  it.effect("runs new-project.sh then wire-roblox.sh, passing keys via env not argv", () => {
    const recorded: Array<RecordedSpawn> = [];
    return Effect.gen(function* () {
      const scaffolder = yield* RobloxProjectScaffolder.RobloxProjectScaffolder;
      const result = yield* scaffolder.scaffold({
        ...baseInput,
        testApiKey: "TEST_SECRET_KEY",
        prodApiKey: "PROD_SECRET_KEY",
      });

      expect(result.stages).toEqual(["resolve", "scaffold", "repo", "wire", "deploy-triggered"]);
      expect(result.repositoryUrl).toBe("https://github.com/acme/sky-journey");
      expect(result.joinablePlaceLink).toBe("https://www.roblox.com/games/222");
      expect(result.roblox.workplacePlaceId).toBe(222);
      expect(result.roblox.prodPlaceId).toBe(444);

      expect(recorded.map((entry) => entry.command)).toEqual([
        "./new-project.sh",
        "./wire-roblox.sh",
      ]);
      const wire = recorded[1];
      expect(wire?.env?.ROBLOX_TEST_API_KEY).toBe("TEST_SECRET_KEY");
      expect(wire?.env?.ROBLOX_PROD_API_KEY).toBe("PROD_SECRET_KEY");
      // The keys must never appear in the argument vector (visible via `ps`).
      expect(wire?.args.join(" ")).not.toContain("TEST_SECRET_KEY");
      expect(wire?.args.join(" ")).not.toContain("PROD_SECRET_KEY");
      // Or in the scaffold spawn at all.
      expect(recorded[0]?.args.join(" ")).not.toContain("SECRET");
    }).pipe(Effect.provide(scaffolderLayer(makeSpawnerLayer({ recorded }))));
  });

  it.effect("omits the prod key env var when no prod key is supplied", () => {
    const recorded: Array<RecordedSpawn> = [];
    return Effect.gen(function* () {
      const scaffolder = yield* RobloxProjectScaffolder.RobloxProjectScaffolder;
      yield* scaffolder.scaffold({ ...baseInput, testApiKey: "ONLY_TEST_KEY" });
      const wire = recorded[1];
      expect(wire?.env?.ROBLOX_TEST_API_KEY).toBe("ONLY_TEST_KEY");
      expect(wire?.env?.ROBLOX_PROD_API_KEY).toBeUndefined();
    }).pipe(Effect.provide(scaffolderLayer(makeSpawnerLayer({ recorded }))));
  });

  it.effect("surfaces the legacy-asset:manage hint when the download check fails", () =>
    Effect.gen(function* () {
      const scaffolder = yield* RobloxProjectScaffolder.RobloxProjectScaffolder;
      const error = yield* scaffolder
        .scaffold({ ...baseInput, testApiKey: "BAD_SCOPE_KEY" })
        .pipe(Effect.flip);
      expect(error._tag).toBe("RobloxProjectWireError");
      if (error._tag === "RobloxProjectWireError") {
        expect(error.operation).toBe("verify-download");
        expect(error.message).toContain("legacy-asset:manage");
      }
    }).pipe(
      Effect.provide(
        scaffolderLayer(
          makeSpawnerLayer({ recorded: [], wireStderr: "WIRE_ASSET_DOWNLOAD_FAILED\n" }),
        ),
      ),
    ),
  );

  it.effect("returns a wire error when wire-roblox.sh exits non-zero", () =>
    Effect.gen(function* () {
      const scaffolder = yield* RobloxProjectScaffolder.RobloxProjectScaffolder;
      const error = yield* scaffolder
        .scaffold({ ...baseInput, testApiKey: "KEY" })
        .pipe(Effect.flip);
      expect(error._tag).toBe("RobloxProjectWireError");
      if (error._tag === "RobloxProjectWireError") {
        expect(error.operation).toBe("run-script");
      }
    }).pipe(Effect.provide(scaffolderLayer(makeSpawnerLayer({ recorded: [], wireCode: 1 })))),
  );
});
