"use client";

import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useEffect, useState } from "react";

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
  /** When the dialog is opened via the palette, which section to focus. */
  readonly initialMode?: "default" | "roblox";
  /** Environment the project should be created in, when the caller knows it. */
  readonly environmentIdOverride?: EnvironmentId | null;
}) {
  const { environmentIdOverride, initialMode, onBrowseExisting, onOpenChange, open } = props;
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

  // When the dialog is (re)opened, adopt the requested mode. Opening via the
  // palette's "Roblox game" source focuses the Roblox flow directly.
  useEffect(() => {
    if (open) {
      setIsRobloxProject(initialMode === "roblox");
    }
  }, [open, initialMode]);

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
  const resolvedEnvironmentId: EnvironmentId | null =
    environmentIdOverride ?? primaryEnvironmentId ?? environments[0]?.environmentId ?? null;
  const canSubmit =
    trimmedName.length > 0 &&
    !isSubmitting &&
    resolvedEnvironmentId !== null &&
    (!isRobloxProject || (trimmedWorkplaceLink.length > 0 && trimmedProductionLink.length > 0));

  const handleSubmit = useCallback(async () => {
    const environmentId = resolvedEnvironmentId;
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
    resolvedEnvironmentId,
    shareWithStaff,
    trimmedName,
    trimmedProductionLink,
    trimmedWorkplaceLink,
  ]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader className="gap-1.5">
          <DialogTitle className="text-balance">
            {isRobloxProject ? "New Roblox game" : "New project"}
          </DialogTitle>
          <DialogDescription>
            {isRobloxProject ? (
              "Scaffold a roblox-ts project with CI and auto-publish, wired to your Roblox experiences."
            ) : (
              <>
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
              </>
            )}
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
            <FieldDescription>
              Lowercase letters, digits, and hyphens. Checked against your existing repositories.
            </FieldDescription>
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

          {!isRobloxProject ? (
            <label className="flex items-start gap-2.5">
              <Checkbox
                checked={isRobloxProject}
                onCheckedChange={(checked) => setIsRobloxProject(checked === true)}
                className="mt-0.5"
              />
              <span className="flex flex-col gap-0.5">
                <span className="font-medium text-foreground text-sm">Roblox game</span>
                <span className="text-muted-foreground text-xs">
                  Scaffold a roblox-ts project with CI and auto-publish, linked to a workplace and
                  production experience.
                </span>
              </span>
            </label>
          ) : null}

          {isRobloxProject ? (
            <div className="flex flex-col gap-4 border-border/60 border-l-2 pl-3.5">
              <Field>
                <FieldLabel>Workplace place ID</FieldLabel>
                <Input
                  value={workplaceLink}
                  placeholder="e.g. 1234567890"
                  onChange={(event) => setWorkplaceLink(event.target.value)}
                />
                <FieldDescription>
                  The place holding your Studio-built world; doubles as the joinable Test place.
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel>Production place ID</FieldLabel>
                <Input
                  value={productionLink}
                  placeholder="e.g. 9876543210"
                  onChange={(event) => setProductionLink(event.target.value)}
                />
                <FieldDescription>
                  Your live game&apos;s place; only the manual Promote workflow publishes here.
                </FieldDescription>
              </Field>
              <div className="flex flex-col gap-1.5 text-muted-foreground text-xs">
                <p>The experience must be in the Late Shift Games group.</p>
                <p>
                  The repository is created under the group owner&apos;s GitHub account. Publishing
                  uses the group master key automatically.
                </p>
              </div>
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
                ? "Creating Roblox game…"
                : "Creating…"
              : isRobloxProject
                ? "Create Roblox game"
                : "Create project"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
