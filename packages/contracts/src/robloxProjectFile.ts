import * as Schema from "effect/Schema";

/** File name of the Roblox project descriptor, resolved at the workspace root. */
export const ROBLOX_PROJECT_FILE_NAME = "roblox.json";

// Roblox universe/place identifiers are integers well within the safe-integer
// range (place ids are ~1e14). They are optional so partially-wired projects
// (e.g. before `wire-roblox.sh` runs) still decode; unset ids are treated as 0.
const RobloxId = Schema.optionalKey(Schema.Number);

/**
 * The `roblox.json` written at the root of a t3cloud Roblox TypeScript project.
 *
 * See the cloud-project-maker runbooks: the dev experience's start place doubles
 * as the Test and Workplace place, and the production experience holds the live
 * place.
 */
export const RobloxProjectFile = Schema.Struct({
  devUniverseId: RobloxId,
  testPlaceId: RobloxId,
  workplacePlaceId: RobloxId,
  prodUniverseId: RobloxId,
  prodPlaceId: RobloxId,
}).annotate({
  title: "Roblox project file",
  description:
    "Roblox universe/place IDs for a t3cloud Roblox project (roblox.json at the repository root).",
});
export type RobloxProjectFile = typeof RobloxProjectFile.Type;

/**
 * Resolve the place id whose published game icon best represents the project.
 *
 * Prefers the production place, falling back to the test place, and ignores
 * unset (0/negative/non-finite) ids. Returns `null` when neither is usable.
 */
export function robloxGameIconPlaceId(file: RobloxProjectFile): number | null {
  const candidates = [file.prodPlaceId, file.testPlaceId];
  for (const candidate of candidates) {
    if (candidate !== undefined && Number.isSafeInteger(candidate) && candidate > 0) {
      return candidate;
    }
  }
  return null;
}
