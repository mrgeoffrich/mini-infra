import React from "react";
import { ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AzureContainerInfo } from "@mini-infra/types";
import {
  IconArrowsSort,
  IconRefresh,
  IconAlertCircle,
  IconBrandDocker,
} from "@tabler/icons-react";
import {
  useAzureContainers,
  useAzureContainerFilters,
  useTestAzureContainerAccess,
} from "@/hooks/use-azure-settings";
import { toast } from "sonner";
import type { AzureContainerListProps, ContainerAccessTest } from "./types";
import { ContainerNameCell, LastModifiedCell } from "./container-cells";
import { LeaseStatusCell, PublicAccessCell, MetadataCell } from "./status-badges";
import { ActionsCell } from "./actions-cell";
import { ContainerFilters } from "./container-filters";
import { ContainerTable } from "./container-table";
import { ContainerPagination } from "./container-pagination";

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

  // Column definitions
  const columns: ColumnDef<AzureContainerInfo>[] = React.useMemo(
    () => [
      {
        accessorKey: "name",
        header: () => (
          <Button
            variant="ghost"
            onClick={handleNameSort}
            className="h-auto p-0 font-medium"
          >
            Container Name
            <IconArrowsSort className="ml-2 h-4 w-4" />
          </Button>
        ),
        cell: ({ row }) => <ContainerNameCell name={row.getValue("name")} />,
      },
      {
        accessorKey: "lastModified",
        header: () => (
          <Button
            variant="ghost"
            onClick={handleLastModifiedSort}
            className="h-auto p-0 font-medium"
          >
            Last Modified
            <IconArrowsSort className="ml-2 h-4 w-4" />
          </Button>
        ),
        cell: ({ row }) => (
          <LastModifiedCell lastModified={row.getValue("lastModified")} />
        ),
      },
      {
        accessorKey: "leaseStatus",
        header: () => (
          <Button
            variant="ghost"
            onClick={handleLeaseStatusSort}
            className="h-auto p-0 font-medium"
          >
            Lease Status
            <IconArrowsSort className="ml-2 h-4 w-4" />
          </Button>
        ),
        cell: ({ row }) => (
          <LeaseStatusCell leaseStatus={row.getValue("leaseStatus")} />
        ),
      },
      {
        accessorKey: "publicAccess",
        header: "Access Level",
        cell: ({ row }) => (
          <PublicAccessCell publicAccess={row.getValue("publicAccess")} />
        ),
      },
      {
        accessorKey: "metadata",
        header: "Metadata",
        cell: ({ row }) => <MetadataCell metadata={row.getValue("metadata")} />,
      },
      {
        id: "actions",
        header: "Actions",
        cell: ({ row }) => (
          <ActionsCell
            containerName={row.original.name}
            testStatus={containerTests.get(row.original.name)}
            onTestAccess={handleTestAccess}
          />
        ),
      },
    ],
    [
      handleNameSort,
      handleLastModifiedSort,
      handleLeaseStatusSort,
      handleTestAccess,
      containerTests,
    ],
  );

  // Filter containers based on current filters
  const filteredContainers = React.useMemo(() => {
    if (!containersData?.data.containers) return [];

    let filtered = [...containersData.data.containers];

    // Apply name prefix filter
    if (filters.namePrefix) {
      const prefix = filters.namePrefix.toLowerCase();
      filtered = filtered.filter((container) =>
        container.name.toLowerCase().startsWith(prefix),
      );
    }

    // Apply lease status filter
    if (filters.leaseStatus) {
      filtered = filtered.filter(
        (container) => container.leaseStatus === filters.leaseStatus,
      );
    }

    // Apply public access filter
    if (filters.publicAccess !== undefined) {
      filtered = filtered.filter(
        (container) => container.publicAccess === filters.publicAccess,
      );
    }

    // Apply metadata filter
    if (filters.hasMetadata !== undefined) {
      filtered = filtered.filter((container) => {
        const hasMetadata =
          container.metadata && Object.keys(container.metadata).length > 0;
        return filters.hasMetadata ? hasMetadata : !hasMetadata;
      });
    }

    // Apply date range filters
    if (filters.lastModifiedAfter || filters.lastModifiedBefore) {
      filtered = filtered.filter((container) => {
        const containerDate = new Date(container.lastModified);
        if (
          filters.lastModifiedAfter &&
          containerDate < filters.lastModifiedAfter
        ) {
          return false;
        }
        if (
          filters.lastModifiedBefore &&
          containerDate > filters.lastModifiedBefore
        ) {
          return false;
        }
        return true;
      });
    }

    // Apply sorting
    filtered.sort((a, b) => {
      let aValue: string | Date;
      let bValue: string | Date;

      switch (filters.sortBy) {
        case "name":
          aValue = a.name;
          bValue = b.name;
          break;
        case "lastModified":
          aValue = new Date(a.lastModified);
          bValue = new Date(b.lastModified);
          break;
        case "leaseStatus":
          aValue = a.leaseStatus;
          bValue = b.leaseStatus;
          break;
        default:
          aValue = a.name;
          bValue = b.name;
      }

      if (aValue < bValue) return filters.sortOrder === "asc" ? -1 : 1;
      if (aValue > bValue) return filters.sortOrder === "asc" ? 1 : -1;
      return 0;
    });

    return filtered;
  }, [containersData?.data.containers, filters]);

  // Pagination logic
  const totalCount = filteredContainers.length;
  const totalPages = Math.ceil(totalCount / filters.limit);
  const startIndex = (filters.page - 1) * filters.limit;
  const endIndex = Math.min(startIndex + filters.limit, totalCount);
  const paginatedContainers = filteredContainers.slice(startIndex, endIndex);

  const startItem = startIndex + 1;
  const endItem = endIndex;

  // React Table setup
  const sortingState = React.useMemo(
    () => [{ id: filters.sortBy, desc: filters.sortOrder === "desc" }],
    [filters.sortBy, filters.sortOrder],
  );

  const table = useReactTable({
    data: paginatedContainers,
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualSorting: true,
    getRowId: (row) => row.name,
    state: {
      sorting: sortingState,
    },
  });

  // Navigation handlers
  const handlePrevPage = React.useCallback(
    () => updateFilter("page", filters.page - 1),
    [updateFilter, filters.page],
  );
  const handleNextPage = React.useCallback(
    () => updateFilter("page", filters.page + 1),
    [updateFilter, filters.page],
  );
  const handlePageChange = React.useCallback(
    (page: number) => updateFilter("page", page),
    [updateFilter],
  );

  // Loading state
  if (isLoading) {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <IconBrandDocker className="h-5 w-5" />
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
            <IconBrandDocker className="h-5 w-5" />
            Azure Storage Containers
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Alert variant="destructive">
            <IconAlertCircle className="h-4 w-4" />
            <AlertDescription>
              Failed to load containers: {error.message}
              <Button
                variant="outline"
                size="sm"
                onClick={() => refetch()}
                className="mt-2 ml-2"
              >
                <IconRefresh className="h-4 w-4 mr-2" />
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
            <IconBrandDocker className="h-5 w-5" />
            Azure Storage Containers
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Alert>
            <IconAlertCircle className="h-4 w-4" />
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
            <IconBrandDocker className="h-5 w-5" />
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
              <IconRefresh className="h-4 w-4 animate-spin" />
            ) : (
              <IconRefresh className="h-4 w-4" />
            )}
            <span className="sr-only">Refresh containers</span>
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ContainerFilters
          filters={filters}
          updateFilter={updateFilter}
          resetFilters={resetFilters}
        />

        {filteredContainers.length === 0 ? (
          <div className="text-center py-12">
            <IconBrandDocker className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
            <h3 className="text-lg font-medium mb-2">No containers found</h3>
            <p className="text-muted-foreground">
              {containersData.data.containers.length === 0
                ? "This Azure Storage account doesn't contain any containers."
                : "No containers match your current filter criteria."}
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <ContainerTable
              headerGroups={table.getHeaderGroups()}
              rows={table.getRowModel().rows}
              columnCount={columns.length}
            />

            <ContainerPagination
              currentPage={filters.page}
              totalPages={totalPages}
              totalCount={totalCount}
              startItem={startItem}
              endItem={endItem}
              onPageChange={handlePageChange}
              onPrevPage={handlePrevPage}
              onNextPage={handleNextPage}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
});
