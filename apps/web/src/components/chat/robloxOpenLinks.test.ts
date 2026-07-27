import { describe, expect, it } from "vite-plus/test";

import type { RobloxProjectFile } from "@t3tools/contracts";

import {
  hasWorkplaceOpenTargets,
  resolveRobloxOpenTargets,
  robloxGameUrl,
  robloxStudioEditPlaceUri,
} from "./robloxOpenLinks";

const file = (overrides: Partial<RobloxProjectFile> = {}): RobloxProjectFile => ({
  devUniverseId: 0,
  testPlaceId: 0,
  workplacePlaceId: 0,
  prodUniverseId: 0,
  prodPlaceId: 0,
  ...overrides,
});

describe("robloxStudioEditPlaceUri", () => {
  it("builds the modern edit deep link with both ids", () => {
    expect(robloxStudioEditPlaceUri(123, 456)).toBe(
      "roblox-studio:1+launchmode:edit+task:EditPlace+placeId:123+universeId:456",
    );
  });
});

describe("robloxGameUrl", () => {
  it("points at the public game page", () => {
    expect(robloxGameUrl(789)).toBe("https://www.roblox.com/games/789");
  });
});

describe("resolveRobloxOpenTargets", () => {
  it("builds all targets when every id is set", () => {
    const targets = resolveRobloxOpenTargets(
      file({ devUniverseId: 10, workplacePlaceId: 20, testPlaceId: 30, prodPlaceId: 40 }),
    );
    expect(targets.studioEditUri).toBe(
      "roblox-studio:1+launchmode:edit+task:EditPlace+placeId:20+universeId:10",
    );
    expect(targets.workplaceGameUrl).toBe("https://www.roblox.com/games/20");
    expect(targets.productionGameUrl).toBe("https://www.roblox.com/games/40");
  });

  it("falls back to the test place for the game link when workplace is unset", () => {
    const targets = resolveRobloxOpenTargets(file({ devUniverseId: 10, testPlaceId: 30 }));
    expect(targets.studioEditUri).toBeNull();
    expect(targets.workplaceGameUrl).toBe("https://www.roblox.com/games/30");
  });

  it("omits the Studio link when the dev universe id is unset", () => {
    const targets = resolveRobloxOpenTargets(file({ workplacePlaceId: 20 }));
    expect(targets.studioEditUri).toBeNull();
    expect(targets.workplaceGameUrl).toBe("https://www.roblox.com/games/20");
  });

  it("treats 0 and negative ids as unset", () => {
    const targets = resolveRobloxOpenTargets(
      file({ devUniverseId: -1, workplacePlaceId: 0, testPlaceId: 0, prodPlaceId: 0 }),
    );
    expect(targets.studioEditUri).toBeNull();
    expect(targets.workplaceGameUrl).toBeNull();
    expect(targets.productionGameUrl).toBeNull();
    expect(hasWorkplaceOpenTargets(targets)).toBe(false);
  });

  it("reports workplace targets when any is present", () => {
    expect(hasWorkplaceOpenTargets(resolveRobloxOpenTargets(file({ testPlaceId: 30 })))).toBe(true);
  });
});
