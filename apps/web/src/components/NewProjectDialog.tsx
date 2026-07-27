"use client";

import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useState } from "react";

import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { inferProjectTitleFromPath, resolveProjectPathForDispatch } from "../lib/projectPaths";
import { newProjectId } from "../lib/utils";
import { resolveDefaultProviderModelSelection } from "../providerInstances";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { projectEnvironment } from "../state/projects";
import { useAtomCommand } from "../state/use-atom-command";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Field, FieldDescription, FieldLabel } from "./ui/field";
import { Input } from "./ui/input";
import { stackedThreadToast, toastManager } from "./ui/toast";

const SHARED_PROJECT_BASE_DIRECTORY = "/home/dev/shared";

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

export function NewProjectDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onBrowseExisting: () => void;
}) {
  const { onBrowseExisting, onOpenChange, open } = props;
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const { handleNewThread } = useHandleNewThread();
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const createRobloxProject = useAtomCommand(projectEnvironment.createRoblox, {
    reportFailure: false,
  });

  const [name, setName] = useState("");
  const [shareWithStaff, setShareWithStaff] = useState(false);
  const [isRobloxProject, setIsRobloxProject] = useState(false);
  const [workplaceLink, setWorkplaceLink] = useState("");
  const [productionLink, setProductionLink] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const resetForm = useCallback(() => {
    setName("");
    setShareWithStaff(false);
    setIsRobloxProject(false);
    setWorkplaceLink("");
    setProductionLink("");
  }, []);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      onOpenChange(nextOpen);
      if (!nextOpen) resetForm();
    },
    [onOpenChange, resetForm],
  );

  const trimmedName = name.trim();
  const trimmedWorkplaceLink = workplaceLink.trim();
  const trimmedProductionLink = productionLink.trim();
  const canSubmit =
    trimmedName.length > 0 &&
    !isSubmitting &&
    (primaryEnvironmentId !== null || environments.length > 0) &&
    (!isRobloxProject || (trimmedWorkplaceLink.length > 0 && trimmedProductionLink.length > 0));

  const handleSubmit = useCallback(async () => {
    const environmentId: EnvironmentId | null =
      primaryEnvironmentId ?? environments[0]?.environmentId ?? null;
    if (environmentId === null || trimmedName.length === 0) return;

    setIsSubmitting(true);
    try {
      if (isRobloxProject) {
        const result = await createRobloxProject({
          environmentId,
          input: {
            name: trimmedName,
            workplaceLink: trimmedWorkplaceLink,
            productionLink: trimmedProductionLink,
            shareWithStaff,
          },
        });
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Failed to create Roblox project",
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
          }
          return;
        }
        toastManager.add(
          stackedThreadToast({
            type: "success",
            title: "Roblox project created",
            description: result.value.message,
          }),
        );
        handleOpenChange(false);
        return;
      }

      const environment = environments.find(
        (candidate) => candidate.environmentId === environmentId,
      );
      const configuredBaseDirectory =
        environment?.serverConfig?.settings.addProjectBaseDirectory?.trim() ?? "";
      const baseDirectory = shareWithStaff
        ? SHARED_PROJECT_BASE_DIRECTORY
        : configuredBaseDirectory.length > 0
          ? configuredBaseDirectory
          : "~/";
      const rawCwd = `${ensureTrailingSlash(baseDirectory)}${trimmedName}`;
      const cwd = resolveProjectPathForDispatch(rawCwd, null);

      const projectId = newProjectId();
      const targetEnvironmentProviders = environment?.serverConfig?.providers ?? [];
      const createResult = await createProject({
        environmentId,
        input: {
          projectId,
          title: inferProjectTitleFromPath(cwd),
          workspaceRoot: cwd,
          createWorkspaceRootIfMissing: true,
          defaultModelSelection: resolveDefaultProviderModelSelection(
            targetEnvironmentProviders,
            null,
          ),
        },
      });
      if (createResult._tag === "Failure") {
        if (!isAtomCommandInterrupted(createResult)) {
          const error = squashAtomCommandFailure(createResult);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to add project",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
        return;
      }

      const navigationResult = await settlePromise(() =>
        handleNewThread(scopeProjectRef(environmentId, projectId)),
      );
      if (navigationResult._tag === "Failure") {
        const error = squashAtomCommandFailure(navigationResult);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to add project",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
        return;
      }
      handleOpenChange(false);
    } finally {
      setIsSubmitting(false);
    }
  }, [
    createProject,
    createRobloxProject,
    environments,
    handleNewThread,
    handleOpenChange,
    isRobloxProject,
    primaryEnvironmentId,
    shareWithStaff,
    trimmedName,
    trimmedProductionLink,
    trimmedWorkplaceLink,
  ]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader className="gap-1.5">
          <DialogTitle className="text-balance">New project</DialogTitle>
          <DialogDescription>
            Create a new project workspace, or{" "}
            <button
              type="button"
              className="underline underline-offset-2 hover:text-foreground"
              onClick={() => {
                handleOpenChange(false);
                onBrowseExisting();
              }}
            >
              browse for an existing folder
            </button>
            .
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-5">
          <Field>
            <FieldLabel>Project name</FieldLabel>
            <Input
              autoFocus
              value={name}
              placeholder="my-project"
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && canSubmit) {
                  event.preventDefault();
                  void handleSubmit();
                }
              }}
            />
          </Field>

          <label className="flex items-start gap-2.5">
            <Checkbox
              checked={shareWithStaff}
              onCheckedChange={(checked) => setShareWithStaff(checked === true)}
              className="mt-0.5"
            />
            <span className="flex flex-col gap-0.5">
              <span className="font-medium text-foreground text-sm">Share with staff</span>
              <span className="text-muted-foreground text-xs">
                Creates the project under the shared staff directory instead of your default
                location.
              </span>
            </span>
          </label>

          <label className="flex items-start gap-2.5">
            <Checkbox
              checked={isRobloxProject}
              onCheckedChange={(checked) => setIsRobloxProject(checked === true)}
              className="mt-0.5"
            />
            <span className="flex flex-col gap-0.5">
              <span className="font-medium text-foreground text-sm">Roblox project</span>
              <span className="text-muted-foreground text-xs">
                Scaffold a Roblox TypeScript project linked to a workplace and production
                experience.
              </span>
            </span>
          </label>

          {isRobloxProject ? (
            <div className="flex flex-col gap-4 border-border/60 border-l-2 pl-3.5">
              <Field>
                <FieldLabel>Workplace game link</FieldLabel>
                <Input
                  value={workplaceLink}
                  placeholder="https://create.roblox.com/dashboard/creations/experiences/..."
                  onChange={(event) => setWorkplaceLink(event.target.value)}
                />
                <FieldDescription>
                  The dev experience whose start place holds the Studio-authored world and doubles
                  as the Test place.
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel>Production place link</FieldLabel>
                <Input
                  value={productionLink}
                  placeholder="https://www.roblox.com/games/..."
                  onChange={(event) => setProductionLink(event.target.value)}
                />
                <FieldDescription>The live game experience.</FieldDescription>
              </Field>
            </div>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => {
              handleOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button
            disabled={!canSubmit}
            onClick={() => {
              void handleSubmit();
            }}
          >
            {isSubmitting
              ? isRobloxProject
                ? "Creating Roblox project…"
                : "Creating…"
              : "Create project"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
