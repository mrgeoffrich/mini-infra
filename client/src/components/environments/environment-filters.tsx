import type { EnvironmentType } from "@mini-infra/types";

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
  const hasActiveFilters = !!filters.type;

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
