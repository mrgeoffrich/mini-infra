import { useState } from "react";
import { Environment, EnvironmentDependencyItem } from "@mini-infra/types";
import { useDeleteEnvironment, useEnvironmentDeleteCheck } from "@/hooks/use-environments";
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
import { Checkbox } from "@/components/ui/checkbox";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { toast } from "sonner";
import { IconLoader2, IconAlertTriangle, IconNetwork, IconDatabase, IconStack2, IconLayoutNavbar, IconServer, IconTemplate } from "@tabler/icons-react";

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
  const [deleteVolumes, setDeleteVolumes] = useState(false);
  const [deleteNetworks, setDeleteNetworks] = useState(false);
  const deleteMutation = useDeleteEnvironment();
  const deleteCheck = useEnvironmentDeleteCheck(environment.id, { enabled: open });

  const hasBlockers = deleteCheck.data && !deleteCheck.data.canDelete;
  const isConfirmed = confirmationText === environment.name && !hasBlockers;

  const handleDelete = async () => {
    if (!isConfirmed) return;

    try {
      await deleteMutation.mutateAsync({
        id: environment.id,
        deleteVolumes,
        deleteNetworks,
      });
      toast.success(`Environment "${environment.name}" deleted successfully`);
      onOpenChange(false);
      setConfirmationText("");
      setDeleteVolumes(false);
      setDeleteNetworks(false);
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
      setDeleteVolumes(false);
      setDeleteNetworks(false);
    }
    onOpenChange(open);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-red-600">
            <IconAlertTriangle className="h-5 w-5" />
            Delete Environment
          </DialogTitle>
          <DialogDescription>
            This action cannot be undone. This will permanently delete the environment
            and all its associated resources.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Environment Details */}
          <div className="rounded-md border p-3 space-y-2">
            <div className="font-medium">{environment.name}</div>
            {environment.description && (
              <div className="text-sm text-muted-foreground">
                {environment.description}
              </div>
            )}

            <div className="grid grid-cols-2 gap-4 text-sm pt-2">
              <div className="flex items-center gap-1">
                <IconNetwork className="h-3.5 w-3.5 text-muted-foreground" />
                <span>{environment.networks.length} Networks</span>
              </div>
              <div className="flex items-center gap-1">
                <IconDatabase className="h-3.5 w-3.5 text-muted-foreground" />
                <span>{environment.volumes.length} Volumes</span>
              </div>
            </div>
          </div>

          {/* Blocking dependencies */}
          {deleteCheck.isLoading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
              <IconLoader2 className="h-4 w-4 animate-spin" />
              Checking dependencies...
            </div>
          )}

          {hasBlockers && (
            <Alert variant="destructive">
              <IconAlertTriangle className="h-4 w-4" />
              <AlertDescription>
                <div className="font-medium mb-2">Cannot delete — remove these resources first:</div>
                <div className="space-y-1.5 text-sm">
                  <DependencyList icon={IconStack2} label="Stacks" items={deleteCheck.data!.dependencies.stacks} />
                  <DependencyList icon={IconServer} label="Deployment Configs" items={deleteCheck.data!.dependencies.deploymentConfigurations} />
                  <DependencyList icon={IconLayoutNavbar} label="HAProxy Frontends" items={deleteCheck.data!.dependencies.haproxyFrontends} />
                  <DependencyList icon={IconServer} label="HAProxy Backends" items={deleteCheck.data!.dependencies.haproxyBackends} />
                  <DependencyList icon={IconTemplate} label="Stack Templates" items={deleteCheck.data!.dependencies.stackTemplates} />
                </div>
              </AlertDescription>
            </Alert>
          )}

          {/* Resources that will be deleted */}
          {!hasBlockers && (environment.networks.length > 0 || environment.volumes.length > 0) && (
            <Alert>
              <IconAlertTriangle className="h-4 w-4" />
              <AlertDescription>
                <div className="font-medium mb-2">Associated resources:</div>
                <div className="mt-1 text-sm text-muted-foreground">
                  Networks and volumes will be preserved by default unless explicitly selected below.
                </div>
              </AlertDescription>
            </Alert>
          )}

          {/* Volume and Network deletion options */}
          {!hasBlockers && (environment.networks.length > 0 || environment.volumes.length > 0) && (
            <div className="space-y-4 border rounded-lg p-4 bg-muted/30">
              <div className="font-medium text-sm">Additional Cleanup Options</div>

              {/* Network deletion option */}
              {environment.networks.length > 0 && (
                <div className="flex items-start space-x-3">
                  <Checkbox
                    id="delete-networks"
                    checked={deleteNetworks}
                    onCheckedChange={(checked) => setDeleteNetworks(checked === true)}
                  />
                  <div className="grid gap-1.5 leading-none">
                    <Label
                      htmlFor="delete-networks"
                      className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                    >
                      Also delete networks ({environment.networks.length})
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      Networks: {environment.networks.map(n => n.name).join(", ")}
                    </p>
                  </div>
                </div>
              )}

              {/* Volume deletion option */}
              {environment.volumes.length > 0 && (
                <div className="space-y-3">
                  <div className="flex items-start space-x-3">
                    <Checkbox
                      id="delete-volumes"
                      checked={deleteVolumes}
                      onCheckedChange={(checked) => setDeleteVolumes(checked === true)}
                    />
                    <div className="grid gap-1.5 leading-none">
                      <Label
                        htmlFor="delete-volumes"
                        className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                      >
                        Also delete volumes ({environment.volumes.length})
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        Volumes: {environment.volumes.map(v => v.name).join(", ")}
                      </p>
                    </div>
                  </div>

                  {/* Data loss warning for volumes */}
                  {deleteVolumes && (
                    <Alert variant="destructive">
                      <IconAlertTriangle className="h-4 w-4" />
                      <AlertDescription>
                        <div className="font-medium">⚠️ DATA LOSS WARNING</div>
                        <div className="text-sm mt-1">
                          Deleting volumes will permanently destroy all data stored in them.
                          This action cannot be undone and may result in irreversible data loss.
                        </div>
                      </AlertDescription>
                    </Alert>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Confirmation Input */}
          {!hasBlockers && (
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
            disabled={!isConfirmed || deleteMutation.isPending}
          >
            {deleteMutation.isPending && (
              <IconLoader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            Delete Environment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DependencyList({
  icon: Icon,
  label,
  items,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  items: EnvironmentDependencyItem[];
}) {
  if (items.length === 0) return null;
  return (
    <div className="flex items-start gap-1.5">
      <Icon className="h-3.5 w-3.5 mt-0.5 shrink-0" />
      <span>
        <span className="font-medium">{label}:</span>{" "}
        {items.map(i => i.name).join(", ")}
      </span>
    </div>
  );
}