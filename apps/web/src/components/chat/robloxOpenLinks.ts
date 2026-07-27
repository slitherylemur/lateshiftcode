import type { RobloxProjectFile } from "@t3tools/contracts";

/**
 * Roblox universe/place ids are integers; `roblox.json` uses `0` (or an
 * omitted field) to mean "unset". Only strictly-positive safe integers point
 * at a real place/universe.
 */
function isUsableRobloxId(id: number | undefined): id is number {
  return id !== undefined && Number.isSafeInteger(id) && id > 0;
}

/**
 * Build the `roblox-studio:` deep link that launches Roblox Studio editing a
 * published place.
 *
 * Format verified against the Roblox Studio deep-link community tutorial and
 * the current Studio command-line interface docs:
 * `roblox-studio:1+launchmode:edit+task:EditPlace+placeId:<placeId>+universeId:<universeId>`.
 * Both ids are required for the modern protocol handler to resolve the place.
 */
export function robloxStudioEditPlaceUri(placeId: number, universeId: number): string {
  return `roblox-studio:1+launchmode:edit+task:EditPlace+placeId:${placeId}+universeId:${universeId}`;
}

/** Public roblox.com game page for a joinable place. */
export function robloxGameUrl(placeId: number): string {
  return `https://www.roblox.com/games/${placeId}`;
}

export interface RobloxOpenTargets {
  /** Launches Studio editing the workplace place; null unless both the
   * workplace place id and dev universe id are set. */
  readonly studioEditUri: string | null;
  /** Joinable test/workplace place on roblox.com; null when neither is set. */
  readonly workplaceGameUrl: string | null;
  /** Live production place on roblox.com; null when the prod place is unset. */
  readonly productionGameUrl: string | null;
}

/**
 * Resolve the concrete "open" targets for a Roblox project from its
 * `roblox.json` descriptor, ignoring unset (0) ids.
 *
 * The workplace place doubles as the joinable test place, so the game link
 * prefers the workplace place id and falls back to the test place id.
 */
export function resolveRobloxOpenTargets(file: RobloxProjectFile): RobloxOpenTargets {
  const workplacePlaceId = isUsableRobloxId(file.workplacePlaceId) ? file.workplacePlaceId : null;
  const testPlaceId = isUsableRobloxId(file.testPlaceId) ? file.testPlaceId : null;
  const devUniverseId = isUsableRobloxId(file.devUniverseId) ? file.devUniverseId : null;
  const prodPlaceId = isUsableRobloxId(file.prodPlaceId) ? file.prodPlaceId : null;

  const gamePlaceId = workplacePlaceId ?? testPlaceId;

  return {
    studioEditUri:
      workplacePlaceId !== null && devUniverseId !== null
        ? robloxStudioEditPlaceUri(workplacePlaceId, devUniverseId)
        : null,
    workplaceGameUrl: gamePlaceId !== null ? robloxGameUrl(gamePlaceId) : null,
    productionGameUrl: prodPlaceId !== null ? robloxGameUrl(prodPlaceId) : null,
  };
}

/** Whether the "Open Workplace" control has at least one usable target. */
export function hasWorkplaceOpenTargets(targets: RobloxOpenTargets): boolean {
  return targets.studioEditUri !== null || targets.workplaceGameUrl !== null;
}
