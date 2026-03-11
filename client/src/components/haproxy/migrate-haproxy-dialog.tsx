import { useState, useEffect } from "react";
import { Channel } from "@mini-infra/types";
import {
  useMigrationPreview,
  useMigrateHAProxy,
  useMigrationProgress,
} from "@/hooks/use-haproxy-remediation";
import { useTaskTracker } from "@/hooks/use-task-tracker";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import type { MigrationStep } from "@mini-infra/types";
import {
  IconLoader2,
  IconAlertTriangle,
  IconArrowRight,
  IconTrash,
  IconCheck,
  IconX,
  IconCertificate,
  IconDatabase,
  IconServer2,
  IconNetwork,
} from "@tabler/icons-react";
import { cn } from "@/lib/utils";

interface MigrateHAProxyDialogProps {
  environmentId: string;
  environmentName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

type DialogState = "preview" | "migrating" | "success" | "error";

function StepStatusIcon({ status }: { status: MigrationStep["status"] }) {
  if (status === "completed") {
    return <IconCheck className="h-4 w-4 text-green-600 dark:text-green-400" />;
  }
  if (status === "failed") {
    return <IconX className="h-4 w-4 text-red-600 dark:text-red-400" />;
  }
  return <IconArrowRight className="h-4 w-4 text-muted-foreground" />;
}

export function MigrateHAProxyDialog({
  environmentId,
  environmentName,
  open,
  onOpenChange,
  onSuccess,
}: MigrateHAProxyDialogProps) {
  const [dialogState, setDialogState] = useState<DialogState>("preview");

  const {
    data: previewResponse,
    isLoading: isLoadingPreview,
    isError: isPreviewError,
    error: previewError,
    refetch: refetchPreview,
  } = useMigrationPreview(environmentId, {
    enabled: open && dialogState === "preview",
  });

  const migrateMutation = useMigrateHAProxy();
  const migrationProgress = useMigrationProgress(environmentId);
  const { registerTask } = useTaskTracker();

  const preview = previewResponse?.data;

  // Track migration progress from Socket.IO events
  useEffect(() => {
    if (migrationProgress.isMigrating && dialogState !== "migrating") {
      setDialogState("migrating");
    }
  }, [migrationProgress.isMigrating, dialogState]);

  // Handle migration completion from Socket.IO
  useEffect(() => {
    if (!migrationProgress.finalResult) return;

    if (migrationProgress.finalResult.success) {
      setDialogState("success");
      onSuccess?.();
    } else {
      setDialogState("error");
    }
  }, [migrationProgress.finalResult, onSuccess]);

  const handleMigrate = async () => {
    setDialogState("migrating");
    migrationProgress.reset();

    try {
      await migrateMutation.mutateAsync(environmentId);
      // HTTP responded with { started: true } — real progress comes via Socket.IO
      registerTask({
        id: environmentId,
        type: "migration",
        label: `Migrating HAProxy for ${environmentName}`,
        channel: Channel.STACKS,
      });
    } catch {
      setDialogState("error");
    }
  };

  const handleOpenChange = (isOpen: boolean) => {
    if (!isOpen) {
      setDialogState("preview");
      migrationProgress.reset();
    }
    onOpenChange(isOpen);
  };

  const handleClose = () => {
    handleOpenChange(false);
  };

  // Use Socket.IO results when available, otherwise show empty
  const resultSteps = migrationProgress.finalResult?.steps ?? migrationProgress.completedSteps;
  const resultErrors = migrationProgress.finalResult?.errors ?? [];

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <IconServer2 className="h-5 w-5" />
            {dialogState === "success"
              ? "Migration Complete"
              : dialogState === "error"
                ? "Migration Failed"
                : "Migrate HAProxy to Stack Management"}
          </DialogTitle>
          <DialogDescription>
            {dialogState === "preview" &&
              `Migrate the legacy HAProxy instance for ${environmentName} to be managed by the stack system.`}
            {dialogState === "migrating" &&
              "Migration in progress. This will briefly interrupt traffic..."}
            {dialogState === "success" &&
              "HAProxy is now managed by the stack system."}
            {dialogState === "error" &&
              "There were errors during the migration process."}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] overflow-y-auto pr-4">
          {/* Preview State */}
          {dialogState === "preview" && (
            <div className="space-y-4">
              {isLoadingPreview && (
                <div className="space-y-3">
                  <Skeleton className="h-8 w-full" />
                  <Skeleton className="h-24 w-full" />
                  <Skeleton className="h-24 w-full" />
                </div>
              )}

              {isPreviewError && (
                <Alert variant="destructive">
                  <IconAlertTriangle className="h-4 w-4" />
                  <AlertDescription>
                    {previewError instanceof Error
                      ? previewError.message
                      : "Failed to load migration preview"}
                  </AlertDescription>
                </Alert>
              )}

              {preview && !isLoadingPreview && (
                <>
                  {/* Warning banner */}
                  <Alert className="bg-yellow-50 dark:bg-yellow-950 border-yellow-200 dark:border-yellow-800">
                    <IconAlertTriangle className="h-4 w-4 text-yellow-600" />
                    <AlertDescription className="text-yellow-800 dark:text-yellow-200">
                      <strong>Downtime Warning:</strong> This will stop the
                      current HAProxy container and start a new one. Traffic will
                      be interrupted during the migration.
                    </AlertDescription>
                  </Alert>

                  {/* What will happen */}
                  <div className="space-y-2">
                    <h4 className="font-medium text-sm">Migration Steps</h4>
                    <div className="rounded-md border divide-y">
                      {/* Step 1: Remove container */}
                      {preview.legacyContainer && (
                        <div className="p-3">
                          <div className="flex items-center gap-2 text-sm">
                            <IconTrash className="h-4 w-4 text-red-500" />
                            <span className="font-medium">Remove legacy container</span>
                          </div>
                          <div className="mt-1 ml-6">
                            <Badge variant="outline" className="text-xs font-mono">
                              {preview.legacyContainer.name}
                            </Badge>
                          </div>
                        </div>
                      )}

                      {/* Step 2: Remove volumes */}
                      {preview.legacyVolumes.length > 0 && (
                        <div className="p-3">
                          <div className="flex items-center gap-2 text-sm">
                            <IconDatabase className="h-4 w-4 text-red-500" />
                            <span className="font-medium">
                              Remove {preview.legacyVolumes.length} legacy volume(s)
                            </span>
                          </div>
                          <div className="mt-1 ml-6 flex flex-wrap gap-1">
                            {preview.legacyVolumes.map((vol) => (
                              <Badge
                                key={vol}
                                variant="outline"
                                className="text-xs font-mono bg-red-50 dark:bg-red-950 border-red-200"
                              >
                                {vol}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Step 3: Deploy via stack */}
                      <div className="p-3">
                        <div className="flex items-center gap-2 text-sm">
                          <IconServer2 className="h-4 w-4 text-green-500" />
                          <span className="font-medium">Deploy new HAProxy via stack</span>
                        </div>
                        <div className="mt-1 ml-6 space-y-1">
                          <div className="text-xs text-muted-foreground">
                            Container:{" "}
                            <span className="font-mono">
                              {preview.postMigration.newContainerName}
                            </span>
                          </div>
                          <div className="text-xs text-muted-foreground">
                            New volumes: {preview.postMigration.newVolumes.length}
                          </div>
                        </div>
                      </div>

                      {/* Step 4: Network reuse */}
                      <div className="p-3">
                        <div className="flex items-center gap-2 text-sm">
                          <IconNetwork className="h-4 w-4 text-blue-500" />
                          <span className="font-medium">Reuse existing network</span>
                        </div>
                        <div className="mt-1 ml-6">
                          <Badge variant="outline" className="text-xs font-mono bg-blue-50 dark:bg-blue-950 border-blue-200">
                            {preview.postMigration.networkReused}
                          </Badge>
                        </div>
                      </div>

                      {/* Step 5: Backends & Servers */}
                      {(preview.backendCount > 0 || preview.serverCount > 0) && (
                        <div className="p-3">
                          <div className="flex items-center gap-2 text-sm">
                            <IconServer2 className="h-4 w-4 text-cyan-500" />
                            <span className="font-medium">
                              Recreate {preview.backendCount} backend(s) with {preview.serverCount} server(s)
                            </span>
                          </div>
                          <div className="mt-1 ml-6 text-xs text-muted-foreground">
                            Restored from database records to reconnect running containers
                          </div>
                        </div>
                      )}

                      {/* Step 6: Certificates */}
                      {preview.certificateCount > 0 && (
                        <div className="p-3">
                          <div className="flex items-center gap-2 text-sm">
                            <IconCertificate className="h-4 w-4 text-purple-500" />
                            <span className="font-medium">
                              Redeploy {preview.certificateCount} TLS certificate(s)
                            </span>
                          </div>
                        </div>
                      )}

                      {/* Step 7: Remediation */}
                      {preview.postMigration.remediationNeeded && (
                        <div className="p-3">
                          <div className="flex items-center gap-2 text-sm">
                            <IconArrowRight className="h-4 w-4 text-yellow-500" />
                            <span className="font-medium">
                              Configure shared frontends & routes
                            </span>
                          </div>
                          <div className="mt-1 ml-6 text-xs text-muted-foreground">
                            Existing deployment configurations will be set up on the new instance
                          </div>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Stack info */}
                  {preview.stackStatus && (
                    <div className="rounded-md border p-3 bg-muted/30">
                      <div className="text-sm">
                        <span className="text-muted-foreground">Stack:</span>{" "}
                        <span className="font-medium">{preview.stackStatus.name}</span>
                        {" "}
                        <Badge variant="outline" className="text-xs">
                          {preview.stackStatus.status}
                        </Badge>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* Migrating State — live progress from Socket.IO */}
          {dialogState === "migrating" && (
            <div className="space-y-4">
              <div className="flex items-center justify-center py-4">
                <IconLoader2 className="h-10 w-10 animate-spin text-primary" />
              </div>
              <div className="text-center text-sm text-muted-foreground mb-4">
                {migrationProgress.completedSteps.length > 0
                  ? `Step ${migrationProgress.completedSteps.length} of ~${migrationProgress.totalSteps}`
                  : "Starting migration..."}
              </div>

              {migrationProgress.completedSteps.length > 0 && (
                <div className="rounded-md border p-4 space-y-1">
                  {migrationProgress.completedSteps.map((step, i) => (
                    <div
                      key={i}
                      className="flex items-start gap-2 text-sm p-1.5 rounded"
                    >
                      <StepStatusIcon status={step.status} />
                      <div className="flex-1">
                        <span className="font-medium">{step.step}</span>
                        {step.detail && (
                          <span className="text-muted-foreground ml-1">
                            — {step.detail}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Success State */}
          {dialogState === "success" && (
            <div className="space-y-4">
              <div className="flex items-center justify-center py-4">
                <div className="rounded-full bg-green-100 dark:bg-green-900 p-3">
                  <IconCheck className="h-8 w-8 text-green-600 dark:text-green-400" />
                </div>
              </div>

              <div className="rounded-md border p-4 space-y-2">
                <h4 className="font-medium">Migration Steps</h4>
                <div className="space-y-1">
                  {resultSteps.map((step, i) => (
                    <div
                      key={i}
                      className="flex items-start gap-2 text-sm p-1.5 rounded hover:bg-muted/50"
                    >
                      <StepStatusIcon status={step.status} />
                      <div className="flex-1">
                        <span className="font-medium">{step.step}</span>
                        {step.detail && (
                          <span className="text-muted-foreground ml-1">
                            — {step.detail}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {resultErrors.length > 0 && (
                <Alert className="bg-yellow-50 dark:bg-yellow-950 border-yellow-200">
                  <IconAlertTriangle className="h-4 w-4 text-yellow-600" />
                  <AlertDescription>
                    <div className="font-medium mb-1">Warnings:</div>
                    <ul className="text-sm list-disc list-inside">
                      {resultErrors.map((error, i) => (
                        <li key={i}>{error}</li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              )}
            </div>
          )}

          {/* Error State */}
          {dialogState === "error" && (
            <div className="space-y-4">
              <div className="flex items-center justify-center py-4">
                <div className="rounded-full bg-red-100 dark:bg-red-900 p-3">
                  <IconX className="h-8 w-8 text-red-600 dark:text-red-400" />
                </div>
              </div>

              <Alert variant="destructive">
                <IconAlertTriangle className="h-4 w-4" />
                <AlertDescription>
                  The migration encountered errors. Some steps may have been
                  applied. Check the HAProxy status and the stack system.
                </AlertDescription>
              </Alert>

              {resultSteps.length > 0 && (
                <div className="rounded-md border p-3">
                  <h4 className="font-medium mb-2 text-sm">Step Results:</h4>
                  <div className="space-y-1">
                    {resultSteps.map((step, i) => (
                      <div
                        key={i}
                        className="flex items-start gap-2 text-sm"
                      >
                        <StepStatusIcon status={step.status} />
                        <div className="flex-1">
                          <span className={cn(
                            "font-medium",
                            step.status === "failed" && "text-red-600 dark:text-red-400"
                          )}>
                            {step.step}
                          </span>
                          {step.detail && (
                            <span className="text-muted-foreground ml-1">
                              — {step.detail}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {resultErrors.length > 0 && (
                <div className="rounded-md border p-3">
                  <h4 className="font-medium mb-2 text-sm">Errors:</h4>
                  <ul className="text-sm space-y-1 text-red-600 dark:text-red-400">
                    {resultErrors.map((error, i) => (
                      <li key={i} className="flex items-start gap-2">
                        <IconX className="h-4 w-4 mt-0.5 flex-shrink-0" />
                        <span>{error}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          {dialogState === "preview" && (
            <>
              <Button variant="outline" onClick={handleClose}>
                Cancel
              </Button>
              {isPreviewError && (
                <Button variant="outline" onClick={() => refetchPreview()}>
                  Retry
                </Button>
              )}
              <Button
                onClick={handleMigrate}
                disabled={isLoadingPreview || isPreviewError || !preview?.needsMigration}
                className={cn(
                  preview?.needsMigration
                    ? "bg-yellow-600 hover:bg-yellow-700"
                    : ""
                )}
              >
                <IconArrowRight className="h-4 w-4 mr-2" />
                {preview?.needsMigration ? "Start Migration" : "No Migration Needed"}
              </Button>
            </>
          )}

          {dialogState === "migrating" && (
            <Button variant="outline" disabled>
              <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />
              Please Wait...
            </Button>
          )}

          {(dialogState === "success" || dialogState === "error") && (
            <Button onClick={handleClose}>
              Close
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
