/**
 * Connect Container progress dialog.
 *
 * Opens when the user clicks "Create" in the manual frontend wizard (Step 4).
 * Shows a preview of what will be created, then fires the async setup and
 * displays real-time progress via Socket.IO.
 */

import { useState, useEffect } from "react";
import { Badge } from "@/components/ui/badge";
import { IconPlug } from "@tabler/icons-react";
import { OperationProgressDialog } from "@/components/operation-progress-dialog";
import {
  useStartConnectContainer,
  useConnectContainerProgress,
} from "@/hooks/use-connect-container";
import type { CreateManualFrontendRequest } from "@mini-infra/types";

interface ConnectContainerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  request: CreateManualFrontendRequest;
  environmentName: string;
  onSuccess?: () => void;
}

export function ConnectContainerDialog({
  open,
  onOpenChange,
  request,
  environmentName,
  onSuccess,
}: ConnectContainerDialogProps) {
  const [operationId, setOperationId] = useState<string | null>(null);
  const startMutation = useStartConnectContainer();
  const progress = useConnectContainerProgress(operationId);

  // Handle success
  useEffect(() => {
    if (progress.state.phase === "success") {
      onSuccess?.();
    }
  }, [progress.state.phase, onSuccess]);

  const handleConfirm = async () => {
    try {
      const result = await startMutation.mutateAsync(request);
      setOperationId(result.data.operationId);
    } catch {
      // Error handled by mutation's onError toast
    }
  };

  const handleClose = () => {
    setOperationId(null);
    progress.reset();
  };

  // Build the state: use progress state, but if we just fired the mutation
  // and haven't received STARTED yet, show executing with step names
  const connectStepNames: string[] = [];
  if (request.needsNetworkJoin) connectStepNames.push("Connect container to HAProxy network");
  connectStepNames.push("Validate container connectivity");
  if (request.enableSsl) {
    connectStepNames.push("Find or issue TLS certificate");
    connectStepNames.push("Deploy certificate to HAProxy");
  }
  connectStepNames.push("Create backend, frontend and route");
  const operationState =
    operationId && progress.state.phase === "idle"
      ? { ...progress.state, phase: "executing" as const, totalSteps: connectStepNames.length, plannedStepNames: connectStepNames }
      : progress.state;

  return (
    <OperationProgressDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Connect Container"
      titleIcon={<IconPlug className="h-5 w-5" />}
      operationState={operationState}
      confirmLabel="Connect Container"
      confirmDisabled={startMutation.isPending}
      onConfirm={handleConfirm}
      onClose={handleClose}
      descriptions={{
        preview: `Connect ${request.containerName} to HAProxy in ${environmentName}.`,
        executing: "Setting up container connection...",
        success: "Container connected to HAProxy successfully.",
        error: "There were errors connecting the container.",
      }}
      previewContent={
        <div className="space-y-3">
          <div className="rounded-md border divide-y">
            <PreviewRow label="Environment" value={environmentName} />
            <PreviewRow label="Container" value={request.containerName} mono />
            <PreviewRow label="Port" value={String(request.containerPort)} mono />
            <PreviewRow label="Hostname" value={request.hostname} mono />
            <PreviewRow
              label="SSL/TLS"
              value={
                request.enableSsl ? (
                  <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
                    Enabled — certificate will be auto-resolved
                  </Badge>
                ) : (
                  <Badge variant="secondary">Disabled</Badge>
                )
              }
            />
            {request.healthCheckPath && (
              <PreviewRow
                label="Health Check"
                value={request.healthCheckPath}
                mono
              />
            )}
          </div>

          <div className="rounded-md border p-3 bg-muted/30">
            <h4 className="text-sm font-medium mb-2">Steps to execute:</h4>
            <ol className="text-sm text-muted-foreground space-y-1 list-decimal list-inside">
              {request.needsNetworkJoin && (
                <li>Connect container to HAProxy network</li>
              )}
              <li>Validate container connectivity</li>
              {request.enableSsl && (
                <>
                  <li>Find or issue TLS certificate</li>
                  <li>Deploy certificate to HAProxy</li>
                </>
              )}
              <li>Create backend, frontend and route</li>
            </ol>
          </div>
        </div>
      }
    />
  );
}

function PreviewRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between p-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={mono ? "font-mono" : ""}>{value}</span>
    </div>
  );
}
