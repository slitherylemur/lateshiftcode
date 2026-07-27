import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { RobloxProjectFile } from "./robloxProjectFile.ts";

const PROJECT_NAME_MAX_LENGTH = 64;
const LINK_MAX_LENGTH = 2048;

/**
 * Input for creating a new Roblox TypeScript project from the create-project
 * dialog. The two links describe the dev/workplace experience (whose start
 * place doubles as the Test place) and the live production experience.
 */
export const ProjectCreateRobloxInput = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_NAME_MAX_LENGTH)),
  workplaceLink: TrimmedNonEmptyString.check(Schema.isMaxLength(LINK_MAX_LENGTH)),
  productionLink: TrimmedNonEmptyString.check(Schema.isMaxLength(LINK_MAX_LENGTH)),
  shareWithStaff: Schema.Boolean,
});
export type ProjectCreateRobloxInput = typeof ProjectCreateRobloxInput.Type;

/** Successful scaffold result surfaced back to the create-project dialog. */
export const ProjectCreateRobloxResult = Schema.Struct({
  projectPath: TrimmedNonEmptyString,
  roblox: RobloxProjectFile,
  message: Schema.String,
});
export type ProjectCreateRobloxResult = typeof ProjectCreateRobloxResult.Type;

export class RobloxLinkParseError extends Schema.TaggedErrorClass<RobloxLinkParseError>()(
  "RobloxLinkParseError",
  {
    role: Schema.Literals(["workplace", "production"]),
    link: Schema.String,
  },
) {
  override get message(): string {
    return `Could not find a Roblox universe or place id in the ${this.role} link. Paste a create.roblox.com experience URL or a roblox.com/games/... URL.`;
  }
}

export class RobloxIdResolutionError extends Schema.TaggedErrorClass<RobloxIdResolutionError>()(
  "RobloxIdResolutionError",
  {
    role: Schema.Literals(["workplace", "production"]),
    operation: Schema.Literals(["place-universe", "universe-root-place"]),
    id: Schema.Number,
    reason: Schema.Literals(["request-failed", "not-found"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    if (this.operation === "universe-root-place") {
      return this.reason === "not-found"
        ? `Could not read the root place of universe ${this.id} for the ${this.role} experience. This usually means the universe is private; paste the roblox.com/games/... link for its start place instead.`
        : `Failed to look up the root place of universe ${this.id} for the ${this.role} experience.`;
    }
    return `Failed to look up the universe of place ${this.id} for the ${this.role} experience.`;
  }
}

export class RobloxProjectScaffoldError extends Schema.TaggedErrorClass<RobloxProjectScaffoldError>()(
  "RobloxProjectScaffoldError",
  {
    operation: Schema.Literals([
      "validate-name",
      "already-exists",
      "run-script",
      "relocate",
      "read-result",
    ]),
    name: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

/** All errors that the Roblox scaffold RPC can return to the client. */
export const RobloxProjectInputError = Schema.Union([
  RobloxLinkParseError,
  RobloxIdResolutionError,
]);
export type RobloxProjectInputError = typeof RobloxProjectInputError.Type;

export const ProjectCreateRobloxError = Schema.Union([
  RobloxLinkParseError,
  RobloxIdResolutionError,
  RobloxProjectScaffoldError,
]);
export type ProjectCreateRobloxError = typeof ProjectCreateRobloxError.Type;
