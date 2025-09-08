import React, { useMemo, useCallback } from "react";
import {
  ColumnDef,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import {
  IconArrowsUpDown,
  IconChevronLeft,
  IconChevronRight,
  IconDotsVertical,
  IconPlayerPlay,
  IconHistory,
  IconEdit,
  IconPlus,
  IconFilter,
  IconX,
} from "@tabler/icons-react";

import { useFormattedDate } from "@/hooks/use-formatted-date";
import { useDeploymentConfigs, useDeploymentConfigFilters } from "@/hooks/use-deployment-configs";
import { useActiveDeployments } from "@/hooks/use-deployment-history";
import { useDeploymentTrigger } from "@/hooks/use-deployment-trigger";
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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "sonner";
import { DeploymentConfigurationInfo, DeploymentInfo } from "@mini-infra/types";
import type { DeploymentConfigFiltersState } from "@/hooks/use-deployment-configs";

interface DeploymentListProps {
  onEditConfig?: (config: DeploymentConfigurationInfo) => void;
  onDeleteConfig?: (config: DeploymentConfigurationInfo) => void;
  onCreateConfig?: () => void;
}

// Status badge component for deployment configurations
const DeploymentStatusBadge = React.memo(({ isActive }: { isActive: boolean }) => (
  <Badge variant={isActive ? "default" : "secondary"}>
    {isActive ? "Active" : "Inactive"}
  </Badge>
));
DeploymentStatusBadge.displayName = "DeploymentStatusBadge";

// Last deployment badge component
const LastDeploymentBadge = React.memo(({ deployment }: { deployment?: DeploymentInfo }) => {
  const { formatDateTime } = useFormattedDate();
  
  if (!deployment) {
    return <Badge variant="outline">Never deployed</Badge>;
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case "completed":
        return "bg-green-500 text-white";
      case "failed":
        return "bg-red-500 text-white";
      case "pending":
      case "preparing":
      case "deploying":
      case "health_checking":
      case "switching_traffic":
      case "cleanup":
        return "bg-blue-500 text-white";
      case "rolling_back":
        return "bg-orange-500 text-white";
      default:
        return "";
    }
  };

  return (
    <div className="space-y-1">
      <Badge className={getStatusColor(deployment.status)}>
        {deployment.status.replace('_', ' ')}
      </Badge>
      <div className="text-xs text-muted-foreground">
        {formatDateTime(deployment.startedAt)}
      </div>
    </div>
  );
});
LastDeploymentBadge.displayName = "LastDeploymentBadge";

