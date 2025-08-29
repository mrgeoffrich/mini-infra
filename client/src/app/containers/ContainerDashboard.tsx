import React from "react";
import { Link } from "react-router-dom";
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
import { useContainers, useContainerFilters } from "@/hooks/useContainers";
import { useConnectivityStatus } from "@/hooks/use-settings";
import { ContainerTable } from "./ContainerTable";
import { ContainerFilters } from "./ContainerFilters";
import { AlertCircle, Settings } from "lucide-react";

export function ContainerDashboard() {
  const filterState = useContainerFilters();
  const { queryParams } = filterState;

  // Check Docker connectivity first
  const {
    data: connectivityData,
    isLoading: isConnectivityLoading,
  } = useConnectivityStatus({
    filters: { service: "docker" },
    limit: 1,
    refetchInterval: 10000, // Check every 10 seconds
  });

  // Get the latest Docker connectivity status
  const latestDockerStatus = connectivityData?.data?.[0];
  const isDockerConnected = latestDockerStatus?.status === "connected";
  const hasDockerError = latestDockerStatus?.status === "failed" || latestDockerStatus?.status === "error";

  const {
    data: containerData,
    isLoading,
    error,
    isError,
    isFetching,
    refetch,
  } = useContainers({
    queryParams,
    enabled: isDockerConnected !== false, // Only fetch containers if Docker is not explicitly disconnected
  });

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

  // Show Docker connectivity error if Docker is not connected
  if (hasDockerError && !isConnectivityLoading) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6">
          <h1 className="text-3xl font-bold">Container Dashboard</h1>
          <p className="text-muted-foreground mt-2">
            Monitor and manage your Docker containers
          </p>
        </div>

        <div className="px-4 lg:px-6">
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-medium">Docker service is not available</div>
                  <div className="text-sm mt-1">
                    {latestDockerStatus?.errorMessage || "Cannot connect to Docker. Please check your Docker configuration."}
                  </div>
                  {latestDockerStatus?.checkedAt && (
                    <div className="text-sm text-muted-foreground mt-1">
                      Last checked: {new Date(latestDockerStatus.checkedAt).toLocaleString()}
                    </div>
                  )}
                </div>
                <Button asChild variant="outline" size="sm">
                  <Link to="/settings/docker">
                    <Settings className="mr-2 h-4 w-4" />
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

  // Show other container fetch errors
  if (isError && !hasDockerError) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6">
          <h1 className="text-3xl font-bold">Container Dashboard</h1>
          <p className="text-muted-foreground mt-2">
            Monitor and manage your Docker containers
          </p>
        </div>

        <div className="px-4 lg:px-6">
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
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
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      <div className="px-4 lg:px-6">
        <h1 className="text-3xl font-bold">Container Dashboard</h1>
        <p className="text-muted-foreground mt-2">
          Monitor and manage your Docker containers
        </p>
      </div>

      <div className="px-4 lg:px-6">
        <Card>
          <CardHeader>
            <CardTitle>Containers</CardTitle>
            <CardDescription>
              View and filter your Docker containers. Data updates every 5
              seconds.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <ContainerFilters {...filterState} />

            {((isLoading && !containerData) || isConnectivityLoading) ? (
              <div className="space-y-2">
                {isConnectivityLoading && (
                  <div className="text-center text-sm text-muted-foreground mb-4">
                    Checking Docker connectivity...
                  </div>
                )}
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            ) : (
              <ContainerTable
                containers={containerData?.containers || []}
                totalCount={containerData?.totalCount || 0}
                isLoading={isLoading || isFetching}
                filterState={filterState}
              />
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
