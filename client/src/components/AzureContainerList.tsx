import React from "react";
import {
  ColumnDef,
  flexRender,
  getCoreRowModel,
  useReactTable,
  Cell,
} from "@tanstack/react-table";
import { format } from "date-fns";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AzureContainerInfo } from "@mini-infra/types";
import {
  IconArrowsSort,
  IconChevronLeft,
  IconChevronRight,
  IconSearch,
  IconRefresh,
  IconDatabase,
  IconLock,
  IconLockOpen,
  IconWorld,
  IconShield,
  IconAlertCircle,
  IconBrandDocker,
  IconCalendar,
  IconCloudQuestion,
  IconLoader2,
  IconCircleCheck,
  IconCircleX,
} from "@tabler/icons-react";
import {
  useAzureContainers,
  useAzureContainerFilters,
  useTestAzureContainerAccess,
} from "@/hooks/use-azure-settings";
import { toast } from "sonner";

interface AzureContainerListProps {
  className?: string;
}

// Status badge variants
const LEASE_STATUS_VARIANTS = {
  locked: {
    variant: "destructive" as const,
    icon: IconLock,
    color: "text-red-600",
    label: "Locked",
  },
  unlocked: {
    variant: "default" as const,
    icon: IconLockOpen,
    color: "text-green-600",
    label: "Unlocked",
  },
} as const;

const PUBLIC_ACCESS_VARIANTS = {
  container: {
    variant: "secondary" as const,
    icon: IconWorld,
    color: "text-blue-600",
    label: "Container",
  },
  blob: {
    variant: "outline" as const,
    icon: IconWorld,
    color: "text-amber-600",
    label: "Blob",
  },
  null: {
    variant: "outline" as const,
    icon: IconShield,
    color: "text-gray-600",
    label: "Private",
  },
} as const;

// Copy button component
const CopyButton = React.memo(
  ({
    text,
    className = "h-6 w-6 p-0",
  }: {
    text: string;
    className?: string;
  }) => {
    const handleCopy = React.useCallback(async () => {
      try {
        await navigator.clipboard.writeText(text);
      } catch (err) {
        console.error("Failed to copy text: ", err);
      }
    }, [text]);

    return (
      <Button
        variant="ghost"
        size="sm"
        onClick={handleCopy}
        className={className}
        title={`Copy ${text}`}
      >
        <span className="sr-only">Copy {text}</span>
      </Button>
    );
  },
  (prevProps, nextProps) =>
    prevProps.text === nextProps.text &&
    prevProps.className === nextProps.className,
);

CopyButton.displayName = "CopyButton";

// Container name cell with copy functionality
const ContainerNameCell = React.memo(
  ({ name }: { name: string }) => (
    <div className="flex items-center gap-2 min-h-[2rem]">
      <IconBrandDocker className="h-4 w-4 text-blue-600 shrink-0" />
      <span className="font-medium truncate flex-1">{name}</span>
      <CopyButton text={name} />
    </div>
  ),
  (prevProps, nextProps) => prevProps.name === nextProps.name,
);

ContainerNameCell.displayName = "ContainerNameCell";

// Last modified date cell
const LastModifiedCell = React.memo(
  ({ lastModified }: { lastModified: string }) => {
    const date = React.useMemo(() => new Date(lastModified), [lastModified]);
    const formattedDate = React.useMemo(
      () => format(date, "MMM d, yyyy"),
      [date],
    );
    const formattedTime = React.useMemo(() => format(date, "HH:mm:ss"), [date]);

    return (
      <div className="text-sm min-h-[2rem] flex flex-col justify-center">
        <div className="flex items-center gap-1">
          <IconCalendar className="h-3 w-3 text-muted-foreground" />
          <span>{formattedDate}</span>
        </div>
        <div className="text-muted-foreground text-xs">{formattedTime}</div>
      </div>
    );
  },
  (prevProps, nextProps) => prevProps.lastModified === nextProps.lastModified,
);

