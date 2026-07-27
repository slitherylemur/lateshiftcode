/**
 * RobloxProjectScaffolder - creates a new Roblox TypeScript project from the
 * add-project palette by resolving the pasted experience links, running the
 * cloud-project-maker `new-project.sh` script, and then wiring the resolved
 * ids + Open Cloud API keys into the fresh repo with `wire-roblox.sh` (which
 * creates the GitHub environments/secrets and pushes, triggering the first
 * deploy).
 *
 * The Open Cloud API keys are treated as sensitive: they are wrapped in a
 * `Redacted` value the instant they arrive, passed to `wire-roblox.sh` through
 * the child process environment (never argv, so they stay out of `ps` output),
 * never logged, and scrubbed from any script output that is surfaced in errors.
 * Only `wire-roblox.sh` ever persists them - into GitHub secrets.
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
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as RobloxProjectInputResolver from "./RobloxProjectInputResolver.ts";

/** Root under which "share with staff" projects are created (LateShift share). */
const SHARED_PROJECTS_ROOT = process.env.T3_SHARED_PROJECTS_DIR ?? "/home/dev/shared";
/** cloud-project-maker checkout holding new-project.sh / wire-roblox.sh. */
const CLOUD_PROJECT_MAKER_DIR =
  process.env.T3_CLOUD_PROJECT_MAKER_DIR ?? "/home/dev/projects/cloud-project-maker";
/** new-project.sh always scaffolds under $HOME/projects. */
const homeProjectsRoot = (): string =>
  process.env.T3_HOME_PROJECTS_DIR ?? `${process.env.HOME ?? "/home/dev"}/projects`;

const PROJECT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const MAX_SCRIPT_OUTPUT_TAIL = 2000;
/** Marker emitted by wire-roblox.sh when the empirical asset download fails. */
const WIRE_DOWNLOAD_FAILED_MARKER = "WIRE_ASSET_DOWNLOAD_FAILED";

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

/** Compact JSON for the scripts' `--roblox` / json argument (no JSON.stringify per lint). */
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
 * Parse the GitHub repository URL that new-project.sh prints (`Repo: <url>`).
 * Returns `null` when the line is absent.
 */
export function parseRepositoryUrl(output: string): string | null {
  const match = /Repo:\s*(https:\/\/\S+)/i.exec(output);
  return match?.[1] ?? null;
}

/** Whether wire-roblox.sh reported that the empirical asset download failed. */
export function wireReportedDownloadFailure(output: string): boolean {
  return output.includes(WIRE_DOWNLOAD_FAILED_MARKER);
}

/**
 * Replace any secret values that appear in captured script output with
 * `<redacted>` before the output is surfaced in an error. Belt-and-suspenders:
 * the scripts do not echo the keys, but this guarantees they can never leak
 * through a diagnostic tail.
 */
