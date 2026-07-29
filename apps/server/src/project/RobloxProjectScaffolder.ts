/**
 * RobloxProjectScaffolder - creates a new Roblox TypeScript project from the
 * add-project palette.
 *
 * KEYLESS FLOW: this service no longer holds or forwards any Open Cloud API
 * keys, and no longer runs the cloud-project-maker scripts itself. Instances
 * run sandboxed and cannot read the group master key or create repos under the
 * group owner's GitHub account. Instead the scaffolder:
 *
 *   1. resolves the two pasted place IDs (or links) into concrete universe +
 *      place ids via the Roblox public APIs (unchanged), then
 *   2. POSTs the resolved `roblox.json` values to the loopback portal broker
 *      (`POST http://127.0.0.1:3790/internal/roblox-create`), which performs
 *      the entire privileged creation — running new-project.sh + wire-roblox.sh
 *      from the unsandboxed portal process with the master key — and returns
 *      staged progress / typed stage errors.
 *
 * The caller (ws.ts) registers/opens the created project in the instance after
 * this resolves, exactly as the old flow did.
 *
 * @module RobloxProjectScaffolder
 */
import {
  type ProjectCreateRobloxError,
  type ProjectCreateRobloxInput,
  type ProjectCreateRobloxResult,
  type RobloxProjectFile,
  RobloxProjectScaffoldError,
  RobloxProjectWireError,
  type RobloxScaffoldStage,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import * as RobloxProjectInputResolver from "./RobloxProjectInputResolver.ts";

/** Root under which "share with staff" projects are created (LateShift share). */
const SHARED_PROJECTS_ROOT = process.env.T3_SHARED_PROJECTS_DIR ?? "/home/dev/shared";
/** Root under which each instance's own (non-shared) projects live. */
const LATESHIFT_USERS_ROOT =
  process.env.T3_LATESHIFT_USERS_ROOT ?? "/home/dev/services/lateshift/users";
/** Loopback portal broker endpoint that performs the privileged creation. */
const BROKER_URL =
  process.env.T3_ROBLOX_BROKER_URL ?? "http://127.0.0.1:3790/internal/roblox-create";

const PROJECT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const MAX_DETAIL_TAIL = 2000;

/** Validate a project name; returns an error detail string or `null` if valid. */
export function validateProjectName(name: string): string | null {
  if (name.length === 0) return "Project name cannot be empty.";
  if (!PROJECT_NAME_RE.test(name)) {
    return "Project name must start with a letter or digit and contain only letters, digits, and hyphens.";
  }
  return null;
}

/**
 * Build the `roblox.json` values from the two resolved experiences.
 *
 * The workplace/dev experience start place doubles as the Test place, so the
 * test and workplace place ids are the same.
 */
export function buildRobloxProjectFile(input: {
  readonly workplace: RobloxProjectInputResolver.ResolvedRobloxExperience;
  readonly production: RobloxProjectInputResolver.ResolvedRobloxExperience;
}): RobloxProjectFile {
  return {
    devUniverseId: input.workplace.universeId,
    testPlaceId: input.workplace.placeId,
    workplacePlaceId: input.workplace.placeId,
    prodUniverseId: input.production.universeId,
    prodPlaceId: input.production.placeId,
  };
}

/** Compact JSON for the scripts' json argument (no JSON.stringify per lint). */
export function robloxProjectFileToScriptArg(file: RobloxProjectFile): string {
  return (
    `{"devUniverseId":${file.devUniverseId ?? 0},` +
    `"testPlaceId":${file.testPlaceId ?? 0},` +
    `"workplacePlaceId":${file.workplacePlaceId ?? 0},` +
    `"prodUniverseId":${file.prodUniverseId ?? 0},` +
    `"prodPlaceId":${file.prodPlaceId ?? 0}}`
  );
}

/** The joinable roblox.com/games link for a place id (the Test/workplace place). */
export function buildJoinablePlaceLink(placeId: number): string | null {
  return Number.isSafeInteger(placeId) && placeId > 0
    ? `https://www.roblox.com/games/${placeId}`
    : null;
}

/**
 * Response shape from the portal broker. `ok:false` carries a typed `stage`
 * telling us which pipeline step failed so we can surface the right error.
 */
const BrokerResponse = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    stages: Schema.optional(Schema.Array(Schema.String)),
    repositoryUrl: Schema.optional(Schema.String),
    output: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    stage: Schema.String,
    detail: Schema.optional(Schema.String),
    code: Schema.optional(Schema.Number),
    repositoryUrl: Schema.optional(Schema.String),
  }),
]);

/** Service tag for scaffolding a Roblox project from the add-project palette. */
export class RobloxProjectScaffolder extends Context.Service<
  RobloxProjectScaffolder,
  {
    readonly scaffold: (
      input: ProjectCreateRobloxInput,
    ) => Effect.Effect<ProjectCreateRobloxResult, ProjectCreateRobloxError>;
  }
