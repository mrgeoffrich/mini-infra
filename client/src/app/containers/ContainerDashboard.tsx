import React from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { useContainers, useContainerFilters } from "@/hooks/useContainers";
import { ContainerTable } from "./ContainerTable";
import { ContainerFilters } from "./ContainerFilters";
import { AlertCircle } from "lucide-react";

export function ContainerDashboard() {
  const filterState = useContainerFilters();
  const { queryParams } = filterState;

  const {
    data: containerData,
    isLoading,
    error,
    isError,
    isFetching,
    refetch,
  } = useContainers({
    queryParams,
    enabled: true,
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

  if (isError) {
    return (
      <div className="space-y-6 p-6">
        <div>
          <h1 className="text-3xl font-bold">Container Dashboard</h1>
          <p className="text-muted-foreground mt-2">
            Monitor and manage your Docker containers
          </p>
        </div>

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
    );
  }

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-3xl font-bold">Container Dashboard</h1>
        <p className="text-muted-foreground mt-2">
          Monitor and manage your Docker containers
        </p>
      </div>

      <div className="grid gap-6">
        {/* Overview Cards */}
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">
                Total Containers
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {isLoading ? (
                  <Skeleton className="h-8 w-12" />
                ) : (
                  containerData?.totalCount || 0
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Running</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-green-600">
                {isLoading ? (
                  <Skeleton className="h-8 w-12" />
                ) : (
                  containerData?.containers.filter(
                    (c) => c.status === "running",
                  ).length || 0
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Stopped</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-red-600">
                {isLoading ? (
                  <Skeleton className="h-8 w-12" />
                ) : (
                  containerData?.containers.filter((c) => c.status === "exited")
                    .length || 0
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">
                Last Updated
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-sm">
                {isLoading ? (
                  <Skeleton className="h-4 w-20" />
                ) : containerData?.lastUpdated ? (
                  new Date(containerData.lastUpdated).toLocaleTimeString()
                ) : (
                  "Never"
                )}
                {isFetching && !isLoading && (
                  <div className="text-xs text-muted-foreground mt-1">
                    Updating...
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Filters and Table */}
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

            {isLoading ? (
              <div className="space-y-2">
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
