import { useState } from "react";
import {
  useRemediationPreview,
  useRemediateHAProxy,
} from "@/hooks/use-haproxy-remediation";
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
import { Progress } from "@/components/ui/progress";
import { toast } from "sonner";
import { RemediateHAProxyStep } from "@mini-infra/types";
import {
  IconLoader2,
  IconAlertTriangle,
  IconRouter,
  IconRoute,
  IconPlus,
  IconRefresh,
  IconCheck,
  IconX,
  IconMinus,
  IconShield,
} from "@tabler/icons-react";
import { cn } from "@/lib/utils";

interface RemediateHAProxyDialogProps {
  environmentId: string;
  environmentName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

type DialogState = "preview" | "remediating" | "success" | "error";

export function RemediateHAProxyDialog({
  environmentId,
  environmentName,
  open,
  onOpenChange,
  onSuccess,
}: RemediateHAProxyDialogProps) {
  const [dialogState, setDialogState] = useState<DialogState>("preview");
  const [result, setResult] = useState<{
    steps: RemediateHAProxyStep[];
    errors: string[];
  } | null>(null);

  const {
    data: previewResponse,
    isLoading: isLoadingPreview,
    isError: isPreviewError,
    error: previewError,
    refetch: refetchPreview,
  } = useRemediationPreview(environmentId, {
    enabled: open && dialogState === "preview",
  });

  const remediateMutation = useRemediateHAProxy();

  const preview = previewResponse?.data;

  const handleRemediate = async () => {
    setDialogState("remediating");

    try {
      const response = await remediateMutation.mutateAsync(environmentId);
      setResult(response.data);
      setDialogState(response.success ? "success" : "error");

      if (response.success) {
        toast.success("HAProxy rebuild completed successfully");
        onSuccess?.();
      } else {
        toast.error("HAProxy rebuild completed with errors");
      }
    } catch (error) {
      setResult(null);
      setDialogState("error");
      toast.error(
        `Rebuild failed: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  };

  const handleOpenChange = (isOpen: boolean) => {
    if (!isOpen) {
      // Reset state when closing
      setDialogState("preview");
      setResult(null);
    }
    onOpenChange(isOpen);
  };

  const handleClose = () => {
    handleOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <IconRouter className="h-5 w-5" />
            {dialogState === "success"
              ? "Rebuild Complete"
              : dialogState === "error"
                ? "Rebuild Failed"
                : "Rebuild HAProxy"}
          </DialogTitle>
          <DialogDescription>
            {dialogState === "preview" &&
              `Full rebuild of HAProxy runtime state from database for ${environmentName}. This restores TLS certificates, frontends, backends, and all routing rules.`}
            {dialogState === "remediating" &&
              "Rebuild in progress. Please wait..."}
            {dialogState === "success" &&
              "HAProxy has been successfully rebuilt from database state."}
            {dialogState === "error" &&
              "There were errors during the rebuild process."}
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
                      : "Failed to load remediation preview"}
                  </AlertDescription>
                </Alert>
              )}

              {preview && !isLoadingPreview && (
                <>
                  {/* Warning banner */}
                  <Alert className="bg-yellow-50 dark:bg-yellow-950 border-yellow-200 dark:border-yellow-800">
                    <IconAlertTriangle className="h-4 w-4 text-yellow-600" />
                    <AlertDescription className="text-yellow-800 dark:text-yellow-200">
                      <strong>Traffic Disruption Warning:</strong> This operation
                      will briefly interrupt traffic routing while HAProxy is
                      reconfigured. Existing connections may be dropped.
                    </AlertDescription>
                  </Alert>

                  {/* Current State */}
                  <div className="space-y-2">
                    <h4 className="font-medium text-sm flex items-center gap-2">
                      <IconRouter className="h-4 w-4" />
                      Current Configuration
                    </h4>
                    <div className="rounded-md border p-3 bg-muted/30">
                      <div className="grid grid-cols-2 gap-4 text-sm">
                        <div>
                          <span className="text-muted-foreground">Frontends:</span>{" "}
                          <span className="font-medium">
                            {preview.currentState.frontends.length}
                          </span>
                        </div>
                        <div>
                          <span className="text-muted-foreground">Backends:</span>{" "}
                          <span className="font-medium">
                            {preview.currentState.backends.length}
                          </span>
                        </div>
                      </div>
                      {preview.currentState.frontends.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {preview.currentState.frontends.slice(0, 10).map((name) => (
                            <Badge
                              key={name}
                              variant="outline"
                              className="text-xs font-mono"
                            >
                              {name}
                            </Badge>
                          ))}
                          {preview.currentState.frontends.length > 10 && (
                            <Badge variant="outline" className="text-xs">
                              +{preview.currentState.frontends.length - 10} more
                            </Badge>
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Changes to be made */}
                  <div className="space-y-2">
                    <h4 className="font-medium text-sm flex items-center gap-2">
                      <IconRefresh className="h-4 w-4" />
                      Changes to be Made
                    </h4>
                    <div className="rounded-md border divide-y">
                      {/* Frontends to create */}
                      {preview.changes.frontendsToCreate.length > 0 && (
                        <div className="p-3">
                          <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400 mb-2">
                            <IconPlus className="h-4 w-4" />
                            <span className="font-medium">
                              Create {preview.changes.frontendsToCreate.length} shared frontend(s)
                            </span>
                          </div>
                          <div className="flex flex-wrap gap-1">
                            {preview.changes.frontendsToCreate.map((name) => (
                              <Badge
                                key={name}
                                variant="outline"
                                className="text-xs font-mono bg-green-50 dark:bg-green-950 border-green-200"
                              >
                                {name}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Routes to add */}
                      {preview.changes.routesToAdd.length > 0 && (
                        <div className="p-3">
                          <div className="flex items-center gap-2 text-sm text-blue-600 dark:text-blue-400 mb-2">
                            <IconRoute className="h-4 w-4" />
                            <span className="font-medium">
                              Configure {preview.changes.routesToAdd.length} route(s)
                            </span>
                          </div>
                          <div className="flex flex-wrap gap-1">
                            {preview.changes.routesToAdd.slice(0, 10).map((route) => (
                              <Badge
                                key={route}
                                variant="outline"
                                className="text-xs font-mono bg-blue-50 dark:bg-blue-950 border-blue-200"
                              >
                                {route}
                              </Badge>
                            ))}
                            {preview.changes.routesToAdd.length > 10 && (
                              <Badge variant="outline" className="text-xs">
                                +{preview.changes.routesToAdd.length - 10} more
                              </Badge>
                            )}
                          </div>
                        </div>
                      )}

                      {/* Backends to recreate */}
                      {preview.changes.backendsToRecreate.length > 0 && (
                        <div className="p-3">
                          <div className="flex items-center gap-2 text-sm text-yellow-600 dark:text-yellow-400 mb-2">
                            <IconRefresh className="h-4 w-4" />
                            <span className="font-medium">
                              Recreate {preview.changes.backendsToRecreate.length} backend(s)
                            </span>
                          </div>
                          <div className="flex flex-wrap gap-1">
                            {preview.changes.backendsToRecreate.slice(0, 10).map((name) => (
                              <Badge
                                key={name}
                                variant="outline"
                                className="text-xs font-mono bg-yellow-50 dark:bg-yellow-950 border-yellow-200"
                              >
                                {name}
                              </Badge>
                            ))}
                            {preview.changes.backendsToRecreate.length > 10 && (
                              <Badge variant="outline" className="text-xs">
                                +{preview.changes.backendsToRecreate.length - 10} more
                              </Badge>
                            )}
                          </div>
                        </div>
                      )}

                      {/* No changes needed */}
                      {preview.changes.frontendsToCreate.length === 0 &&
                        preview.changes.routesToAdd.length === 0 &&
                        preview.changes.backendsToRecreate.length === 0 && (
                          <div className="p-3 text-sm text-muted-foreground text-center">
                            No changes needed - configuration is up to date
                          </div>
                        )}
                    </div>
                  </div>

                  {/* Expected State */}
                  <div className="space-y-2">
                    <h4 className="font-medium text-sm flex items-center gap-2">
                      <IconCheck className="h-4 w-4" />
                      Expected Result
                    </h4>
                    <div className="rounded-md border p-3 bg-green-50 dark:bg-green-950 border-green-200">
                      <div className="space-y-2 text-sm">
                        {preview.expectedState.sharedHttpFrontend && (
                          <div className="flex items-center gap-2">
                            <Badge variant="outline" className="bg-white dark:bg-gray-900">
                              HTTP
                            </Badge>
                            <span className="font-mono text-xs">
                              {preview.expectedState.sharedHttpFrontend}
                            </span>
                          </div>
                        )}
                        {preview.expectedState.sharedHttpsFrontend && (
                          <div className="flex items-center gap-2">
                            <Badge variant="outline" className="bg-white dark:bg-gray-900">
                              HTTPS
                            </Badge>
                            <span className="font-mono text-xs">
                              {preview.expectedState.sharedHttpsFrontend}
                            </span>
                          </div>
                        )}
                        {(preview.expectedState.manualFrontends ?? []).length > 0 && (
                          <>
                            {preview.expectedState.manualFrontends.map((mf) => (
                              <div key={mf.frontendName} className="flex items-center gap-2">
                                <Badge variant="outline" className="bg-white dark:bg-gray-900">
                                  Manual
                                </Badge>
                                <span className="font-mono text-xs">
                                  {mf.frontendName}
                                </span>
                                <span className="text-xs text-muted-foreground">
                                  {mf.containerName && `(${mf.containerName})`}
                                </span>
                              </div>
                            ))}
                          </>
                        )}
                        <div className="pt-2 border-t border-green-200 space-y-2">
                          <div>
                            <span className="text-muted-foreground">Routes:</span>{" "}
                            <span className="font-medium">
                              {preview.expectedState.routes.length}
                            </span>
                            {" • "}
                            <span className="text-muted-foreground">Backends:</span>{" "}
                            <span className="font-medium">
                              {preview.expectedState.backends.length}
                            </span>
                          </div>
                          {preview.expectedState.routes.length > 0 && (
                            <div className="flex flex-wrap gap-1">
                              {preview.expectedState.routes.slice(0, 10).map((route) => (
                                <Badge
                                  key={route.hostname}
                                  variant="outline"
                                  className="text-xs font-mono bg-white dark:bg-gray-900"
                                >
                                  {route.hostname}
                                  {route.ssl && (
                                    <IconShield className="h-3 w-3 ml-1 text-green-600 inline" />
                                  )}
                                </Badge>
                              ))}
                              {preview.expectedState.routes.length > 10 && (
                                <Badge variant="outline" className="text-xs">
                                  +{preview.expectedState.routes.length - 10} more
                                </Badge>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Remediating State */}
          {dialogState === "remediating" && (
            <div className="flex flex-col items-center justify-center py-8 space-y-4">
              <IconLoader2 className="h-12 w-12 animate-spin text-primary" />
              <div className="text-center space-y-2">
                <div className="font-medium">Rebuilding HAProxy Configuration</div>
                <div className="text-sm text-muted-foreground">
                  Please wait while the configuration is being rebuilt from database state...
                </div>
              </div>
              <Progress value={undefined} className="w-full max-w-xs" />
            </div>
          )}

          {/* Success State */}
          {dialogState === "success" && result && (
            <div className="space-y-4">
              <div className="flex items-center justify-center py-4">
                <div className="rounded-full bg-green-100 dark:bg-green-900 p-3">
                  <IconCheck className="h-8 w-8 text-green-600 dark:text-green-400" />
                </div>
              </div>

              <div className="rounded-md border p-4 space-y-3">
                <h4 className="font-medium">Rebuild Steps</h4>
                <div className="space-y-2">
                  {result.steps.map((step, i) => (
                    <div
                      key={i}
                      className={cn(
                        "flex items-start gap-3 p-2 rounded text-sm",
                        step.status === "completed" && "bg-green-50 dark:bg-green-950/50",
                        step.status === "failed" && "bg-red-50 dark:bg-red-950/50",
                        step.status === "skipped" && "bg-muted/50"
                      )}
                    >
                      <div className="mt-0.5 flex-shrink-0">
                        {step.status === "completed" && (
                          <IconCheck className="h-4 w-4 text-green-600 dark:text-green-400" />
                        )}
                        {step.status === "failed" && (
                          <IconX className="h-4 w-4 text-red-600 dark:text-red-400" />
                        )}
                        {step.status === "skipped" && (
                          <IconMinus className="h-4 w-4 text-muted-foreground" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-medium">{step.step}</div>
                        {step.detail && (
                          <div className="text-xs text-muted-foreground mt-0.5 break-words">
                            {step.detail}
                          </div>
                        )}
                      </div>
                      <Badge
                        variant="outline"
                        className={cn(
                          "text-xs flex-shrink-0",
                          step.status === "completed" && "border-green-200 text-green-700 dark:text-green-400",
                          step.status === "failed" && "border-red-200 text-red-700 dark:text-red-400",
                          step.status === "skipped" && "border-muted text-muted-foreground"
                        )}
                      >
                        {step.status}
                      </Badge>
                    </div>
                  ))}
                </div>
              </div>

              {result.errors.length > 0 && (
                <Alert className="bg-yellow-50 dark:bg-yellow-950 border-yellow-200">
                  <IconAlertTriangle className="h-4 w-4 text-yellow-600" />
                  <AlertDescription>
                    <div className="font-medium mb-1">Warnings:</div>
                    <ul className="text-sm list-disc list-inside">
                      {result.errors.map((error, i) => (
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
                  The rebuild process encountered errors. Some changes may have
                  been applied. Please check the HAProxy status and try again if
                  necessary.
                </AlertDescription>
              </Alert>

              {result && result.steps.length > 0 && (
                <div className="rounded-md border p-3 space-y-2">
                  <h4 className="font-medium mb-2 text-sm">Steps:</h4>
                  {result.steps.map((step, i) => (
                    <div
                      key={i}
                      className={cn(
                        "flex items-start gap-3 p-2 rounded text-sm",
                        step.status === "completed" && "bg-green-50 dark:bg-green-950/50",
                        step.status === "failed" && "bg-red-50 dark:bg-red-950/50",
                        step.status === "skipped" && "bg-muted/50"
                      )}
                    >
                      <div className="mt-0.5 flex-shrink-0">
                        {step.status === "completed" && (
                          <IconCheck className="h-4 w-4 text-green-600 dark:text-green-400" />
                        )}
                        {step.status === "failed" && (
                          <IconX className="h-4 w-4 text-red-600 dark:text-red-400" />
                        )}
                        {step.status === "skipped" && (
                          <IconMinus className="h-4 w-4 text-muted-foreground" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-medium">{step.step}</div>
                        {step.detail && (
                          <div className="text-xs text-muted-foreground mt-0.5 break-words">
                            {step.detail}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {result && result.errors.length > 0 && (
                <div className="rounded-md border p-3">
                  <h4 className="font-medium mb-2 text-sm">Errors:</h4>
                  <ul className="text-sm space-y-1 text-red-600 dark:text-red-400">
                    {result.errors.map((error, i) => (
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
                  <IconRefresh className="h-4 w-4 mr-2" />
                  Retry
                </Button>
              )}
              <Button
                onClick={handleRemediate}
                disabled={isLoadingPreview || isPreviewError}
                className="bg-yellow-600 hover:bg-yellow-700"
              >
                <IconRefresh className="h-4 w-4 mr-2" />
                Rebuild HAProxy
              </Button>
            </>
          )}

          {dialogState === "remediating" && (
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