LastModifiedCell.displayName = "LastModifiedCell";

// Lease status cell with badge
const LeaseStatusCell = React.memo(
  ({ leaseStatus }: { leaseStatus: "locked" | "unlocked" }) => {
    const statusConfig = LEASE_STATUS_VARIANTS[leaseStatus];
    const StatusIcon = statusConfig.icon;

    return (
      <div className="flex items-center gap-2 min-h-[2rem]">
        <StatusIcon className={`h-4 w-4 ${statusConfig.color}`} />
        <Badge variant={statusConfig.variant} className="font-medium">
          {statusConfig.label}
        </Badge>
      </div>
    );
  },
  (prevProps, nextProps) => prevProps.leaseStatus === nextProps.leaseStatus,
);

LeaseStatusCell.displayName = "LeaseStatusCell";

// Public access cell with badge
const PublicAccessCell = React.memo(
  ({ publicAccess }: { publicAccess: "container" | "blob" | null }) => {
    const accessConfig = PUBLIC_ACCESS_VARIANTS[publicAccess || "null"];
    const AccessIcon = accessConfig.icon;

    return (
      <div className="flex items-center gap-2 min-h-[2rem]">
        <AccessIcon className={`h-4 w-4 ${accessConfig.color}`} />
        <Badge variant={accessConfig.variant} className="font-medium">
          {accessConfig.label}
        </Badge>
      </div>
    );
  },
  (prevProps, nextProps) => prevProps.publicAccess === nextProps.publicAccess,
);

PublicAccessCell.displayName = "PublicAccessCell";

// Metadata indicator cell
const MetadataCell = React.memo(
  ({ metadata }: { metadata?: Record<string, string> }) => {
    const hasMetadata = metadata && Object.keys(metadata).length > 0;

    return (
      <div className="flex items-center gap-2 min-h-[2rem]">
        {hasMetadata ? (
          <>
            <IconDatabase className="h-4 w-4 text-blue-600" />
            <Badge variant="secondary" className="font-medium">
              {Object.keys(metadata).length} keys
            </Badge>
          </>
        ) : (
          <span className="text-muted-foreground text-sm flex items-center gap-1">
            <IconDatabase className="h-4 w-4" />
            None
          </span>
        )}
      </div>
    );
  },
  (prevProps, nextProps) => {
    const prevKeys = prevProps.metadata
      ? Object.keys(prevProps.metadata).length
      : 0;
    const nextKeys = nextProps.metadata
      ? Object.keys(nextProps.metadata).length
      : 0;
    return prevKeys === nextKeys;
  },
);

MetadataCell.displayName = "MetadataCell";

// Container access test result interface
interface ContainerAccessTest {
  containerName: string;
  status: "testing" | "success" | "failed" | "idle";
  lastTested?: Date;
  responseTime?: number;
  error?: string;
}

// Container actions cell with test access functionality
const ActionsCell = React.memo(
  ({
    containerName,
    testStatus,
    onTestAccess,
  }: {
    containerName: string;
    testStatus?: ContainerAccessTest;
    onTestAccess: (containerName: string) => void;
  }) => {
    const isTestActive = testStatus?.status === "testing";
    const hasResult =
      testStatus?.status === "success" || testStatus?.status === "failed";

    return (
      <div className="flex items-center gap-2 min-h-[2rem]">
        <Button
          variant="outline"
          size="sm"
          onClick={() => onTestAccess(containerName)}
          disabled={isTestActive}
          className="h-8 px-3"
        >
          {isTestActive ? (
            <IconLoader2 className="h-3 w-3 animate-spin mr-1" />
          ) : (
            <IconCloudQuestion className="h-3 w-3 mr-1" />
          )}
          Test Access
        </Button>
        {hasResult && (
          <div className="flex items-center gap-1">
            {testStatus?.status === "success" ? (
              <div title="Access successful">
                <IconCircleCheck className="h-4 w-4 text-green-600" />
              </div>
            ) : (
              <div title={testStatus?.error || "Access failed"}>
                <IconCircleX className="h-4 w-4 text-red-600" />
              </div>
            )}
            {testStatus?.responseTime && (
              <span
                className="text-xs text-muted-foreground"
                title="Response time"
              >
                {testStatus.responseTime}ms
              </span>
            )}
          </div>
        )}
      </div>
    );
  },
  (prevProps, nextProps) =>
    prevProps.containerName === nextProps.containerName &&
    JSON.stringify(prevProps.testStatus) ===
      JSON.stringify(nextProps.testStatus),
);

