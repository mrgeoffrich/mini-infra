import { useState, useMemo } from "react";
import {
  IconLoader2,
  IconFileImport,
  IconRocket,
} from "@tabler/icons-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { cn } from "@/lib/utils";
import { useDeploymentConfigs } from "@/hooks/use-deployment-configs";
import { useImportDeploymentConfig } from "@/hooks/use-applications";
import { useEnvironments } from "@/hooks/use-environments";

interface ImportDeploymentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ImportDeploymentDialog({
  open,
  onOpenChange,
}: ImportDeploymentDialogProps) {
  const [selectedConfigId, setSelectedConfigId] = useState<string | null>(null);

  const { data: configsData, isLoading, error } = useDeploymentConfigs({
    enabled: open,
    limit: 100,
  });

  const { data: envData } = useEnvironments({ enabled: open });

  const importMutation = useImportDeploymentConfig();

  const configs = configsData?.data ?? [];

  // Build a map from environmentId to environment name
  const environmentNameById = useMemo(() => {
    const map = new Map<string, string>();
    const environments = envData?.environments ?? [];
    for (const env of environments) {
      map.set(env.id, env.name);
    }
    return map;
  }, [envData]);

  const handleImport = async () => {
    if (!selectedConfigId) return;

    try {
      await importMutation.mutateAsync(selectedConfigId);
      setSelectedConfigId(null);
      onOpenChange(false);
    } catch {
      // Error is handled by the mutation's onError callback
    }
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setSelectedConfigId(null);
    }
    onOpenChange(nextOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <IconFileImport className="h-5 w-5" />
            Import Deployment
          </DialogTitle>
          <DialogDescription>
            Select a deployment configuration to import as an application template.
          </DialogDescription>
        </DialogHeader>

        <div className="py-4">
          {isLoading && (
            <div className="space-y-2">
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </div>
          )}

          {error && (
            <Alert variant="destructive">
              <AlertDescription>
                Failed to load deployment configurations. Please try again.
              </AlertDescription>
            </Alert>
          )}

          {!isLoading && !error && configs.length === 0 && (
            <div className="text-center py-8 text-muted-foreground">
              <IconRocket className="h-10 w-10 mx-auto mb-3 opacity-50" />
              <p className="text-sm">No deployment configurations found.</p>
              <p className="text-xs mt-1">
                Create a deployment configuration first to import it as an application.
              </p>
            </div>
          )}

          {!isLoading && !error && configs.length > 0 && (
            <div className="max-h-80 overflow-y-auto space-y-1">
              {configs.map((config) => (
                <button
                  key={config.id}
                  type="button"
                  onClick={() => setSelectedConfigId(config.id)}
                  className={cn(
                    "w-full text-left px-3 py-3 rounded-md border transition-colors",
                    "hover:bg-accent hover:text-accent-foreground",
                    selectedConfigId === config.id
                      ? "border-primary bg-primary/5 ring-1 ring-primary"
                      : "border-transparent",
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm">
                      {config.applicationName}
                    </span>
                    {config.environmentId &&
                      environmentNameById.get(config.environmentId) && (
                        <Badge variant="outline" className="text-xs">
                          {environmentNameById.get(config.environmentId)}
                        </Badge>
                      )}
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {config.dockerImage}:{config.dockerTag}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleImport}
            disabled={!selectedConfigId || importMutation.isPending}
          >
            {importMutation.isPending && (
              <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />
            )}
            Import
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
