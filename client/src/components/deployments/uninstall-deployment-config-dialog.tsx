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
import { Loader2, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import type { DeploymentConfigurationInfo } from "@mini-infra/types";

interface UninstallDeploymentConfigDialogProps {
  config: DeploymentConfigurationInfo | null;
  isOpen: boolean;
  onClose: () => void;
}

export function UninstallDeploymentConfigDialog({
  config,
  isOpen,
  onClose,
}: UninstallDeploymentConfigDialogProps) {
  const deleteMutation = useDeleteDeploymentConfig();

  const confirmDelete = async () => {
    if (!config) return;

    try {
      await deleteMutation.mutateAsync(config.id);
      toast.success(`Deployment configuration "${config.applicationName}" deleted successfully`);
      onClose();
    } catch (error) {
      toast.error(
        `Failed to delete deployment configuration: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      );
    }
  };

  if (!config) return null;

  return (
    <AlertDialog open={isOpen} onOpenChange={onClose}>
      <AlertDialogContent className="max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-destructive" />
            Delete Deployment Configuration
          </AlertDialogTitle>
          <AlertDialogDescription className="space-y-2">
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
              <li>Delete the deployment configuration permanently</li>
              <li>Remove all deployment history for this application</li>
              <li>This action cannot be undone</li>
            </ul>
            <div className="mt-3 p-2 bg-muted rounded-md text-xs">
              <strong>Note:</strong> Make sure to remove any running containers first using the "Remove Deployment" button.
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onClose}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={confirmDelete}
            disabled={deleteMutation.isPending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {deleteMutation.isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : null}
            {deleteMutation.isPending ? "Deleting..." : "Delete Configuration"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}