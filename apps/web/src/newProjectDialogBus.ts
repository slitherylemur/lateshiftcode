// Tiny event bus letting the command palette (and other surfaces) open the
// New project dialog in a specific mode without owning its React state.
import type { EnvironmentId } from "@t3tools/contracts";

const NEW_PROJECT_DIALOG_OPEN_EVENT = "t3code:open-new-project-dialog";

export interface NewProjectDialogOpenDetail {
  /** Which section of the dialog to focus. Defaults to the plain workspace form. */
  readonly mode?: "default" | "roblox";
  /** Environment the project should be created in, when known (palette flow). */
  readonly environmentId?: EnvironmentId;
}

export function openNewProjectDialog(detail?: NewProjectDialogOpenDetail): void {
  window.dispatchEvent(
    new CustomEvent(NEW_PROJECT_DIALOG_OPEN_EVENT, detail ? { detail } : undefined),
  );
}

export function onOpenNewProjectDialog(
  listener: (detail: NewProjectDialogOpenDetail) => void,
): () => void {
  const handler = (event: Event) => {
    listener((event as CustomEvent<NewProjectDialogOpenDetail>).detail ?? {});
  };
  window.addEventListener(NEW_PROJECT_DIALOG_OPEN_EVENT, handler);
  return () => window.removeEventListener(NEW_PROJECT_DIALOG_OPEN_EVENT, handler);
}