// Action buttons component
const DeploymentActions = React.memo(({
  config,
  onTrigger,
  onEdit,
  onViewHistory,
  onDelete,
  isTriggering,
}: {
  config: DeploymentConfigurationInfo;
  onTrigger: (applicationName: string) => void;
  onEdit?: (config: DeploymentConfigurationInfo) => void;
  onDelete?: (config: DeploymentConfigurationInfo) => void;
  isTriggering: boolean;
}) => {
  const handleTrigger = useCallback(() => {
    onTrigger(config.applicationName);
  }, [config.applicationName, onTrigger]);

  const handleEdit = useCallback(() => {
    onEdit?.(config);
  }, [config, onEdit]);

  const handleDelete = useCallback(() => {
    onDelete?.(config);
  }, [config, onDelete]);

  return (
    <div className="flex items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        onClick={handleTrigger}
        disabled={isTriggering || !config.isActive}
        className="h-8"
      >
        <IconPlayerPlay className="h-3 w-3 mr-1" />
        Deploy
      </Button>
      
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
            <IconDotsVertical className="h-3 w-3" />
            <span className="sr-only">Open menu</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={handleEdit}>
            <IconEdit className="h-3 w-3 mr-2" />
            Edit Configuration
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={handleDelete} className="text-destructive">
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
});
DeploymentActions.displayName = "DeploymentActions";

// Filters component
const DeploymentFilters = React.memo(({
  filters,
  updateFilter,
  resetFilters,
}: {
  filters: DeploymentConfigFiltersState;
  updateFilter: <K extends keyof DeploymentConfigFiltersState>(key: K, value: DeploymentConfigFiltersState[K]) => void;
  resetFilters: () => void;
}) => {
  const hasActiveFilters = filters.applicationName || filters.dockerImage || filters.isActive !== undefined;

  return (
    <div className="flex items-center gap-4 p-4 bg-muted/50 rounded-lg">
      <div className="flex items-center gap-2">
        <IconFilter className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">Filters:</span>
      </div>
      
      <div className="flex items-center gap-2">
        <Label htmlFor="app-name-filter" className="text-sm">Application:</Label>
        <Input
          id="app-name-filter"
          placeholder="Filter by name..."
          value={filters.applicationName || ""}
          onChange={(e) => updateFilter("applicationName", e.target.value)}
          className="w-40 h-8"
        />
      </div>

      <div className="flex items-center gap-2">
        <Label htmlFor="image-filter" className="text-sm">Image:</Label>
        <Input
          id="image-filter"
          placeholder="Filter by image..."
          value={filters.dockerImage || ""}
          onChange={(e) => updateFilter("dockerImage", e.target.value)}
          className="w-40 h-8"
        />
      </div>

      <div className="flex items-center gap-2">
        <Label htmlFor="status-filter" className="text-sm">Status:</Label>
        <Select
          value={filters.isActive === undefined ? "all" : filters.isActive ? "active" : "inactive"}
          onValueChange={(value) => 
            updateFilter("isActive", value === "all" ? undefined : value === "active")
          }
        >
          <SelectTrigger id="status-filter" className="w-28 h-8">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="inactive">Inactive</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {hasActiveFilters && (
        <Button 
          variant="ghost" 
          size="sm" 
          onClick={resetFilters}
          className="h-8"
        >
          <IconX className="h-3 w-3 mr-1" />
          Clear
        </Button>
      )}
    </div>
  );
});
DeploymentFilters.displayName = "DeploymentFilters";

export const DeploymentList = React.memo(function DeploymentList({
  onEditConfig,
  onDeleteConfig,
  onCreateConfig,
}: DeploymentListProps) {
  const { filters, updateFilter, resetFilters } = useDeploymentConfigFilters();
  const triggerMutation = useDeploymentTrigger();
  
  const {
    data: configsResponse,
    isLoading: isLoadingConfigs,
    error: configsError,
  } = useDeploymentConfigs({
    filters: {
      applicationName: filters.applicationName,
      dockerImage: filters.dockerImage,
      isActive: filters.isActive,
    },
    page: filters.page,
    limit: filters.limit,
    sortBy: filters.sortBy,
    sortOrder: filters.sortOrder,
    refetchInterval: 30000, // Refresh every 30 seconds
  });

  const {
    data: activeDeploymentsResponse,
  } = useActiveDeployments({
    refetchInterval: 5000, // Real-time updates for active deployments
  });

  const configs = configsResponse?.data || [];

  // Create a map of latest deployments by configuration
  const latestDeploymentsByConfig = useMemo(() => {
    const map = new Map<string, DeploymentInfo>();
    (activeDeploymentsResponse?.data || []).forEach((deployment) => {
      const existing = map.get(deployment.configurationId);
      if (!existing || new Date(deployment.startedAt) > new Date(existing.startedAt)) {
        map.set(deployment.configurationId, deployment);
      }
    });
    return map;
  }, [activeDeploymentsResponse?.data]);

  const handleSort = useCallback((field: keyof DeploymentConfigurationInfo) => {
    const newOrder = filters.sortBy === field && filters.sortOrder === "asc" ? "desc" : "asc";
    updateFilter("sortBy", field);
    updateFilter("sortOrder", newOrder);
  }, [filters.sortBy, filters.sortOrder, updateFilter]);

  const handleTriggerDeployment = useCallback(async (applicationName: string) => {
    try {
      await triggerMutation.mutateAsync({ applicationName });
      toast.success(`Deployment triggered for ${applicationName}`);
    } catch (error) {
      toast.error(`Failed to trigger deployment: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }, [triggerMutation]);

  const columns: ColumnDef<DeploymentConfigurationInfo>[] = useMemo(
    () => [
      {
        accessorKey: "applicationName",
        header: () => (
          <Button
            variant="ghost"
            onClick={() => handleSort("applicationName")}
            className="h-auto p-0 font-medium"
          >
            Application Name
            <IconArrowsUpDown className="ml-2 h-3 w-3" />
          </Button>
        ),
        cell: ({ row }) => (
          <div className="font-medium">
            {row.getValue("applicationName")}
          </div>
        ),
      },
      {
        accessorKey: "dockerImage",
        header: () => (
          <Button
            variant="ghost"
            onClick={() => handleSort("dockerImage")}
            className="h-auto p-0 font-medium"
          >
            Docker Image
            <IconArrowsUpDown className="ml-2 h-3 w-3" />
          </Button>
        ),
        cell: ({ row }) => {
          const image = row.getValue("dockerImage") as string;
          return (
            <div className="font-mono text-sm max-w-xs truncate" title={image}>
              {image}
            </div>
          );
        },
      },
      {
        accessorKey: "isActive",
        header: "Status",
        cell: ({ row }) => (
          <DeploymentStatusBadge isActive={row.getValue("isActive")} />
        ),
      },
      {
        id: "lastDeployment",
        header: "Last Deployment",
        cell: ({ row }) => {
          const config = row.original;
          const latestDeployment = latestDeploymentsByConfig.get(config.id);
          return <LastDeploymentBadge deployment={latestDeployment} />;
        },
      },
      {
        id: "actions",
        header: "Actions",
        cell: ({ row }) => {
          const config = row.original;
          return (
            <DeploymentActions
              config={config}
              onTrigger={handleTriggerDeployment}
              onEdit={onEditConfig}
              onDelete={onDeleteConfig}
              isTriggering={triggerMutation.isPending}
            />
          );
        },
      },
    ],
    [handleSort, latestDeploymentsByConfig, handleTriggerDeployment, onEditConfig, onDeleteConfig, triggerMutation.isPending]
  );

  const table = useReactTable({
    data: configs,
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualSorting: true,
    getRowId: (row) => row.id,
  });

  const totalPages = useMemo(
    () => Math.ceil((configsResponse?.pagination?.totalCount || 0) / filters.limit),
    [configsResponse?.pagination?.totalCount, filters.limit]
  );

  const handlePageChange = useCallback((newPage: number) => {
    updateFilter("page", newPage);
  }, [updateFilter]);

  const handlePrevPage = useCallback(() => {
    if (filters.page > 1) {
      updateFilter("page", filters.page - 1);
    }
  }, [filters.page, updateFilter]);

  const handleNextPage = useCallback(() => {
    if (filters.page < totalPages) {
      updateFilter("page", filters.page + 1);
    }
  }, [filters.page, totalPages, updateFilter]);

  if (configsError) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="text-center">
          <p className="text-muted-foreground">Failed to load deployment configurations</p>
          <p className="text-sm text-destructive mt-2">
            {configsError instanceof Error ? configsError.message : "Unknown error"}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">

      {/* Filters */}
      <DeploymentFilters 
        filters={filters}
        updateFilter={updateFilter}
        resetFilters={resetFilters}
      />

      {/* Loading skeleton */}
      {isLoadingConfigs && configs.length === 0 && (
        <div className="space-y-4">
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        </div>
      )}

      {/* Table */}
      {!isLoadingConfigs || configs.length > 0 ? (
        <div className="space-y-4">
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                {table.getHeaderGroups().map((headerGroup) => (
                  <TableRow key={headerGroup.id}>
                    {headerGroup.headers.map((header) => (
                      <TableHead key={header.id} className="px-6 py-3">
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
                  table.getRowModel().rows.map((row) => (
                    <TableRow key={row.id} className="hover:bg-muted/50">
                      {row.getVisibleCells().map((cell) => (
                        <TableCell key={cell.id} className="px-6 py-4">
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell
                      colSpan={columns.length}
                      className="h-24 text-center"
                    >
                      {isLoadingConfigs ? (
                        <div className="flex items-center justify-center">
                          <Skeleton className="h-4 w-32" />
                        </div>
                      ) : (
                        <div className="text-center space-y-2">
                          <p className="text-muted-foreground">No deployment configurations found.</p>
                          <Button variant="outline" onClick={onCreateConfig}>
                            <IconPlus className="h-4 w-4 mr-2" />
                            Create your first deployment configuration
                          </Button>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>

          {/* Pagination */}
          {configsResponse?.pagination && (
            <div className="flex items-center justify-between">
              <div className="text-sm text-muted-foreground">
                Showing {Math.min((filters.page - 1) * filters.limit + 1, configsResponse.pagination.totalCount)} to{" "}
                {Math.min(filters.page * filters.limit, configsResponse.pagination.totalCount)} of{" "}
                {configsResponse.pagination.totalCount} configurations
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
                  {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                    const pageNum = Math.max(1, Math.min(filters.page - 2, totalPages - 4)) + i;
                    if (pageNum > totalPages) return null;
                    
                    return (
                      <Button
                        key={pageNum}
                        variant={filters.page === pageNum ? "default" : "outline"}
                        size="sm"
                        onClick={() => handlePageChange(pageNum)}
                        className="w-8"
                      >
                        {pageNum}
                      </Button>
                    );
                  })}
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
      ) : null}
    </div>
  );
});