import React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { IconSearch } from "@tabler/icons-react";
import type { StorageObjectFiltersState } from "@/hooks/use-storage-settings";

interface LocationFiltersProps {
  filters: {
    namePrefix?: string;
    leaseStatus?: "locked" | "unlocked";
    publicAccess?: "container" | "blob" | null;
  };
  updateFilter: <K extends keyof StorageObjectFiltersState>(
    key: K,
    value: StorageObjectFiltersState[K],
  ) => void;
  resetFilters: () => void;
}

export const LocationFilters = React.memo(function LocationFilters({
  filters,
  updateFilter,
  resetFilters,
}: LocationFiltersProps) {
  return (
    <div className="flex flex-wrap gap-4 mb-6">
      <div className="relative flex-1 min-w-64">
        <IconSearch className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search locations by name..."
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
  );
});
