import { useState } from "react";
import { Environment } from "@mini-infra/types";
import { useDeleteEnvironment } from "@/hooks/use-environments";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { toast } from "sonner";
import { Loader2, AlertTriangle, Server, Network, HardDrive } from "lucide-react";

interface EnvironmentDeleteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environment: Environment;
  onSuccess?: () => void;
}

export function EnvironmentDeleteDialog({
  open,
  onOpenChange,
  environment,
  onSuccess,
}: EnvironmentDeleteDialogProps) {
  const [confirmationText, setConfirmationText] = useState("");
  const deleteMutation = useDeleteEnvironment();

  const isConfirmed = confirmationText === environment.name;
  const isRunning = environment.status === "running";

  const handleDelete = async () => {
    if (!isConfirmed) return;

    try {
      await deleteMutation.mutateAsync(environment.id);
      toast.success(`Environment "${environment.name}" deleted successfully`);
      onOpenChange(false);
      setConfirmationText("");
      onSuccess?.();
    } catch (error) {
      toast.error(
        `Failed to delete environment: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      );
    }
  };

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      setConfirmationText("");
    }
    onOpenChange(open);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-red-600">
            <AlertTriangle className="h-5 w-5" />
            Delete Environment
          </DialogTitle>
          <DialogDescription>
            This action cannot be undone. This will permanently delete the environment
            and all its associated resources.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Warning for running environment */}
          {isRunning && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>
                This environment is currently running. You must stop it before deletion.
              </AlertDescription>
            </Alert>
          )}

          {/* Environment Details */}
          <div className="rounded-md border p-3 space-y-2">
            <div className="font-medium">{environment.name}</div>
            {environment.description && (
              <div className="text-sm text-muted-foreground">
                {environment.description}
              </div>
            )}

            <div className="grid grid-cols-3 gap-4 text-sm pt-2">
              <div className="flex items-center gap-1">
                <Server className="h-3.5 w-3.5 text-muted-foreground" />
                <span>{environment.services.length} Services</span>
              </div>
              <div className="flex items-center gap-1">
                <Network className="h-3.5 w-3.5 text-muted-foreground" />
                <span>{environment.networks.length} Networks</span>
              </div>
              <div className="flex items-center gap-1">
                <HardDrive className="h-3.5 w-3.5 text-muted-foreground" />
                <span>{environment.volumes.length} Volumes</span>
              </div>
            </div>
          </div>

          {/* Resources that will be deleted */}
          {(environment.services.length > 0 || environment.networks.length > 0 || environment.volumes.length > 0) && (
            <Alert>
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>
                <div className="font-medium mb-2">The following resources will be deleted:</div>
                <ul className="text-sm space-y-1">
                  {environment.services.length > 0 && (
                    <li>• {environment.services.length} service(s): {environment.services.map(s => s.serviceName).join(", ")}</li>
                  )}
                  {environment.networks.length > 0 && (
                    <li>• {environment.networks.length} network(s): {environment.networks.map(n => n.name).join(", ")}</li>
                  )}
                  {environment.volumes.length > 0 && (
                    <li>• {environment.volumes.length} volume(s): {environment.volumes.map(v => v.name).join(", ")}</li>
                  )}
                </ul>
              </AlertDescription>
            </Alert>
          )}

          {/* Confirmation Input */}
          {!isRunning && (
            <div className="space-y-2">
              <Label htmlFor="confirmation">
                Type <code className="bg-muted px-1 rounded text-sm">{environment.name}</code> to confirm:
              </Label>
              <Input
                id="confirmation"
                value={confirmationText}
                onChange={(e) => setConfirmationText(e.target.value)}
                placeholder={environment.name}
                disabled={deleteMutation.isPending}
                autoComplete="off"
              />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={deleteMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={!isConfirmed || isRunning || deleteMutation.isPending}
          >
            {deleteMutation.isPending && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            Delete Environment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}