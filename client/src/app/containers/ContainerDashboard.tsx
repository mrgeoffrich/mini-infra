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

            {isLoading && !containerData ? (
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
