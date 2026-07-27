import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { decideOrchestrationCommand } from "./decider.ts";
import { TurnBudgetGuard, type TurnBudgetGuardShape } from "./Services/TurnBudgetGuard.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function makeReadModel(instanceId: string): OrchestrationReadModel {
  const thread: OrchestrationThread = {
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make(instanceId), model: "model-x" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
  };
  return { snapshotSequence: 0, projects: [], threads: [thread], updatedAt: NOW };
}

const turnStartCommand = {
  type: "thread.turn.start",
  commandId: CommandId.make("cmd-turn-start"),
  threadId: ThreadId.make("thread-1"),
  message: {
    messageId: MessageId.make("message-1"),
    role: "user",
    text: "Go",
    attachments: [],
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdAt: NOW,
} as const;

const stubGuard = (result: Option.Option<string>): TurnBudgetGuardShape => ({
  evaluateTurnStart: () => Effect.succeed(result),
});

it.layer(NodeServices.layer)("thread.turn.start budget gating", (it) => {
  it.effect("rejects the turn with the guard's friendly detail when over budget", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: turnStartCommand,
        readModel: makeReadModel("claude"),
      }).pipe(
        Effect.provideService(
          TurnBudgetGuard,
          stubGuard(Option.some("Claude budget reached ($50.00/mo). Ask your admin.")),
        ),
        Effect.flip,
      );
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      expect(String(error)).toContain("Claude budget reached ($50.00/mo). Ask your admin.");
    }),
  );

  it.effect("allows the turn when the guard permits it", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: turnStartCommand,
        readModel: makeReadModel("claude"),
      }).pipe(Effect.provideService(TurnBudgetGuard, stubGuard(Option.none())));
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.map((event) => event.type)).toEqual([
        "thread.message-sent",
        "thread.turn-start-requested",
      ]);
    }),
  );

  it.effect("allows the turn when no guard is provided (gating disabled)", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: turnStartCommand,
        readModel: makeReadModel("codex"),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.map((event) => event.type)).toEqual([
        "thread.message-sent",
        "thread.turn-start-requested",
      ]);
    }),
  );
});