export function redactSecrets(output: string, secrets: ReadonlyArray<string>): string {
  let scrubbed = output;
  for (const secret of secrets) {
    if (secret.length > 0) scrubbed = scrubbed.split(secret).join("<redacted>");
  }
  return scrubbed;
}

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
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const collectStream = <E>(stream: Stream.Stream<Uint8Array, E>) =>
    Effect.gen(function* () {
      const decoder = new TextDecoder();
      let text = "";
      yield* Stream.runForEach(stream, (chunk: Uint8Array) =>
        Effect.sync(() => {
          text += decoder.decode(chunk, { stream: true });
          if (text.length > MAX_SCRIPT_OUTPUT_TAIL * 4) {
            text = text.slice(-MAX_SCRIPT_OUTPUT_TAIL * 4);
          }
        }),
      );
      return text;
    });

  const runScript = (command: string, args: ReadonlyArray<string>, env: Record<string, string>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawner.spawn(
          ChildProcess.make(command, args, { cwd: CLOUD_PROJECT_MAKER_DIR, env }),
        );
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [collectStream(child.stdout), collectStream(child.stderr), child.exitCode],
          { concurrency: "unbounded" },
        );
        return { code: Number(exitCode), output: `${stdout}${stderr}` };
      }),
    );

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

    // Wrap the keys in Redacted immediately so they are never logged or
    // stringified by accident; the raw values are only read when building the
    // child process environment for wire-roblox.sh.
    const testKey = Redacted.make(input.testApiKey);
    const prodKey = input.prodApiKey !== undefined ? Redacted.make(input.prodApiKey) : undefined;
    const secretValues = [
      Redacted.value(testKey),
      ...(prodKey !== undefined ? [Redacted.value(prodKey)] : []),
    ];

    const homeProjectPath = path.join(homeProjectsRoot(), name);
    const finalPath = input.shareWithStaff
      ? path.join(SHARED_PROJECTS_ROOT, name)
      : homeProjectPath;

    const failIfExists = (dir: string) =>
      fileSystem.exists(dir).pipe(
        Effect.mapError(
          (cause) =>
            new RobloxProjectScaffoldError({
              operation: "already-exists",
              name,
              detail: `Failed to check whether ${dir} already exists.`,
              cause,
            }),
        ),
        Effect.flatMap((exists) =>
          exists
            ? Effect.fail(
                new RobloxProjectScaffoldError({
                  operation: "already-exists",
                  name,
                  detail: `A directory already exists at ${dir}.`,
                }),
              )
            : Effect.void,
        ),
      );

    yield* failIfExists(homeProjectPath);
    if (input.shareWithStaff) {
      yield* failIfExists(finalPath);
    }

    // Stage: resolve the pasted links into concrete universe + place ids.
    const [workplace, production] = yield* Effect.all(
      [
        inputResolver.resolveExperience({ link: input.workplaceLink, role: "workplace" }),
        inputResolver.resolveExperience({ link: input.productionLink, role: "production" }),
      ],
      { concurrency: 2 },
    );
    const roblox = buildRobloxProjectFile({ workplace, production });
    const robloxArg = robloxProjectFileToScriptArg(roblox);
    const stages: Array<RobloxScaffoldStage> = ["resolve"];

    // Stage: scaffold + create the GitHub repo (new-project.sh).
    const scaffoldRun = yield* runScript("./new-project.sh", [name, "--roblox", robloxArg], {
      ...(process.env as Record<string, string>),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new RobloxProjectScaffoldError({
            operation: "run-script",
            name,
            detail: "Failed to run new-project.sh.",
            cause,
          }),
      ),
    );
    if (scaffoldRun.code !== 0) {
      return yield* new RobloxProjectScaffoldError({
        operation: "run-script",
        name,
        detail: `new-project.sh exited with code ${scaffoldRun.code}.\n${redactSecrets(scaffoldRun.output, secretValues).slice(-MAX_SCRIPT_OUTPUT_TAIL)}`,
      });
    }
    stages.push("scaffold", "repo");
    const repositoryUrl = parseRepositoryUrl(scaffoldRun.output);

    // Stage: wire ids + keys and push (wire-roblox.sh). Keys are passed through
    // the environment, never argv, so they never appear in `ps` output.
    const wireEnv: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ROBLOX_TEST_API_KEY: Redacted.value(testKey),
    };
    if (prodKey !== undefined) {
      wireEnv.ROBLOX_PROD_API_KEY = Redacted.value(prodKey);
    }
    const wireRun = yield* runScript("./wire-roblox.sh", [name, robloxArg], wireEnv).pipe(
      Effect.mapError(
        (cause) =>
          new RobloxProjectWireError({
            operation: "run-script",
            name,
            detail: "Failed to run wire-roblox.sh.",
            cause,
          }),
      ),
    );
    if (wireRun.code !== 0) {
      return yield* new RobloxProjectWireError({
        operation: "run-script",
        name,
        detail: `wire-roblox.sh exited with code ${wireRun.code}.\n${redactSecrets(wireRun.output, secretValues).slice(-MAX_SCRIPT_OUTPUT_TAIL)}`,
      });
    }
    if (wireReportedDownloadFailure(wireRun.output)) {
      const retryHint =
        repositoryUrl !== null
          ? ` then re-run wire-roblox.sh for ${name}.`
          : " then re-run wire-roblox.sh.";
      return yield* new RobloxProjectWireError({
        operation: "verify-download",
        name,
        detail:
          `The repo and secrets were created, but the empirical asset-delivery download for the Test place failed: ` +
          `the test API key is missing the "legacy-asset:manage" scope (Legacy Assets -> manage). ` +
          `The plain "Assets" scope is NOT enough and returns 403 Forbidden. ` +
          `Add that scope to the test key at https://create.roblox.com/dashboard/credentials,` +
          retryHint,
      });
    }
    stages.push("wire", "deploy-triggered");

    // Stage: relocate into the shared staff directory if requested. This runs
    // after wire-roblox.sh, which operates on the $HOME/projects checkout.
    if (input.shareWithStaff) {
      yield* fileSystem
        .makeDirectory(SHARED_PROJECTS_ROOT, { recursive: true })
        .pipe(Effect.ignore);
      yield* fileSystem.rename(homeProjectPath, finalPath).pipe(
        Effect.mapError(
          (cause) =>
            new RobloxProjectScaffoldError({
              operation: "relocate",
              name,
              detail: `Wired the project but failed to move it into ${SHARED_PROJECTS_ROOT}.`,
              cause,
            }),
        ),
      );
    }

    const joinablePlaceLink = buildJoinablePlaceLink(roblox.workplacePlaceId ?? 0);
    const message =
      `Roblox project "${name}" is fully wired at ${finalPath}. ` +
      (repositoryUrl !== null ? `Repo: ${repositoryUrl}. ` : "") +
      `The Test place will go live on the first deploy` +
      (joinablePlaceLink !== null ? ` — joinable at ${joinablePlaceLink}.` : ".");

    return {
      projectPath: finalPath,
      roblox,
      stages,
      ...(repositoryUrl !== null ? { repositoryUrl } : {}),
      ...(joinablePlaceLink !== null ? { joinablePlaceLink } : {}),
      message,
    };
  });

  return RobloxProjectScaffolder.of({ scaffold });
});

export const layer = Layer.effect(RobloxProjectScaffolder, make);
