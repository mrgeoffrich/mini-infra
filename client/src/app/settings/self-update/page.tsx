import { useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  IconAlertCircle,
  IconCheck,
  IconCircleDashed,
  IconDownload,
  IconLoader2,
  IconRefresh,
  IconRotate,
  IconX,
} from "@tabler/icons-react";
import { toastWithCopy } from "@/lib/toast-utils";
import {
  useSelfUpdateCheck,
  useTriggerUpdate,
  useSelfUpdateLaunchProgress,
  useIsUpdateActive,
  type SelfUpdateStatus,
} from "@/hooks/use-self-update";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STATE_LABELS: Record<SelfUpdateStatus["state"], string> = {
  idle: "Idle",
  pending: "Preparing update...",
  checking: "Checking for updates...",
  pulling: "Pulling new image...",
  inspecting: "Inspecting container...",
  stopping: "Stopping current container...",
  creating: "Creating new container...",
  "health-checking": "Health-checking new container...",
  complete: "Update complete",
  "rolling-back": "Rolling back...",
  "rollback-complete": "Rollback complete",
  failed: "Update failed",
};

function StateBadge({ state }: { state: SelfUpdateStatus["state"] }) {
  const variant =
    state === "complete"
      ? "default"
      : state === "failed" || state === "rollback-complete"
        ? "destructive"
        : "secondary";

  return <Badge variant={variant}>{STATE_LABELS[state] ?? state}</Badge>;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function SelfUpdateSettingsPage() {
  const [triggerTag, setTriggerTag] = useState<"latest" | "production" | "">("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [launchOperationId, setLaunchOperationId] = useState<string | null>(null);

  // Hooks
  const checkUpdate = useSelfUpdateCheck();
  const triggerUpdate = useTriggerUpdate();
  const launchProgress = useSelfUpdateLaunchProgress(
    launchOperationId,
    triggerTag ? `Launching update to ${triggerTag}` : "Launching update sidecar",
  );
  const {
    isActive,
    state,
    targetTag,
    error: updateError,
    isReconnecting,
  } = useIsUpdateActive();

  // Handlers
  const handleCheckDocker = () => {
    checkUpdate.mutate(undefined, {
      onSuccess: (data) => {
        if (data.available) {
          toastWithCopy.success("Running in Docker and ready for updates");
        } else {
          toastWithCopy.warning(data.reason ?? "Self-update not available");
        }
      },
      onError: (err) => {
        toastWithCopy.error(err.message);
      },
    });
  };

  const handleTriggerUpdate = (channel: "latest" | "production") => {
    setTriggerTag(channel);
    setConfirmOpen(true);
  };

  const handleConfirmUpdate = () => {
    if (!triggerTag) return;
    setConfirmOpen(false);
    triggerUpdate.mutate(
      { targetTag: triggerTag },
      {
        onSuccess: (data) => {
          setLaunchOperationId(data.operationId);
          setTriggerTag("");
        },
        onError: (err) => {
          toastWithCopy.error(err.message);
        },
      },
    );
  };

  // -------------------------------------------------------------------------
  // Update in progress overlay
  // -------------------------------------------------------------------------

  if (isActive) {
    const { state: progressState } = launchProgress;
    const hasLaunchSteps =
      progressState.plannedStepNames.length > 0 ||
      progressState.completedSteps.length > 0;
    // Build a set of completed/failed step names for quick lookup
    const completedStepMap = new Map(
      progressState.completedSteps.map((s) => [s.step, s]),
    );
    // Determine the next step being worked on (first planned step not yet completed)
    const stepsToShow = hasLaunchSteps
      ? progressState.plannedStepNames
      : [];

    // Once the sidecar is launched, show a final "Update sidecar running" step
    const sidecarRunning =
      progressState.phase === "success" ||
      (hasLaunchSteps &&
        progressState.completedSteps.length >= progressState.totalSteps);

    return (
      <div className="container mx-auto max-w-4xl space-y-6 py-8">
        <Card>
          <CardHeader className="text-center">
            <CardTitle className="flex items-center justify-center gap-2 text-xl">
              <IconRefresh className="h-6 w-6 animate-spin" />
              Updating Mini Infra
            </CardTitle>
            <CardDescription>
              {targetTag && <>Updating to {targetTag}</>}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Launch step progress */}
            {hasLaunchSteps && (
              <div className="mx-auto max-w-md space-y-2">
                {stepsToShow.map((stepName) => {
                  const completed = completedStepMap.get(stepName);
                  const isCurrentStep =
                    !completed &&
                    stepsToShow.indexOf(stepName) ===
                      progressState.completedSteps.length;

                  return (
                    <div
                      key={stepName}
                      className="flex items-center gap-3 text-sm"
                    >
                      {completed ? (
                        completed.status === "failed" ? (
                          <IconX className="h-4 w-4 shrink-0 text-destructive" />
                        ) : completed.status === "skipped" ? (
                          <IconCircleDashed className="h-4 w-4 shrink-0 text-muted-foreground" />
                        ) : (
                          <IconCheck className="h-4 w-4 shrink-0 text-green-500" />
                        )
                      ) : isCurrentStep ? (
                        <IconLoader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
                      ) : (
                        <IconCircleDashed className="h-4 w-4 shrink-0 text-muted-foreground/50" />
                      )}
                      <span
                        className={
                          completed
                            ? completed.status === "failed"
                              ? "text-destructive"
                              : "text-foreground"
                            : isCurrentStep
                              ? "text-foreground"
                              : "text-muted-foreground/50"
                        }
                      >
                        {stepName}
                      </span>
                    </div>
                  );
                })}

                {/* Sidecar running step */}
                <div className="flex items-center gap-3 text-sm">
                  {sidecarRunning ? (
                    <IconLoader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
                  ) : (
                    <IconCircleDashed className="h-4 w-4 shrink-0 text-muted-foreground/50" />
                  )}
                  <span
                    className={
                      sidecarRunning
                        ? "text-foreground"
                        : "text-muted-foreground/50"
                    }
                  >
                    Update sidecar running
                  </span>
                </div>
              </div>
            )}

            {/* Fallback status badge when no launch steps available */}
            {!hasLaunchSteps && (
              <div className="flex items-center justify-center">
                {state && <StateBadge state={state} />}
              </div>
            )}

            {/* Reconnection notice */}
            {isReconnecting ? (
              <Alert>
                <IconLoader2 className="h-4 w-4 animate-spin" />
                <AlertDescription>
                  The server is restarting. Waiting for it to come back
                  online...
                </AlertDescription>
              </Alert>
            ) : (
              <p className="text-center text-sm text-muted-foreground">
                {sidecarRunning
                  ? "The update sidecar is replacing the running container. The server will restart automatically when the update completes."
                  : "Preparing update — pulling images and launching the update sidecar..."}
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Last update result banner
  // -------------------------------------------------------------------------

  const showResultBanner =
    state === "complete" ||
    state === "rollback-complete" ||
    state === "failed";

  // -------------------------------------------------------------------------
  // Main UI
  // -------------------------------------------------------------------------

  return (
    <div className="container mx-auto max-w-4xl space-y-6 py-8">
      {/* Header */}
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <IconDownload className="h-6 w-6" />
          <h1 className="text-2xl font-bold tracking-tight">
            System Update
          </h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Update Mini Infra to a new version via the sidecar container mechanism
        </p>
      </div>

      {/* Last update result */}
      {showResultBanner && (
        <Alert
          variant={state === "complete" ? "default" : "destructive"}
        >
          {state === "complete" ? (
            <IconCheck className="h-4 w-4" />
          ) : (
            <IconX className="h-4 w-4" />
          )}
          <AlertDescription>
            {state === "complete" && (
              <>
                Successfully updated
                {targetTag && <> to <strong>{targetTag}</strong></>}.
              </>
            )}
            {state === "rollback-complete" && (
              <>
                Update failed and was rolled back.
                {updateError && <> Reason: {updateError}</>}
              </>
            )}
            {state === "failed" && (
              <>
                Update failed.
                {updateError && <> Reason: {updateError}</>}
              </>
            )}
          </AlertDescription>
        </Alert>
      )}

      {/* Trigger Update Card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <IconRotate className="h-5 w-5" />
            Trigger Update
          </CardTitle>
          <CardDescription>
            Pulls all three images (main, sidecar, agent sidecar) with the
            selected tag and launches the update sidecar. The server will
            restart during this process.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleCheckDocker}
              disabled={checkUpdate.isPending}
            >
              {checkUpdate.isPending ? (
                <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <IconRefresh className="h-4 w-4 mr-2" />
              )}
              Check Docker Status
            </Button>
          </div>

          <div className="flex gap-2">
            <Button
              onClick={() => handleTriggerUpdate("latest")}
              disabled={triggerUpdate.isPending}
              variant="outline"
            >
              {triggerUpdate.isPending && triggerTag === "latest" ? (
                <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <IconDownload className="h-4 w-4 mr-2" />
              )}
              Update to Latest
            </Button>
            <Button
              onClick={() => handleTriggerUpdate("production")}
              disabled={triggerUpdate.isPending}
            >
              {triggerUpdate.isPending && triggerTag === "production" ? (
                <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <IconDownload className="h-4 w-4 mr-2" />
              )}
              Update to Production
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Confirmation Dialog */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm System Update</DialogTitle>
            <DialogDescription>
              This will update Mini Infra to{" "}
              <strong>{triggerTag}</strong>. The server will restart during
              this process. If the new version fails health checks, the
              previous version will be automatically restored.
            </DialogDescription>
          </DialogHeader>
          <Alert>
            <IconAlertCircle className="h-4 w-4" />
            <AlertDescription>
              All active connections will be interrupted during the update.
            </AlertDescription>
          </Alert>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleConfirmUpdate}>
              <IconDownload className="h-4 w-4 mr-2" />
              Start Update
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
