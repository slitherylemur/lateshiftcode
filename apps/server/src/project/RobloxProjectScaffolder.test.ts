import { describe, expect, it } from "@effect/vitest";

import {
  buildRobloxProjectFile,
  robloxProjectFileToScriptArg,
  validateProjectName,
} from "./RobloxProjectScaffolder.ts";

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
  it("produces compact JSON that new-project.sh can parse", () => {
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
