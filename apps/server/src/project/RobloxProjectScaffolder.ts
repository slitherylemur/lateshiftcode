/**
 * RobloxProjectScaffolder - creates a new Roblox TypeScript project from the
 * create-project dialog by resolving the pasted experience links and running
 * the cloud-project-maker `new-project.sh` script non-interactively.
 *
 * API keys are intentionally NOT handled here: the completion message tells the
 * admin to run `wire-roblox.sh` with their Open Cloud keys to enable deployment.
 *
 * @module RobloxProjectScaffolder
 */
import {
  type ProjectCreateRobloxError,
  type ProjectCreateRobloxInput,
  type ProjectCreateRobloxResult,
  type RobloxProjectFile,
  RobloxProjectScaffoldError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
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

/** Compact JSON for new-project.sh's `--roblox` flag (no JSON.stringify per lint). */
export function robloxProjectFileToScriptArg(file: RobloxProjectFile): string {
  return (
    `{"devUniverseId":${file.devUniverseId ?? 0},` +
    `"testPlaceId":${file.testPlaceId ?? 0},` +
    `"workplacePlaceId":${file.workplacePlaceId ?? 0},` +
    `"prodUniverseId":${file.prodUniverseId ?? 0},` +
    `"prodPlaceId":${file.prodPlaceId ?? 0}}`
  );
}

/** Service tag for scaffolding a Roblox project from the create-project dialog. */
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

  const runNewProjectScript = (name: string, robloxArg: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawner.spawn(
          ChildProcess.make("./new-project.sh", [name, "--roblox", robloxArg], {
            cwd: CLOUD_PROJECT_MAKER_DIR,
            env: { ...process.env },
          }),
        );
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [collectStream(child.stdout), collectStream(child.stderr), child.exitCode],
          { concurrency: "unbounded" },
        );
        return { code: Number(exitCode), output: `${stdout}${stderr}` };
      }),
    ).pipe(
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

  const failIfExists = (dir: string, name: string) =>
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

    const homeProjectPath = path.join(homeProjectsRoot(), name);
    const finalPath = input.shareWithStaff
      ? path.join(SHARED_PROJECTS_ROOT, name)
      : homeProjectPath;
    yield* failIfExists(homeProjectPath, name);
    if (input.shareWithStaff) {
      yield* failIfExists(finalPath, name);
    }

    const [workplace, production] = yield* Effect.all(
      [
        inputResolver.resolveExperience({ link: input.workplaceLink, role: "workplace" }),
        inputResolver.resolveExperience({ link: input.productionLink, role: "production" }),
      ],
      { concurrency: 2 },
    );
    const roblox = buildRobloxProjectFile({ workplace, production });

    const run = yield* runNewProjectScript(name, robloxProjectFileToScriptArg(roblox));
    if (run.code !== 0) {
      return yield* new RobloxProjectScaffoldError({
        operation: "run-script",
        name,
        detail: `new-project.sh exited with code ${run.code}.\n${run.output.slice(-MAX_SCRIPT_OUTPUT_TAIL)}`,
      });
    }

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
              detail: `Scaffolded the project but failed to move it into ${SHARED_PROJECTS_ROOT}.`,
              cause,
            }),
        ),
      );
    }

    return {
      projectPath: finalPath,
      roblox,
      message:
        `Roblox project "${name}" was created at ${finalPath}. ` +
        `Next, an admin should run wire-roblox.sh with the Open Cloud API keys to enable deployment.`,
    };
  });

  return RobloxProjectScaffolder.of({ scaffold });
});

export const layer = Layer.effect(RobloxProjectScaffolder, make);
