import { RobloxProjectFile } from "@t3tools/contracts";

import { fromLenientJson } from "./schemaJson.ts";

/**
 * Codec between the raw `roblox.json` file contents (lenient JSONC string) and
 * the decoded {@link RobloxProjectFile}.
 */
export const RobloxProjectFileFromJson = fromLenientJson(RobloxProjectFile);
