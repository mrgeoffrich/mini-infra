import React from "react";
import { Link } from "react-router-dom";
import { useFormattedDate } from "@/hooks/use-formatted-date";
import { useQuery } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { useContainers } from "@/hooks/useContainers";
import { useConnectivityStatus } from "@/hooks/use-settings";
import { useSocket } from "@/hooks/use-socket";
import { ContainerTable } from "./ContainerTable";
import {
  IconAlertCircle,
  IconSettings,
  IconBrandDocker,
} from "@tabler/icons-react";

interface ContainerGroup {
  environmentId: string | null;
  environmentName: string;
  environmentType?: string;
  containers: any[];
}

export function ContainerDashboard() {
  const { formatDateTime } = useFormattedDate();
  const { connected } = useSocket();

  // Check Docker connectivity first
  const { data: connectivityData, isLoading: isConnectivityLoading } =
    useConnectivityStatus({
      filters: { service: "docker" },
      limit: 1,
    });

  // Get the latest Docker connectivity status
  const latestDockerStatus = connectivityData?.data?.[0];
  const isDockerConnected = latestDockerStatus?.status === "connected";
  const hasDockerError =
    latestDockerStatus?.status === "failed" ||
    latestDockerStatus?.status === "error";

  const {
    data: containerData,
    isLoading,
    error,
    isError,
    isFetching,
    refetch,
  } = useContainers({
    enabled: isDockerConnected === true, // Only fetch when explicitly connected
  });

  // Fetch PostgreSQL containers
  const { data: postgresContainersData } = useQuery({
    queryKey: ["postgres-containers"],
    queryFn: async () => {
      const response = await fetch("/api/containers/postgres", {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Failed to fetch PostgreSQL containers");
      const data = await response.json();
      return data.data || [];
    },
    enabled: isDockerConnected === true,
    refetchInterval: connected ? false : 5000,
  });

  // Fetch managed container IDs mapping (container ID -> server ID)
  const { data: managedContainerMapData } = useQuery({
    queryKey: ["managed-container-ids"],
    queryFn: async () => {
      const response = await fetch("/api/containers/managed-ids", {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Failed to fetch managed container IDs");
      const data = await response.json();
      return data.data || {};
    },
    enabled: isDockerConnected === true,
    refetchInterval: connected ? false : 5000,
  });

  const postgresContainerIds = React.useMemo(
    () => new Set<string>((postgresContainersData || []).map((c: any) => c.id)),
    [postgresContainersData]
  );
  // Extract container IDs from the mapping
  const managedContainerMap = React.useMemo(
    () => managedContainerMapData || {},
    [managedContainerMapData]
  );
  const managedContainerIds = React.useMemo(
    () => new Set<string>(Object.keys(managedContainerMap)),
    [managedContainerMap]
  );

  // Group containers by environment
  const containerGroups = React.useMemo((): ContainerGroup[] => {
    if (!containerData?.containers) return [];

    const envGroups = new Map<string, ContainerGroup>();
    const hostStackGroups = new Map<string, ContainerGroup>();
    const selfContainers: any[] = [];
    const managedPostgresContainers: any[] = [];
    const unmanagedContainers: any[] = [];

    containerData.containers.forEach((container) => {
      const stackName = container.labels["mini-infra.stack"];

      // Check if this is a Mini Infra container (main or sidecar)
      if (container.selfRole) {
        selfContainers.push(container);
      } else if (managedContainerIds.has(container.id)) {
        managedPostgresContainers.push(container);
      } else if (container.environmentInfo) {
        const envId = container.environmentInfo.id;
        if (!envGroups.has(envId)) {
          envGroups.set(envId, {
            environmentId: envId,
            environmentName: container.environmentInfo.name,
            environmentType: container.environmentInfo.type,
            containers: [],
          });
        }
        envGroups.get(envId)!.containers.push(container);
      } else if (stackName) {
        // Host-scoped stack containers (e.g. monitoring) — group by stack name
        if (!hostStackGroups.has(stackName)) {
          const displayName = stackName
            .replace(/-/g, " ")
            .replace(/\b\w/g, (c) => c.toUpperCase());
          hostStackGroups.set(stackName, {
            environmentId: `stack-${stackName}`,
            environmentName: displayName,
            containers: [],
          });
        }
        hostStackGroups.get(stackName)!.containers.push(container);
      } else {
        unmanagedContainers.push(container);
      }
    });

    const result: ContainerGroup[] = [];

    // Add Mini Infra group first if there are any
    if (selfContainers.length > 0) {
      result.push({
        environmentId: "mini-infra",
        environmentName: "Mini Infra",
        containers: selfContainers,
      });
    }

    // Add host-scoped stack groups (e.g. Monitoring)
    result.push(...Array.from(hostStackGroups.values()));

    // Add managed Postgres servers group if there are any
    if (managedPostgresContainers.length > 0) {
      result.push({
        environmentId: "managed-postgres",
        environmentName: "Managed Postgres Servers",
        containers: managedPostgresContainers,
      });
    }

    // Add environment groups
    result.push(...Array.from(envGroups.values()));

    // Add unmanaged containers group if there are any
    if (unmanagedContainers.length > 0) {
      result.push({
        environmentId: null,
        environmentName: "Unmanaged",
        containers: unmanagedContainers,
      });
    }

    return result;
  }, [containerData, managedContainerIds]);

  // Log business event when container list is viewed
  React.useEffect(() => {
    if (containerData && containerData.containers.length > 0) {
      console.log("Business Event: container_list_viewed", {
        count: containerData.containers.length,
        totalCount: containerData.totalCount,
        page: containerData.page || 1,
        lastUpdated: containerData.lastUpdated,
      });
    }
  }, [containerData]);

  const handleRetry = () => {
    refetch();
  };

  // Show loading state while checking connectivity
  if (isConnectivityLoading) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6">
          <div className="flex items-center gap-3">
            <Skeleton className="h-12 w-12 rounded-md" />
            <div className="space-y-2">
              <Skeleton className="h-8 w-64" />
              <Skeleton className="h-4 w-96" />
            </div>
          </div>
        </div>

        <div className="px-4 lg:px-6">
          <Skeleton className="h-[400px] w-full" />
        </div>
      </div>
    );
  }

  // Show Docker connectivity error if Docker is not connected
  if (hasDockerError) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6">
          <div className="flex items-center gap-3">
            <div className="p-3 rounded-md bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300">
              <IconBrandDocker className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-3xl font-bold">Containers</h1>
              <p className="text-muted-foreground">
                Monitor and manage your Docker containers
              </p>
            </div>
          </div>

          <Alert variant="destructive">
            <IconAlertCircle className="h-4 w-4" />
            <AlertDescription>
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-medium">
                    Docker service is not available
                  </div>
                  <div className="text-sm mt-1">
                    {latestDockerStatus?.errorMessage ||
                      "Cannot connect to Docker. Please check your Docker configuration."}
                  </div>
                  {latestDockerStatus?.checkedAt && (
                    <div className="text-sm text-muted-foreground mt-1">
                      Last checked:{" "}
                      {formatDateTime(latestDockerStatus.checkedAt)}
                    </div>
                  )}
                </div>
                <Button asChild variant="outline" size="sm">
                  <Link to="/connectivity-docker">
                    <IconSettings className="mr-2 h-4 w-4" />
                    Configure
                  </Link>
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        </div>
      </div>
    );
  }

  // If Docker connectivity is unknown (no data yet), show basic page without containers
  if (!isDockerConnected) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6">
          <div className="flex items-center gap-3">
            <div className="p-3 rounded-md bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300">
              <IconBrandDocker className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-3xl font-bold">Container Dashboard</h1>
              <p className="text-muted-foreground">
                Monitor and manage your Docker containers
              </p>
            </div>
          </div>
        </div>

        <div className="px-4 lg:px-6">
          <Card>
            <CardHeader>
              <CardTitle>Containers</CardTitle>
              <CardDescription>
                Docker connectivity status unknown. Please check your Docker
                configuration.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-center py-8">
                <Button asChild variant="outline">
                  <Link to="/connectivity-docker">
                    <IconSettings className="mr-2 h-4 w-4" />
                    Configure Docker
                  </Link>
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  // Docker is connected - show container fetch errors if any
  if (isError) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6">
          <div className="flex items-center gap-3">
            <div className="p-3 rounded-md bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300">
              <IconBrandDocker className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-3xl font-bold">Container Dashboard</h1>
              <p className="text-muted-foreground">
                Monitor and manage your Docker containers
              </p>
            </div>
          </div>

          <Alert variant="destructive">
            <IconAlertCircle className="h-4 w-4" />
            <AlertDescription>
              Failed to load container data. {error?.message}
              <button
                onClick={handleRetry}
                className="ml-2 underline hover:no-underline"
              >
                Try again
              </button>
            </AlertDescription>
          </Alert>
        </div>
      </div>
    );
  }

  return (
    <div data-tour="containers-table">
      <Card>
          <CardContent className="space-y-4 pt-6">

            {isLoading && !containerData ? (
              <div className="space-y-2">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            ) : containerGroups.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                No containers found
              </div>
            ) : (
              <div className="space-y-6">
                {containerGroups.map((group) => (
                  <div
                    key={group.environmentId || "unmanaged"}
                    className="space-y-3"
                  >
                    <div className="flex items-center gap-2">
                      <h3 className="text-lg font-semibold">
                        {group.environmentName}
                      </h3>
                      {group.environmentType && (
                        <span
                          className={`text-xs px-2 py-1 rounded-full ${
                            group.environmentType === "production"
                              ? "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300"
                              : "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300"
                          }`}
                        >
                          {group.environmentType}
                        </span>
                      )}
                      <span className="text-sm text-muted-foreground">
                        ({group.containers.length}{" "}
                        {group.containers.length === 1
                          ? "container"
                          : "containers"}
                        )
                      </span>
                    </div>
                    <ContainerTable
                      containers={group.containers}
                      isLoading={isLoading || isFetching}
                      postgresContainerIds={postgresContainerIds}
                      managedContainerIds={managedContainerIds}
                      managedContainerMap={managedContainerMap}
                    />
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
    </div>
  );
}
