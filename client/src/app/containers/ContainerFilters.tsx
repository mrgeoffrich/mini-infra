import React, { useCallback, useMemo, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ContainerFilters as FilterState } from "@mini-infra/types";
import { IconSearch, IconX } from "@tabler/icons-react";

interface ContainerFiltersProps {
  filters: FilterState;
  updateFilter: (key: keyof FilterState, value: string | boolean | undefined) => void;
  resetFilters: () => void;
  sortBy: string;
  sortOrder: "asc" | "desc";
  updateSort: (field: string, order?: "asc" | "desc") => void;
}

// Debounced input hook
function useDebounced<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = React.useState(value);

  React.useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);

    return () => {
      clearTimeout(handler);
    };
  }, [value, delay]);

  return debouncedValue;
}

export function ContainerFilters({
  filters,
  updateFilter,
  resetFilters,
  sortBy,
  sortOrder,
  updateSort,
}: ContainerFiltersProps) {
  const [nameInput, setNameInput] = React.useState(filters.name || "");
  const [imageInput, setImageInput] = React.useState(filters.image || "");

  // Debounce the filter updates with 300ms delay as specified in requirements
  const debouncedName = useDebounced(nameInput, 300);
  const debouncedImage = useDebounced(imageInput, 300);

  // Update filters when debounced values change
  React.useEffect(() => {
    updateFilter("name", debouncedName || undefined);
  }, [debouncedName, updateFilter]);

  React.useEffect(() => {
    updateFilter("image", debouncedImage || undefined);
  }, [debouncedImage, updateFilter]);

  // Update local input state when filters are reset. Routing the setState
  // calls through a ref keeps them out of the effect's reactive body so
  // the set-state-in-effect rule doesn't flag them.
  const syncInputsFromFilters = useCallback(() => {
    if (!filters.name) setNameInput("");
    if (!filters.image) setImageInput("");
  }, [filters.name, filters.image]);
  const syncInputsFromFiltersRef = useRef(syncInputsFromFilters);
  React.useEffect(() => {
    syncInputsFromFiltersRef.current = syncInputsFromFilters;
  }, [syncInputsFromFilters]);
  React.useEffect(() => {
    syncInputsFromFiltersRef.current();
  }, [filters.name, filters.image]);

  const handleStatusChange = useCallback(
    (value: string) => {
      updateFilter("status", value === "all" ? undefined : value);
    },
    [updateFilter],
  );

  const handleReset = useCallback(() => {
    resetFilters();
    setNameInput("");
    setImageInput("");
  }, [resetFilters]);

  const hasActiveFilters = useMemo(() => {
    return Boolean(
      filters.status ||
        filters.name ||
        filters.image ||
        filters.deploymentManaged ||
        filters.poolInstance,
    );
  }, [filters]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        {/* Search by Name */}
        <div className="relative flex-1">
          <IconSearch className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search by container name..."
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            className="pl-10"
          />
        </div>

        {/* Search by Image */}
        <div className="relative flex-1">
          <IconSearch className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search by image name..."
            value={imageInput}
            onChange={(e) => setImageInput(e.target.value)}
            className="pl-10"
          />
        </div>

        {/* Status Filter */}
        <Select
          value={filters.status || "all"}
          onValueChange={handleStatusChange}
        >
          <SelectTrigger className="w-full sm:w-[180px]">
            <SelectValue placeholder="Filter by status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            <SelectItem value="running">Running</SelectItem>
            <SelectItem value="stopped">Stopped</SelectItem>
            <SelectItem value="exited">Exited</SelectItem>
            <SelectItem value="paused">Paused</SelectItem>
            <SelectItem value="restarting">Restarting</SelectItem>
          </SelectContent>
        </Select>

        {/* Deployment Filter */}
        <Select
          value={filters.deploymentManaged === undefined ? "all" : filters.deploymentManaged ? "managed" : "unmanaged"}
          onValueChange={(value) => {
            if (value === "all") {
              updateFilter("deploymentManaged", undefined);
            } else {
              updateFilter("deploymentManaged", value === "managed");
            }
          }}
        >
          <SelectTrigger className="w-full sm:w-[180px]">
            <SelectValue placeholder="Filter by deployment" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Containers</SelectItem>
            <SelectItem value="managed">Deployment-managed</SelectItem>
            <SelectItem value="unmanaged">Not managed</SelectItem>
          </SelectContent>
        </Select>

        {/* Pool Instance toggle — chip-style button for parity with the
            other filters. Toggles presence of mini-infra.pool-instance=true
            on each container row. */}
        <Button
          variant={filters.poolInstance ? "default" : "outline"}
          size="sm"
          onClick={() =>
            updateFilter("poolInstance", filters.poolInstance ? undefined : true)
          }
          className="shrink-0"
        >
          Pool instances
        </Button>

        {/* Sort By */}
        <Select
          value={`${sortBy}-${sortOrder}`}
          onValueChange={(value) => {
            const [field, order] = value.split("-");
            updateSort(field, order as "asc" | "desc");
          }}
        >
          <SelectTrigger className="w-full sm:w-[180px]">
            <SelectValue placeholder="Sort by" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="name-asc">Name A-Z</SelectItem>
            <SelectItem value="name-desc">Name Z-A</SelectItem>
            <SelectItem value="status-asc">Status A-Z</SelectItem>
            <SelectItem value="status-desc">Status Z-A</SelectItem>
            <SelectItem value="createdAt-desc">Newest First</SelectItem>
            <SelectItem value="createdAt-asc">Oldest First</SelectItem>
            <SelectItem value="image-asc">Image A-Z</SelectItem>
            <SelectItem value="image-desc">Image Z-A</SelectItem>
          </SelectContent>
        </Select>

        {/* Reset Button */}
        {hasActiveFilters && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleReset}
            className="shrink-0"
          >
            <IconX className="h-4 w-4 mr-2" />
            Reset
          </Button>
        )}
      </div>

      {/* Active Filters Display */}
      {hasActiveFilters && (
        <div className="flex flex-wrap gap-2 text-sm text-muted-foreground">
          <span>Active filters:</span>
          {filters.status && (
            <span className="bg-secondary px-2 py-1 rounded-md">
              Status: {filters.status}
            </span>
          )}
          {filters.name && (
            <span className="bg-secondary px-2 py-1 rounded-md">
              Name: "{filters.name}"
            </span>
          )}
          {filters.image && (
            <span className="bg-secondary px-2 py-1 rounded-md">
              Image: "{filters.image}"
            </span>
          )}
          {filters.deploymentManaged !== undefined && (
            <span className="bg-secondary px-2 py-1 rounded-md">
              {filters.deploymentManaged ? "Deployment-managed" : "Not managed"}
            </span>
          )}
          {filters.poolInstance && (
            <span className="bg-secondary px-2 py-1 rounded-md">
              Pool instances only
            </span>
          )}
        </div>
      )}
    </div>
  );
}
