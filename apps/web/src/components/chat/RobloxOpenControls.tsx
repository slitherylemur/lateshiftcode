import { type EnvironmentId } from "@t3tools/contracts";
import { Boxes, ChevronDownIcon, ExternalLinkIcon, Rocket, SquarePen } from "lucide-react";
import { memo, useCallback } from "react";

import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { useRobloxProjectFile } from "~/hooks/useRobloxProjectFile";
import { hasWorkplaceOpenTargets, resolveRobloxOpenTargets } from "./robloxOpenLinks";

/**
 * Open an external/custom-protocol URL from a click handler.
 *
 * The web app can run in a plain browser, where `roblox-studio:` deep links are
 * only handled reliably when a real anchor is clicked (a bare
 * `window.location` assignment can navigate the page away before the OS
 * protocol handler takes over). We therefore synthesize a transient anchor and
 * click it. `newTab` is used for ordinary `https:` game links.
 */
function openExternalHref(href: string, newTab: boolean): void {
  const anchor = document.createElement("a");
  anchor.href = href;
  if (newTab) {
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
  }
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
}

/**
 * Roblox "quick open" controls rendered in the chat header for projects that
 * ship a `roblox.json` descriptor. Renders nothing for non-Roblox projects (or
 * Roblox projects with no wired-up place ids), so it is zero-impact otherwise.
 */
export const RobloxOpenControls = memo(function RobloxOpenControls({
  environmentId,
  cwd,
}: {
  environmentId: EnvironmentId;
  cwd: string | null;
}) {
  const file = useRobloxProjectFile(environmentId, cwd);

  const openStudio = useCallback((uri: string) => openExternalHref(uri, false), []);
  const openGame = useCallback((url: string) => openExternalHref(url, true), []);

  if (!file) return null;

  const targets = resolveRobloxOpenTargets(file);
  const showWorkplace = hasWorkplaceOpenTargets(targets);
  const showProduction = targets.productionGameUrl !== null;
  if (!showWorkplace && !showProduction) return null;

  return (
    <>
      {showWorkplace && (
        <Menu>
          <MenuTrigger render={<Button aria-label="Open Workplace" size="xs" variant="outline" />}>
            <Boxes aria-hidden="true" className="size-3.5" />
            <span className="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5">
              Open Workplace
            </span>
            <ChevronDownIcon aria-hidden="true" className="size-4" />
          </MenuTrigger>
          <MenuPopup align="end">
            {targets.studioEditUri !== null && (
              <MenuItem onClick={() => openStudio(targets.studioEditUri as string)}>
                <SquarePen aria-hidden="true" />
                Studio
              </MenuItem>
            )}
            {targets.workplaceGameUrl !== null && (
              <MenuItem onClick={() => openGame(targets.workplaceGameUrl as string)}>
                <ExternalLinkIcon aria-hidden="true" />
                Game link
              </MenuItem>
            )}
          </MenuPopup>
        </Menu>
      )}
      {showProduction && (
        <Button
          aria-label="Open Production"
          size="xs"
          variant="outline"
          onClick={() => openGame(targets.productionGameUrl as string)}
        >
          <Rocket aria-hidden="true" className="size-3.5" />
          <span className="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5">
            Open Production
          </span>
        </Button>
      )}
    </>
  );
});
