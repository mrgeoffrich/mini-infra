import { useParams, useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { LogViewer } from "@/components/containers/LogViewer";
import { ContainerStatusBadge } from "../ContainerStatusBadge";
import { useContainerActions } from "@/hooks/use-container-actions";
import { ContainerInfo } from "@mini-infra/types/containers";
import {
  IconArrowLeft,
  IconPlayerPlay,
  IconPlayerStop,
  IconRefresh,
  IconAlertCircle,
} from "@tabler/icons-react";

function generateCorrelationId(): string {
  return `container-detail-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

async function fetchContainer(containerId: string): Promise<ContainerInfo> {
  const response = await fetch(`/api/containers/${containerId}`, {
    headers: {
      "x-request-id": generateCorrelationId(),
    },
    credentials: "include",
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.message || "Failed to fetch container details");
  }

  return response.json();
}

export default function ContainerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const {
    data: container,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ["container", id],
    queryFn: () => fetchContainer(id!),
    enabled: !!id,
    refetchInterval: 5000, // Refresh every 5 seconds
    retry: 3,
  });

  const {
    startContainer,
    stopContainer,
    restartContainer,
    isStarting,
    isStopping,
    isRestarting,
    isPerformingAction,
  } = useContainerActions({
    containerId: id!,
    onSuccess: () => {
      refetch();
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-6 p-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (error || !container) {
    return (
      <div className="p-6">
        <Alert variant="destructive">
          <IconAlertCircle className="h-4 w-4" />
          <AlertDescription>
            {error instanceof Error ? error.message : "Failed to load container details"}
          </AlertDescription>
        </Alert>
        <div className="mt-4">
          <Button variant="outline" onClick={() => navigate("/containers")}>
            <IconArrowLeft className="mr-2 h-4 w-4" />
            Back to Containers
          </Button>
        </div>
      </div>
    );
  }

  const isRunning = container.status === "running";
  const isStopped = container.status === "stopped" || container.status === "exited";

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="sm" onClick={() => navigate("/containers")}>
            <IconArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="text-3xl font-bold">{container.name}</h1>
            <p className="text-sm text-muted-foreground mt-1">Container ID: {container.id}</p>
          </div>
          <ContainerStatusBadge status={container.status} />
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={startContainer}
            disabled={isRunning || isPerformingAction}
            className="gap-2"
          >
            <IconPlayerPlay className="h-4 w-4" />
            {isStarting ? "Starting..." : "Start"}
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={stopContainer}
            disabled={isStopped || isPerformingAction}
            className="gap-2"
          >
            <IconPlayerStop className="h-4 w-4" />
            {isStopping ? "Stopping..." : "Stop"}
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={restartContainer}
            disabled={isPerformingAction}
            className="gap-2"
          >
            <IconRefresh className="h-4 w-4" />
            {isRestarting ? "Restarting..." : "Restart"}
          </Button>
        </div>
      </div>

      {/* Container Info Card */}
      <Card>
        <CardContent className="grid grid-cols-2 gap-6">
          <div>
            <dl className="space-y-2">
              <div className="flex justify-between">
                <dt className="text-sm text-muted-foreground">Image:</dt>
                <dd className="text-sm font-mono">
                  {container.image}:{container.imageTag}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-sm text-muted-foreground">IP Address:</dt>
                <dd className="text-sm font-mono">{container.ipAddress || "N/A"}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-sm text-muted-foreground">Created:</dt>
                <dd className="text-sm">
                  {new Date(container.createdAt).toLocaleString()}
                </dd>
              </div>
              {container.startedAt && (
                <div className="flex justify-between">
                  <dt className="text-sm text-muted-foreground">Started:</dt>
                  <dd className="text-sm">
                    {new Date(container.startedAt).toLocaleString()}
                  </dd>
                </div>
              )}
            </dl>
          </div>

          <div>
            <dl className="space-y-2">
              <div>
                <dt className="text-sm text-muted-foreground mb-1">Ports:</dt>
                <dd className="flex flex-wrap gap-1">
                  {container.ports.length > 0 ? (
                    container.ports.map((port, index) => (
                      <Badge key={index} variant="outline" className="text-xs">
                        {port.public ? `${port.public}:${port.private}` : port.private}/{port.type}
                      </Badge>
                    ))
                  ) : (
                    <span className="text-sm text-muted-foreground">No ports exposed</span>
                  )}
                </dd>
              </div>

              {container.environmentInfo && (
                <div>
                  <dt className="text-sm text-muted-foreground mb-1">Environment:</dt>
                  <dd>
                    <Badge variant="secondary">
                      {container.environmentInfo.name} ({container.environmentInfo.type})
                    </Badge>
                  </dd>
                </div>
              )}

              {container.deploymentInfo && (
                <div>
                  <dt className="text-sm text-muted-foreground mb-1">Deployment:</dt>
                  <dd className="text-sm">
                    {container.deploymentInfo.applicationName} -{" "}
                    <Badge variant="outline" className="text-xs">
                      {container.deploymentInfo.containerRole}
                    </Badge>
                  </dd>
                </div>
              )}
            </dl>
          </div>
        </CardContent>
      </Card>

      {/* Volumes Card */}
      {container.volumes.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Volumes</CardTitle>
            <CardDescription>Mounted volumes for this container</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {container.volumes.map((volume, index) => (
                <div
                  key={index}
                  className="flex items-center justify-between p-3 rounded-lg border"
                >
                  <div className="flex-1 mr-4">
                    <div className="font-mono text-sm">{volume.source}</div>
                    <div className="text-xs text-muted-foreground mt-1">→ {volume.destination}</div>
                  </div>
                  <Badge variant="outline" className="text-xs">
                    {volume.mode === "rw" ? "Read/Write" : "Read Only"}
                  </Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Log Viewer */}
      <div className="h-[600px]">
        <LogViewer containerId={container.id} containerName={container.name} />
      </div>
    </div>
  );
}
