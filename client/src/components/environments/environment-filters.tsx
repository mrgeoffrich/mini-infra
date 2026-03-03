import type { EnvironmentType, ServiceStatus } from "@mini-infra/types";

const ServiceStatusValues = {
  UNINITIALIZED: 'uninitialized' as const,
  INITIALIZING: 'initializing' as const,
  INITIALIZED: 'initialized' as const,
  STARTING: 'starting' as const,
  RUNNING: 'running' as const,
  STOPPING: 'stopping' as const,
  STOPPED: 'stopped' as const,
  FAILED: 'failed' as const,
  DEGRADED: 'degraded' as const,
};
import { EnvironmentFiltersState } from "@/hooks/use-environments";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { IconX, IconFilter } from "@tabler/icons-react";
import { cn } from "@/lib/utils";

interface EnvironmentFiltersProps {
  filters: EnvironmentFiltersState;
  onFilterChange: <K extends keyof EnvironmentFiltersState>(
    key: K,
    value: EnvironmentFiltersState[K],
  ) => void;
  onResetFilters: () => void;
  className?: string;
}

export function EnvironmentFilters({
  filters,
  onFilterChange,
  onResetFilters,
  className,
}: EnvironmentFiltersProps) {
  const hasActiveFilters = filters.type || filters.status;

  const getStatusDisplayName = (status: ServiceStatus) => {
    switch (status) {
      case ServiceStatusValues.RUNNING:
        return "Running";
      case ServiceStatusValues.STOPPED:
        return "Stopped";
      case ServiceStatusValues.STARTING:
        return "Starting";
      case ServiceStatusValues.STOPPING:
        return "Stopping";
      case ServiceStatusValues.FAILED:
        return "Failed";
      case ServiceStatusValues.DEGRADED:
        return "Degraded";
      case ServiceStatusValues.INITIALIZING:
        return "Initializing";
      case ServiceStatusValues.INITIALIZED:
        return "Initialized";
      case ServiceStatusValues.UNINITIALIZED:
        return "Uninitialized";
      default:
        return status;
    }
  };

  const getTypeDisplayName = (type: EnvironmentType) => {
    switch (type) {
      case "production":
        return "Production";
      case "nonproduction":
        return "Non-Production";
      default:
        return type;
    }
  };

  return (
    <Card className={cn("border-dashed", className)}>
      <CardContent className="p-4">
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <IconFilter className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">Filters:</span>
          </div>

          {/* Type Filter */}
          <div className="flex items-center gap-2">
            <label className="text-sm text-muted-foreground">Type:</label>
            <Select
              value={filters.type || "all"}
              onValueChange={(value) =>
                onFilterChange("type", value === "all" ? undefined : (value as EnvironmentType))
              }
            >
              <SelectTrigger className="w-40">
                <SelectValue placeholder="All types" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Types</SelectItem>
                <SelectItem value="production">Production</SelectItem>
                <SelectItem value="nonproduction">Non-Production</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Status Filter */}
          <div className="flex items-center gap-2">
            <label className="text-sm text-muted-foreground">Status:</label>
            <Select
              value={filters.status || "all"}
              onValueChange={(value) =>
                onFilterChange("status", value === "all" ? undefined : (value as ServiceStatus))
              }
            >
              <SelectTrigger className="w-40">
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                <SelectItem value={ServiceStatusValues.RUNNING}>Running</SelectItem>
                <SelectItem value={ServiceStatusValues.STOPPED}>Stopped</SelectItem>
                <SelectItem value={ServiceStatusValues.STARTING}>Starting</SelectItem>
                <SelectItem value={ServiceStatusValues.STOPPING}>Stopping</SelectItem>
                <SelectItem value={ServiceStatusValues.FAILED}>Failed</SelectItem>
                <SelectItem value={ServiceStatusValues.DEGRADED}>Degraded</SelectItem>
                <SelectItem value={ServiceStatusValues.INITIALIZING}>Initializing</SelectItem>
                <SelectItem value={ServiceStatusValues.INITIALIZED}>Initialized</SelectItem>
                <SelectItem value={ServiceStatusValues.UNINITIALIZED}>Uninitialized</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Active Filters Display */}
          {hasActiveFilters && (
            <div className="flex items-center gap-2 ml-auto">
              <span className="text-sm text-muted-foreground">Active filters:</span>
              <div className="flex gap-1">
                {filters.type && (
                  <Badge
                    variant="secondary"
                    className="flex items-center gap-1 text-xs"
                  >
                    Type: {getTypeDisplayName(filters.type)}
                    <button
                      onClick={() => onFilterChange("type", undefined)}
                      className="ml-1 hover:bg-muted-foreground/20 rounded"
                    >
                      <IconX className="h-3 w-3" />
                    </button>
                  </Badge>
                )}
                {filters.status && (
                  <Badge
                    variant="secondary"
                    className="flex items-center gap-1 text-xs"
                  >
                    Status: {getStatusDisplayName(filters.status)}
                    <button
                      onClick={() => onFilterChange("status", undefined)}
                      className="ml-1 hover:bg-muted-foreground/20 rounded"
                    >
                      <IconX className="h-3 w-3" />
                    </button>
                  </Badge>
                )}
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={onResetFilters}
                className="h-7 px-2 text-xs"
              >
                Clear All
              </Button>
            </div>
          )}

          {!hasActiveFilters && (
            <span className="text-sm text-muted-foreground ml-auto">
              No filters applied
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}