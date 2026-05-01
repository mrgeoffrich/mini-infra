import React from "react";
import { ColumnDef, getCoreRowModel } from "@tanstack/react-table";
import { useDataTable } from "@/lib/react-table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AzureContainerInfo, StorageProviderId } from "@mini-infra/types";
import {
  IconArrowsSort,
  IconRefresh,
  IconAlertCircle,
  IconBrandAzure,
  IconBrandGoogleDrive,
  IconDatabase,
} from "@tabler/icons-react";
import {
  useStorageLocationsList,
  useStorageObjectFilters,
  useTestStorageLocationAccess,
} from "@/hooks/use-storage-settings";
import { toast } from "sonner";
import type {
  StorageLocationListProps,
  LocationAccessTest,
} from "./types";
import { LocationNameCell, LastModifiedCell } from "./container-cells";
import { LeaseStatusCell, PublicAccessCell, MetadataCell } from "./status-badges";
import { ActionsCell } from "./actions-cell";
import { LocationFilters } from "./container-filters";
import { LocationTable } from "./container-table";
import { LocationPagination } from "./container-pagination";

interface StorageLocationListPropsWithProvider extends StorageLocationListProps {
  provider: StorageProviderId;
}

export const StorageLocationList = React.memo(function StorageLocationList({
  className,
  provider,
}: StorageLocationListPropsWithProvider) {
  const { filters, updateFilter, resetFilters } = useStorageObjectFilters({
    limit: 20,
    page: 1,
    sortBy: "name",
    sortOrder: "asc",
  });

  const [locationTests, setLocationTests] = React.useState<
    Map<string, LocationAccessTest>
  >(new Map());

  const testLocationAccess = useTestStorageLocationAccess(provider);

  const {
    data: locationsData,
    isLoading,
    error,
    refetch,
    isRefetching,
  } = useStorageLocationsList(provider, {
    enabled: true,
    refetchInterval: undefined,
  });

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

  const handleTestAccess = React.useCallback(
    async (locationId: string) => {
      setLocationTests((prev) =>
        new Map(prev).set(locationId, {
          locationId,
          status: "testing",
          lastTested: new Date(),
        }),
      );

      try {
        const result = await testLocationAccess.mutateAsync(locationId);

        const responseTimeRaw = (result.metadata as Record<string, unknown> | undefined)?.responseTimeMs;
        const responseTime =
          typeof responseTimeRaw === "number" ? responseTimeRaw : undefined;

        setLocationTests((prev) =>
          new Map(prev).set(locationId, {
            locationId,
            status: "success",
            lastTested: new Date(),
            responseTime,
          }),
        );

        toast.success(
          responseTime
            ? `Location '${locationId}' is accessible (${responseTime}ms)`
            : `Location '${locationId}' is accessible`,
        );

        setTimeout(() => {
          setLocationTests((prev) => {
            const updated = new Map(prev);
            const current = updated.get(locationId);
            if (current?.status === "success") {
              updated.set(locationId, { ...current, status: "idle" });
            }
            return updated;
          });
        }, 10000);
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : "Access test failed";

        setLocationTests((prev) =>
          new Map(prev).set(locationId, {
            locationId,
            status: "failed",
            lastTested: new Date(),
            error: errorMessage,
          }),
        );

        toast.error(`Location '${locationId}' access failed: ${errorMessage}`);

        setTimeout(() => {
          setLocationTests((prev) => {
            const updated = new Map(prev);
            const current = updated.get(locationId);
            if (current?.status === "failed") {
              updated.set(locationId, { ...current, status: "idle" });
            }
            return updated;
          });
        }, 15000);
      }
    },
    [testLocationAccess],
  );

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
            Name
            <IconArrowsSort className="ml-2 h-4 w-4" />
          </Button>
        ),
        cell: ({ row }) => <LocationNameCell name={row.getValue("name")} />,
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
            locationId={row.original.name}
            testStatus={locationTests.get(row.original.name)}
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
      locationTests,
    ],
  );

  const filteredLocations = React.useMemo(() => {
    if (!locationsData?.locations) return [];

    let filtered = [...locationsData.locations];

    if (filters.namePrefix) {
      const prefix = filters.namePrefix.toLowerCase();
      filtered = filtered.filter((loc) =>
        loc.name.toLowerCase().startsWith(prefix),
      );
    }

    if (filters.leaseStatus) {
      filtered = filtered.filter(
        (loc) => loc.leaseStatus === filters.leaseStatus,
      );
    }

    if (filters.publicAccess !== undefined) {
      filtered = filtered.filter(
        (loc) => loc.publicAccess === filters.publicAccess,
      );
    }

    if (filters.hasMetadata !== undefined) {
      filtered = filtered.filter((loc) => {
        const hasMetadata = loc.metadata && Object.keys(loc.metadata).length > 0;
        return filters.hasMetadata ? hasMetadata : !hasMetadata;
      });
    }

    if (filters.lastModifiedAfter || filters.lastModifiedBefore) {
      filtered = filtered.filter((loc) => {
        const date = new Date(loc.lastModified);
        if (filters.lastModifiedAfter && date < filters.lastModifiedAfter) {
          return false;
        }
        if (filters.lastModifiedBefore && date > filters.lastModifiedBefore) {
          return false;
        }
        return true;
      });
    }

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
  }, [locationsData?.locations, filters]);

  const totalCount = filteredLocations.length;
  const totalPages = Math.ceil(totalCount / filters.limit);
  const startIndex = (filters.page - 1) * filters.limit;
  const endIndex = Math.min(startIndex + filters.limit, totalCount);
  const paginatedLocations = filteredLocations.slice(startIndex, endIndex);

  const startItem = startIndex + 1;
  const endItem = endIndex;

  const sortingState = React.useMemo(
    () => [{ id: filters.sortBy, desc: filters.sortOrder === "desc" }],
    [filters.sortBy, filters.sortOrder],
  );

  const table = useDataTable({
    data: paginatedLocations,
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualSorting: true,
    getRowId: (row) => row.name,
    state: {
      sorting: sortingState,
    },
  });

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

  const titleIcon =
    provider === "azure" ? (
      <IconBrandAzure className="h-5 w-5" />
    ) : provider === "google-drive" ? (
      <IconBrandGoogleDrive className="h-5 w-5" />
    ) : (
      <IconDatabase className="h-5 w-5" />
    );

  if (isLoading) {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {titleIcon}
            Storage Locations
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

  if (error) {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {titleIcon}
            Storage Locations
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Alert variant="destructive">
            <IconAlertCircle className="h-4 w-4" />
            <AlertDescription>
              Failed to load locations: {error.message}
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

  if (!locationsData?.locations) {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {titleIcon}
            Storage Locations
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Alert>
            <IconAlertCircle className="h-4 w-4" />
            <AlertDescription>
              No storage configuration found. Please configure your provider
              first.
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
            {titleIcon}
            Storage Locations
            <Badge variant="secondary" className="ml-2">
              {locationsData.locationCount} total
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
            <span className="sr-only">Refresh locations</span>
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <LocationFilters
          filters={filters}
          updateFilter={updateFilter}
          resetFilters={resetFilters}
        />

        {filteredLocations.length === 0 ? (
          <div className="text-center py-12">
            <IconDatabase className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
            <h3 className="text-lg font-medium mb-2">No locations found</h3>
            <p className="text-muted-foreground">
              {locationsData.locations.length === 0
                ? "This provider account doesn't contain any storage locations yet."
                : "No locations match your current filter criteria."}
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <LocationTable
              headerGroups={table.getHeaderGroups()}
              rows={table.getRowModel().rows}
              columnCount={columns.length}
            />

            <LocationPagination
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