>()("t3/project/RobloxProjectScaffolder") {}

export const make = Effect.gen(function* () {
  const inputResolver = yield* RobloxProjectInputResolver.RobloxProjectInputResolver;
  const path = yield* Path.Path;
  const httpClient = yield* HttpClient.HttpClient;

  /** Directory the freshly created project should live at. */
  const targetDirFor = (name: string, shareWithStaff: boolean): string => {
    if (shareWithStaff) return path.join(SHARED_PROJECTS_ROOT, name);
    const user = process.env.LSC_USER_NAME;
    const base =
      user !== undefined && user.length > 0
        ? path.join(LATESHIFT_USERS_ROOT, user, "projects")
        : path.join(process.env.HOME ?? "/home/dev", "projects");
    return path.join(base, name);
  };

  const scaffold: RobloxProjectScaffolder["Service"]["scaffold"] = Effect.fn(
    "RobloxProjectScaffolder.scaffold",
  )(function* (input) {
    const name = input.name.trim();
    const nameError = validateProjectName(name);
    if (nameError !== null) {
      return yield* new RobloxProjectScaffoldError({
        operation: "validate-name",
        name,
        detail: nameError,
      });
    }

    // Stage: resolve the pasted place IDs / links into concrete universe +
    // place ids. Bare numeric place IDs are the first-class input here.
    const [workplace, production] = yield* Effect.all(
      [
        inputResolver.resolveExperience({ link: input.workplaceLink, role: "workplace" }),
        inputResolver.resolveExperience({ link: input.productionLink, role: "production" }),
      ],
      { concurrency: 2 },
    );
    const roblox = buildRobloxProjectFile({ workplace, production });
    const robloxJson = robloxProjectFileToScriptArg(roblox);
    const targetDir = targetDirFor(name, input.shareWithStaff);
    const stages: Array<RobloxScaffoldStage> = ["resolve"];

    // Stage: hand the whole privileged creation to the loopback portal broker.
    // No secrets cross this boundary — the broker owns the master key. We read
    // the body even on a non-2xx status so typed validation errors surface.
    const response = yield* HttpClientRequest.post(BROKER_URL).pipe(
      HttpClientRequest.bodyJsonUnsafe({
        name,
        robloxJson,
        targetDir,
        shareWithStaff: input.shareWithStaff,
      }),
      httpClient.execute,
      Effect.flatMap(HttpClientResponse.schemaBodyJson(BrokerResponse)),
      Effect.mapError(
        (cause) =>
          new RobloxProjectScaffoldError({
            operation: "run-script",
            name,
            detail: "Failed to reach the project-creation broker.",
            cause,
          }),
      ),
    );

    if (response.ok === false) {
      const detail = (response.detail ?? "").slice(-MAX_DETAIL_TAIL);
      if (response.stage === "verify-download") {
        const retryHint =
          response.repositoryUrl !== undefined
            ? ` then re-run wiring for ${name}.`
            : " then re-run the wiring step.";
        return yield* new RobloxProjectWireError({
          operation: "verify-download",
          name,
          detail:
            `The repo and secrets were created, but the empirical asset-delivery download for the Test place failed: ` +
            `the group master key is missing the "legacy-asset:manage" scope (Legacy Assets -> manage). ` +
            `The plain "Assets" scope is NOT enough and returns 403 Forbidden. ` +
            `Add that scope to the master key at https://create.roblox.com/dashboard/credentials,` +
            retryHint,
        });
      }
      if (response.stage === "wire") {
        return yield* new RobloxProjectWireError({
          operation: "run-script",
          name,
          detail: detail.length > 0 ? detail : "wire-roblox.sh failed in the broker.",
        });
      }
      // "validate", "scaffold", or any other stage → scaffold error.
      return yield* new RobloxProjectScaffoldError({
        operation: response.stage === "validate" ? "validate-name" : "run-script",
        name,
        detail:
          detail.length > 0 ? detail : `Broker rejected the request at stage "${response.stage}".`,
      });
    }

    stages.push("scaffold", "repo", "wire", "deploy-triggered");
    const repositoryUrl = response.repositoryUrl;
    const joinablePlaceLink = buildJoinablePlaceLink(roblox.workplacePlaceId ?? 0);
    const message =
      `Roblox project "${name}" is fully wired at ${targetDir}. ` +
      (repositoryUrl !== undefined ? `Repo: ${repositoryUrl}. ` : "") +
      `The Test place will go live on the first deploy` +
      (joinablePlaceLink !== null ? ` — joinable at ${joinablePlaceLink}.` : ".");

    return {
      projectPath: targetDir,
      roblox,
      stages,
      ...(repositoryUrl !== undefined ? { repositoryUrl } : {}),
      ...(joinablePlaceLink !== null ? { joinablePlaceLink } : {}),
      message,
    };
  });

  return RobloxProjectScaffolder.of({ scaffold });
});

export const layer = Layer.effect(RobloxProjectScaffolder, make);
