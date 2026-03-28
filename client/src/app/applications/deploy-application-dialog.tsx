import { useState } from "react";
import { IconLoader2, IconPlayerPlay } from "@tabler/icons-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useEnvironments } from "@/hooks/use-environments";
import { useDeployApplication } from "@/hooks/use-applications";
import type { StackTemplateInfo } from "@mini-infra/types";

interface DeployApplicationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  application: StackTemplateInfo | null;
}

export function DeployApplicationDialog({
  open,
  onOpenChange,
  application,
}: DeployApplicationDialogProps) {
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<string>("");

  const { data: envData, isLoading: envsLoading, error: envsError } = useEnvironments({
    enabled: open,
  });

  const deployApplication = useDeployApplication();

  const environments = envData?.environments ?? [];

  const handleDeploy = async () => {
    if (!application || !selectedEnvironmentId) return;

    try {
      await deployApplication.mutateAsync({
        templateId: application.id,
        name: application.name,
        environmentId: selectedEnvironmentId,
      });
      setSelectedEnvironmentId("");
      onOpenChange(false);
    } catch {
      // Error is handled by the mutation's onError callback
    }
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setSelectedEnvironmentId("");
    }
    onOpenChange(nextOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <IconPlayerPlay className="h-5 w-5" />
            Deploy Application
          </DialogTitle>
          <DialogDescription>
            Select an environment to deploy &quot;{application?.displayName}&quot; into.
          </DialogDescription>
        </DialogHeader>

        <div className="py-4">
          {envsLoading && (
            <Skeleton className="h-10 w-full" />
          )}

          {envsError && (
            <Alert variant="destructive">
              <AlertDescription>
                Failed to load environments. Please try again.
              </AlertDescription>
            </Alert>
          )}

          {!envsLoading && !envsError && environments.length === 0 && (
            <div className="text-center py-4 text-muted-foreground">
              <p className="text-sm">No environments available.</p>
              <p className="text-xs mt-1">
                Create an environment first before deploying an application.
              </p>
            </div>
          )}

          {!envsLoading && !envsError && environments.length > 0 && (
            <div className="space-y-2">
              <label className="text-sm font-medium">Environment</label>
              <Select
                value={selectedEnvironmentId}
                onValueChange={setSelectedEnvironmentId}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select an environment" />
                </SelectTrigger>
                <SelectContent>
                  {environments.map((env) => (
                    <SelectItem key={env.id} value={env.id}>
                      {env.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleDeploy}
            disabled={!selectedEnvironmentId || deployApplication.isPending}
          >
            {deployApplication.isPending && (
              <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />
            )}
            Deploy
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
