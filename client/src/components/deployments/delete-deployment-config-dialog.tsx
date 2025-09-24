import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useDeleteDeploymentConfig } from "@/hooks/use-deployment-configs";
import {
  useRemovalStatus,
  getRemovalStatusText,
  getRemovalStatusColor,
  isTerminalRemovalStatus,
} from "@/hooks/use-removal-status";
import { IconLoader2, IconAlertTriangle, IconCheck, IconX } from "@tabler/icons-react";
import { toast } from "sonner";
import { useState } from "react";
import type { DeploymentConfigurationInfo } from "@mini-infra/types";

interface DeleteDeploymentConfigDialogProps {
  config: DeploymentConfigurationInfo | null;
  isOpen: boolean;
  onClose: () => void;
}

export function DeleteDeploymentConfigDialog({
  config,
  isOpen,
  onClose,
}: DeleteDeploymentConfigDialogProps) {
  const deleteMutation = useDeleteDeploymentConfig();
  const [removalId, setRemovalId] = useState<string | null>(null);

  // Track removal progress if removal is in progress
  const removalQuery = useRemovalStatus(removalId || "", {
    enabled: !!removalId,
    stopPollingOnTerminal: true,
  });

  const confirmDelete = async () => {
    if (!config) return;

    try {
      const response = await deleteMutation.mutateAsync(config.id);
      setRemovalId(response.data.removalId);
      toast.success(`Deployment removal initiated for "${config.applicationName}"`);
    } catch (error) {
      toast.error(
        `Failed to delete deployment configuration: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      );
      onClose();
    }
  };

  const handleClose = () => {
    // Handle cleanup and completion
    if (removalQuery.data?.data.status === "completed") {
      toast.success(`Deployment configuration "${config?.applicationName}" deleted successfully`);
    } else if (removalQuery.data?.data.status === "failed") {
      toast.error(`Deployment removal failed: ${removalQuery.data.data.errorMessage || "Unknown error"}`);
    }

    setRemovalId(null);
    onClose();
  };

  if (!config) return null;

  const isRemovalInProgress = !!removalId && removalQuery.data?.data && !isTerminalRemovalStatus(removalQuery.data.data.status);
  const removalCompleted = removalQuery.data?.data.status === "completed";
  const removalFailed = removalQuery.data?.data.status === "failed";

  return (
    <AlertDialog open={isOpen} onOpenChange={handleClose}>
      <AlertDialogContent className="max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            {isRemovalInProgress ? (
              <IconLoader2 className="h-5 w-5 animate-spin text-blue-600" />
            ) : removalCompleted ? (
              <IconCheck className="h-5 w-5 text-green-600" />
            ) : removalFailed ? (
              <IconX className="h-5 w-5 text-red-600" />
            ) : (
              <IconAlertTriangle className="h-5 w-5 text-destructive" />
            )}
            {isRemovalInProgress
              ? "Removing Deployment"
              : removalCompleted
              ? "Removal Complete"
              : removalFailed
              ? "Removal Failed"
              : "Delete Deployment Configuration"}
          </AlertDialogTitle>
          <AlertDialogDescription className="space-y-2">
            {!removalId ? (
              // Initial confirmation
              <>
                <p>
                  Are you sure you want to delete the deployment configuration for{" "}
                  <span className="font-mono font-semibold text-foreground">
                    {config.applicationName}
                  </span>
                  ?
                </p>
                <p className="text-xs text-muted-foreground">
                  <strong>This action will:</strong>
                </p>
                <ul className="text-xs text-muted-foreground list-disc list-inside space-y-1 pl-2">
                  <li>Remove containers from the load balancer</li>
                  <li>Stop and remove any running containers</li>
                  <li>Delete the deployment configuration permanently</li>
                  <li>Remove all deployment history for this application</li>
                  <li>This action cannot be undone</li>
                </ul>
              </>
            ) : (
              // Progress tracking
              <div className="space-y-3">
                <p>
                  Removing deployment configuration for{" "}
                  <span className="font-mono font-semibold text-foreground">
                    {config.applicationName}
                  </span>
                </p>

                {removalQuery.data?.data && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-sm">
                      <span>Progress</span>
                      <span>{removalQuery.data.data.progress}%</span>
                    </div>
                    <div className="w-full bg-gray-200 rounded-full h-2">
                      <div
                        className="bg-blue-600 h-2 rounded-full transition-all duration-300"
                        style={{ width: `${removalQuery.data.data.progress}%` }}
                      />
                    </div>

                    <div className="text-sm space-y-1">
                      <div className={`flex items-center gap-2 ${getRemovalStatusColor(removalQuery.data.data.status)}`}>
                        {isRemovalInProgress ? (
                          <IconLoader2 className="h-4 w-4 animate-spin" />
                        ) : removalCompleted ? (
                          <IconCheck className="h-4 w-4" />
                        ) : removalFailed ? (
                          <IconX className="h-4 w-4" />
                        ) : null}
                        <span>{getRemovalStatusText(removalQuery.data.data.status)}</span>
                      </div>

                      {removalQuery.data.data.steps && removalQuery.data.data.steps.length > 0 && (
                        <div className="pl-6 space-y-1 text-xs text-muted-foreground">
                          {removalQuery.data.data.steps.map((step) => (
                            <div key={step.id} className="flex items-center gap-2">
                              {step.status === "completed" ? (
                                <IconCheck className="h-3 w-3 text-green-600" />
                              ) : step.status === "failed" ? (
                                <IconX className="h-3 w-3 text-red-600" />
                              ) : step.status === "running" ? (
                                <IconLoader2 className="h-3 w-3 animate-spin text-blue-600" />
                              ) : (
                                <div className="h-3 w-3 rounded-full border border-gray-300" />
                              )}
                              <span>{step.stepName}</span>
                            </div>
                          ))}
                        </div>
                      )}

                      {removalFailed && removalQuery.data.data.errorMessage && (
                        <div className="text-xs text-red-600 mt-2">
                          Error: {removalQuery.data.data.errorMessage}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          {!removalId ? (
            // Initial confirmation buttons
            <>
              <AlertDialogCancel onClick={handleClose}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={confirmDelete}
                disabled={deleteMutation.isPending}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {deleteMutation.isPending ? (
                  <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : null}
                {deleteMutation.isPending ? "Starting Removal..." : "Delete Configuration"}
              </AlertDialogAction>
            </>
          ) : (
            // Progress/completion buttons
            <>
              {(removalCompleted || removalFailed) ? (
                <AlertDialogAction onClick={handleClose}>
                  Close
                </AlertDialogAction>
              ) : (
                <AlertDialogCancel onClick={handleClose} disabled={isRemovalInProgress}>
                  {isRemovalInProgress ? "Removing..." : "Close"}
                </AlertDialogCancel>
              )}
            </>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}