import React from "react";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AzureContainerFiltersState } from "@/hooks/use-azure-settings";

interface AzureContainerFiltersProps {
  filters: AzureContainerFiltersState;
  onUpdateFilter: <K extends keyof AzureContainerFiltersState>(
    key: K,
    value: AzureContainerFiltersState[K],
  ) => void;
  onResetFilters: () => void;
}

export const AzureContainerFilters = React.memo(
  ({ filters, onUpdateFilter, onResetFilters }: AzureContainerFiltersProps) => {
    const hasActiveFilters =
      filters.namePrefix ||
      filters.leaseStatus ||
      filters.publicAccess !== undefined;

    return (
      <div className="flex flex-wrap gap-4 mb-6">
        <div className="relative flex-1 min-w-64">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search containers by name..."
            value={filters.namePrefix || ""}
            onChange={(e) =>
              onUpdateFilter("namePrefix", e.target.value || undefined)
            }
            className="pl-9"
          />
        </div>
        <Select
          value={filters.leaseStatus || "all"}
          onValueChange={(value) =>
            onUpdateFilter(
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
              onUpdateFilter("publicAccess", undefined);
            } else if (value === "private") {
              onUpdateFilter("publicAccess", null);
            } else {
              onUpdateFilter("publicAccess", value as "container" | "blob");
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
        {hasActiveFilters && (
          <Button variant="outline" size="sm" onClick={onResetFilters}>
            Clear Filters
          </Button>
        )}
      </div>
    );
  },
);

AzureContainerFilters.displayName = "AzureContainerFilters";
