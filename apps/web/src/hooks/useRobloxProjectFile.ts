import {
  ROBLOX_PROJECT_FILE_NAME,
  type EnvironmentId,
  type RobloxProjectFile,
} from "@t3tools/contracts";
import { RobloxProjectFileFromJson } from "@t3tools/shared/robloxProjectFile";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { useMemo } from "react";

import { useProjectFileQuery } from "~/components/files/projectFilesQueryState";

const decodeRobloxProjectFile = Schema.decodeExit(RobloxProjectFileFromJson);

/**
 * Decode the project's checked-in `roblox.json`, marking the project as a
 * Roblox project and exposing its universe/place ids to the client.
 *
 * Mirrors `useT3ProjectFileScripts`: reads the file through the existing
 * project-file query channel and decodes it client-side. Missing, truncated,
 * or invalid files resolve to `null` (i.e. "not a Roblox project"), so callers
 * render nothing and non-Roblox projects are unaffected.
 */
export function useRobloxProjectFile(
  environmentId: EnvironmentId,
  cwd: string | null,
): RobloxProjectFile | null {
  const query = useProjectFileQuery(
    environmentId,
    cwd ?? "",
    ROBLOX_PROJECT_FILE_NAME,
    cwd !== null,
  );
  const contents = query.data && !query.data.truncated ? query.data.contents : null;
  return useMemo(() => {
    if (contents === null) return null;
    const decoded = decodeRobloxProjectFile(contents);
    if (Exit.isFailure(decoded)) return null;
    return decoded.value;
  }, [contents]);
}
