import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  type OrchestrationProject,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, beforeEach, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function makeProject(id: string, deletedAt: string | null = null): OrchestrationProject {
  return {
    id: ProjectId.make(id),
    title: `Project ${id}`,
    workspaceRoot: `/tmp/${id}`,
    defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    scripts: [],
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt,
  };
}

function makeReadModel(projects: ReadonlyArray<OrchestrationProject>): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects,
    threads: [],
    updatedAt: NOW,
  };
}

function makeCreateCommand(id: string) {
  return {
    type: "project.create",
    commandId: CommandId.make(`cmd-create-${id}`),
    projectId: ProjectId.make(id),
    title: `Project ${id}`,
    workspaceRoot: `/tmp/${id}`,
    createdAt: NOW,
  } as const;
}

const originalMaxProjects = process.env["T3CODE_MAX_PROJECTS"];

beforeEach(() => {
  delete process.env["T3CODE_MAX_PROJECTS"];
});

afterEach(() => {
  if (originalMaxProjects === undefined) {
    delete process.env["T3CODE_MAX_PROJECTS"];
  } else {
    process.env["T3CODE_MAX_PROJECTS"] = originalMaxProjects;
  }
});

it.layer(NodeServices.layer)("project.create limit (T3CODE_MAX_PROJECTS)", (it) => {
  it.effect("rejects creation once the live project count reaches the limit", () =>
    Effect.gen(function* () {
      process.env["T3CODE_MAX_PROJECTS"] = "2";
      const error = yield* decideOrchestrationCommand({
        command: makeCreateCommand("project-c"),
        readModel: makeReadModel([makeProject("project-a"), makeProject("project-b")]),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      expect(String(error)).toContain("Project limit reached (2). Ask your admin to raise it.");
    }),
  );

  it.effect("ignores soft-deleted projects when counting toward the limit", () =>
    Effect.gen(function* () {
      process.env["T3CODE_MAX_PROJECTS"] = "2";
      const decided = yield* decideOrchestrationCommand({
        command: makeCreateCommand("project-c"),
        readModel: makeReadModel([makeProject("project-a"), makeProject("project-b", NOW)]),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events[0]?.type).toBe("project.created");
    }),
  );

  it.effect("enforces a whitespace-padded numeric limit after trimming", () =>
    Effect.gen(function* () {
      process.env["T3CODE_MAX_PROJECTS"] = " 2 ";
      const error = yield* decideOrchestrationCommand({
        command: makeCreateCommand("project-c"),
        readModel: makeReadModel([makeProject("project-a"), makeProject("project-b")]),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("treats unset, zero, negative, and invalid limits as unlimited", () =>
    Effect.gen(function* () {
      const projects = [makeProject("project-a"), makeProject("project-b")];
      // "2junk", "1.5", and "1e2" would be accepted by a bare parseInt; the
      // strict decimal-integer rule must treat them as unlimited instead of
      // silently activating a partial parse as the limit.
      for (const limit of [undefined, "0", "-3", "banana", "", "2junk", "1.5", "1e2"]) {
        if (limit === undefined) {
          delete process.env["T3CODE_MAX_PROJECTS"];
        } else {
          process.env["T3CODE_MAX_PROJECTS"] = limit;
        }
        const decided = yield* decideOrchestrationCommand({
          command: makeCreateCommand(`project-new-${limit ?? "unset"}`),
          readModel: makeReadModel(projects),
        });
        const events = Array.isArray(decided) ? decided : [decided];
        expect(events[0]?.type).toBe("project.created");
      }
    }),
  );
});
