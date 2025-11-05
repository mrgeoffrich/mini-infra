import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Container,
  RefreshCw,
  AlertCircle,
} from "lucide-react";
import {
  useAzureContainers,
  useAzureContainerFilters,
  useTestAzureContainerAccess,
} from "@/hooks/use-azure-settings";
import { toast } from "sonner";
import { ContainerAccessTest } from "./constants";
import { useContainerColumns } from "./hooks/use-container-columns";
import { filterAndSortContainers, paginateContainers } from "./utils/container-filters";
import { AzureContainerFilters } from "./AzureContainerFilters";
import { AzureContainerPagination } from "./AzureContainerPagination";
import { AzureContainerTable } from "./AzureContainerTable";

interface AzureContainerListProps {
  className?: string;
}

export const AzureContainerList = React.memo(function AzureContainerList({
  className,
}: AzureContainerListProps) {
  // Container filters state
  const { filters, updateFilter, resetFilters } = useAzureContainerFilters({
    limit: 20,
    page: 1,
    sortBy: "name",
    sortOrder: "asc",
  });

  // Container access test state
  const [containerTests, setContainerTests] = React.useState<
    Map<string, ContainerAccessTest>
  >(new Map());

  // Test container access mutation
  const testContainerAccess = useTestAzureContainerAccess();

  // Fetch containers data
  const {
    data: containersData,
    isLoading,
    error,
    refetch,
    isRefetching,
  } = useAzureContainers({
    enabled: true,
    refetchInterval: undefined, // Manual refresh only
  });

  // Sort handlers
  const handleNameSort = React.useCallback(
    () => updateFilter("sortBy", "name"),
    [updateFilter],
  );
  const handleLastModifiedSort = React.useCallback(
    () => updateFilter("sortBy", "lastModified"),
    [updateFilter],
  );
  const handleLeaseStatusSort = React.useCallback(
    () => updateFilter("sortBy", "leaseStatus"),
    [updateFilter],
  );

  // Handle container access testing
  const handleTestAccess = React.useCallback(
    async (containerName: string) => {
      // Set testing state
      setContainerTests((prev) =>
        new Map(prev).set(containerName, {
          containerName,
          status: "testing",
          lastTested: new Date(),
        }),
      );

      try {
        const result = await testContainerAccess.mutateAsync(containerName);

        // Update with success result
        setContainerTests((prev) =>
          new Map(prev).set(containerName, {
            containerName,
            status: "success",
            lastTested: new Date(),
            responseTime: result.data.responseTimeMs,
          }),
        );

        // Show success toast
        toast.success(
          `Container '${containerName}' is accessible (${result.data.responseTimeMs}ms)`,
        );

        // Clear result after 10 seconds
        setTimeout(() => {
          setContainerTests((prev) => {
            const updated = new Map(prev);
            const current = updated.get(containerName);
            if (current?.status === "success") {
              updated.set(containerName, { ...current, status: "idle" });
            }
            return updated;
          });
        }, 10000);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Access test failed";

        // Update with error result
        setContainerTests((prev) =>
          new Map(prev).set(containerName, {
            containerName,
            status: "failed",
            lastTested: new Date(),
            error: errorMessage,
          }),
        );

        // Show error toast
        toast.error(
          `Container '${containerName}' access failed: ${errorMessage}`,
        );

        // Clear error after 15 seconds
        setTimeout(() => {
          setContainerTests((prev) => {
            const updated = new Map(prev);
            const current = updated.get(containerName);
            if (current?.status === "failed") {
              updated.set(containerName, { ...current, status: "idle" });
            }
            return updated;
          });
        }, 15000);
      }
    },
    [testContainerAccess],
  );

  // Column definitions using custom hook
  const columns = useContainerColumns({
    onNameSort: handleNameSort,
    onLastModifiedSort: handleLastModifiedSort,
    onLeaseStatusSort: handleLeaseStatusSort,
    onTestAccess: handleTestAccess,
    containerTests,
  });

  // Filter and sort containers
  const filteredContainers = React.useMemo(() => {
    if (!containersData?.data.containers) return [];
    return filterAndSortContainers(containersData.data.containers, filters);
  }, [containersData?.data.containers, filters]);

  // Paginate containers
  const paginationData = React.useMemo(
    () => paginateContainers(filteredContainers, filters.page, filters.limit),
    [filteredContainers, filters.page, filters.limit],
  );

  // Loading state
  if (isLoading) {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Container className="h-5 w-5" />
            Azure Storage Containers
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div className="flex gap-4">
              <Skeleton className="h-10 w-64" />
              <Skeleton className="h-10 w-32" />
              <Skeleton className="h-10 w-32" />
            </div>
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  // Error state
  if (error) {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Container className="h-5 w-5" />
            Azure Storage Containers
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              Failed to load containers: {error.message}
              <Button
                variant="outline"
                size="sm"
                onClick={() => refetch()}
                className="mt-2 ml-2"
              >
                <RefreshCw className="h-4 w-4 mr-2" />
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  // No data available state
  if (!containersData?.data.containers) {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Container className="h-5 w-5" />
            Azure Storage Containers
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Alert>
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              No Azure Storage configuration found. Please configure your
              connection string first.
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Container className="h-5 w-5" />
            Azure Storage Containers
            <Badge variant="secondary" className="ml-2">
              {containersData.data.containerCount} total
            </Badge>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isRefetching}
          >
            {isRefetching ? (
              <RefreshCw className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            <span className="sr-only">Refresh containers</span>
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {/* Filters */}
        <AzureContainerFilters
          filters={filters}
          onUpdateFilter={updateFilter}
          onResetFilters={resetFilters}
        />

        {/* Container Table */}
        {filteredContainers.length === 0 ? (
          <div className="text-center py-12">
            <Container className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
            <h3 className="text-lg font-medium mb-2">No containers found</h3>
            <p className="text-muted-foreground">
              {containersData.data.containers.length === 0
                ? "This Azure Storage account doesn't contain any containers."
                : "No containers match your current filter criteria."}
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <AzureContainerTable
              containers={paginationData.containers}
              columns={columns}
              sortBy={filters.sortBy}
              sortOrder={filters.sortOrder}
            />

            {/* Pagination */}
            <AzureContainerPagination
              currentPage={filters.page}
              totalPages={paginationData.totalPages}
              totalCount={paginationData.totalCount}
              startItem={paginationData.startItem}
              endItem={paginationData.endItem}
              onPageChange={(page) => updateFilter("page", page)}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
});