ActionsCell.displayName = "ActionsCell";

// Container row component
const ContainerRow = React.memo(
  ({
    container,
    visibleCells,
    getColumnWidth,
  }: {
    container: AzureContainerInfo;
    visibleCells: Cell<AzureContainerInfo, unknown>[];
    getColumnWidth: (index: number) => string;
  }) => (
    <TableRow key={container.name} className="hover:bg-muted/50 h-16">
      {visibleCells.map((cell, index) => (
        <TableCell
          key={cell.id}
          className={`px-6 py-4 ${getColumnWidth(index)} align-middle`}
          style={{ height: "4rem" }}
        >
          {flexRender(cell.column.columnDef.cell, cell.getContext())}
        </TableCell>
      ))}
    </TableRow>
  ),
  (prevProps, nextProps) => {
    const prev = prevProps.container;
    const next = nextProps.container;

    return (
      prev.name === next.name &&
      prev.lastModified === next.lastModified &&
      prev.leaseStatus === next.leaseStatus &&
      prev.publicAccess === next.publicAccess &&
      JSON.stringify(prev.metadata) === JSON.stringify(next.metadata)
    );
  },
);

ContainerRow.displayName = "ContainerRow";

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

  // Fixed column widths
  const getColumnWidth = React.useCallback((index: number) => {
    switch (index) {
      case 0:
        return "w-[250px] min-w-[250px] max-w-[250px]"; // Container Name
      case 1:
        return "w-[200px] min-w-[200px] max-w-[200px]"; // Last Modified
      case 2:
        return "w-[140px] min-w-[140px] max-w-[140px]"; // Lease Status
      case 3:
        return "w-[120px] min-w-[120px] max-w-[120px]"; // Access Level
      case 4:
        return "w-[140px] min-w-[140px] max-w-[140px]"; // Metadata
      case 5:
        return "w-[180px] min-w-[180px] max-w-[180px]"; // Actions
      default:
        return "";
    }
  }, []);

  // Navigation handlers
  const handlePrevPage = React.useCallback(
    () => updateFilter("page", filters.page - 1),
    [updateFilter, filters.page],
  );
  const handleNextPage = React.useCallback(
    () => updateFilter("page", filters.page + 1),
    [updateFilter, filters.page],
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
        {/* Filters */}
        <div className="flex flex-wrap gap-4 mb-6">
          <div className="relative flex-1 min-w-64">
            <IconSearch className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search containers by name..."
              value={filters.namePrefix || ""}
              onChange={(e) =>
                updateFilter("namePrefix", e.target.value || undefined)
              }
              className="pl-9"
            />
          </div>
          <Select
            value={filters.leaseStatus || "all"}
            onValueChange={(value) =>
              updateFilter(
                "leaseStatus",
                value === "all" ? undefined : (value as "locked" | "unlocked"),
              )
            }
          >
            <SelectTrigger className="w-40">
              <SelectValue placeholder="Lease Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="unlocked">Unlocked</SelectItem>
              <SelectItem value="locked">Locked</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={
              filters.publicAccess === null
                ? "private"
                : filters.publicAccess || "all"
            }
            onValueChange={(value) => {
              if (value === "all") {
                updateFilter("publicAccess", undefined);
              } else if (value === "private") {
                updateFilter("publicAccess", null);
              } else {
                updateFilter("publicAccess", value as "container" | "blob");
              }
            }}
          >
            <SelectTrigger className="w-40">
              <SelectValue placeholder="Access Level" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Access</SelectItem>
              <SelectItem value="private">Private</SelectItem>
              <SelectItem value="container">Container</SelectItem>
              <SelectItem value="blob">Blob</SelectItem>
            </SelectContent>
          </Select>
          {(filters.namePrefix ||
            filters.leaseStatus ||
            filters.publicAccess !== undefined) && (
            <Button variant="outline" size="sm" onClick={resetFilters}>
              Clear Filters
            </Button>
          )}
        </div>

        {/* Container Table */}
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
            <div className="rounded-md border">
              <Table className="table-fixed">
                <TableHeader>
                  {table.getHeaderGroups().map((headerGroup) => (
                    <TableRow key={headerGroup.id}>
                      {headerGroup.headers.map((header, index) => (
                        <TableHead
                          key={header.id}
                          className={`px-6 py-3 ${getColumnWidth(index)}`}
                        >
                          {header.isPlaceholder
                            ? null
                            : flexRender(
                                header.column.columnDef.header,
                                header.getContext(),
                              )}
                        </TableHead>
                      ))}
                    </TableRow>
                  ))}
                </TableHeader>

                <TableBody>
                  {table.getRowModel().rows?.length ? (
                    table
                      .getRowModel()
                      .rows.map((row) => (
                        <ContainerRow
                          key={row.original.name}
                          container={row.original}
                          visibleCells={row.getVisibleCells()}
                          getColumnWidth={getColumnWidth}
                        />
                      ))
                  ) : (
                    <TableRow>
                      <TableCell
                        colSpan={columns.length}
                        className="h-24 text-center"
                      >
                        No containers found.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between">
                <div className="text-sm text-muted-foreground">
                  Showing {startItem} to {endItem} of {totalCount} containers
                </div>

                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handlePrevPage}
                    disabled={filters.page <= 1}
                  >
                    <IconChevronLeft className="h-4 w-4" />
                    Previous
                  </Button>

                  <div className="flex items-center gap-1">
                    {totalPages <= 7 ? (
                      // Show all pages if there are 7 or fewer
                      Array.from({ length: totalPages }, (_, i) => i + 1).map(
                        (pageNum) => (
                          <Button
                            key={pageNum}
                            variant={
                              filters.page === pageNum ? "default" : "outline"
                            }
                            size="sm"
                            onClick={() => updateFilter("page", pageNum)}
                            className="w-8"
                          >
                            {pageNum}
                          </Button>
                        ),
                      )
                    ) : (
                      // Show abbreviated pagination for more than 7 pages
                      <>
                        {filters.page > 3 && (
                          <>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => updateFilter("page", 1)}
                              className="w-8"
                            >
                              1
                            </Button>
                            {filters.page > 4 && (
                              <span className="text-muted-foreground">...</span>
                            )}
                          </>
                        )}

                        {Array.from(
                          { length: Math.min(5, totalPages) },
                          (_, i) =>
                            Math.max(
                              1,
                              Math.min(filters.page - 2, totalPages - 4),
                            ) + i,
                        )
                          .filter((pageNum) => pageNum <= totalPages)
                          .map((pageNum) => (
                            <Button
                              key={pageNum}
                              variant={
                                filters.page === pageNum ? "default" : "outline"
                              }
                              size="sm"
                              onClick={() => updateFilter("page", pageNum)}
                              className="w-8"
                            >
                              {pageNum}
                            </Button>
                          ))}

                        {filters.page < totalPages - 2 && (
                          <>
                            {filters.page < totalPages - 3 && (
                              <span className="text-muted-foreground">...</span>
                            )}
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => updateFilter("page", totalPages)}
                              className="w-8"
                            >
                              {totalPages}
                            </Button>
                          </>
                        )}
                      </>
                    )}
                  </div>

                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleNextPage}
                    disabled={filters.page >= totalPages}
                  >
                    Next
                    <IconChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
});
