import React from "react";
import { useState, useEffect, useCallback } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  IconSearch,
  IconArrowDown,
  IconArrowUp,
  IconPlayerPlay,
  IconRefresh,
  IconX,
} from "@tabler/icons-react";
import type { LogFiltersState, TimeRange } from "@/hooks/use-loki-logs";

const TIME_RANGES: TimeRange[] = ["5m", "15m", "1h", "6h", "24h"];

interface LogControlsProps {
  filters: LogFiltersState;
  services: string[];
  updateFilter: <K extends keyof LogFiltersState>(
    key: K,
    value: LogFiltersState[K],
  ) => void;
  onRefresh: () => void;
  isLoading: boolean;
  extraActions?: React.ReactNode;
}

export function LogControls({
  filters,
  services,
  updateFilter,
  onRefresh,
  isLoading,
  extraActions,
}: LogControlsProps) {
  const [spinning, setSpinning] = useState(false);

  useEffect(() => {
    if (isLoading) setSpinning(true);
  }, [isLoading]);

  useEffect(() => {
    if (!spinning) return;
    const timer = setTimeout(() => setSpinning(false), 500);
    return () => clearTimeout(timer);
  }, [spinning]);

  const handleRefresh = useCallback(() => {
    setSpinning(true);
    onRefresh();
  }, [onRefresh]);

  const selectedService =
    filters.services.length === 1 ? filters.services[0] : "__all__";

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {/* Service */}
        <Select
          value={selectedService}
          onValueChange={(v) =>
            updateFilter("services", v === "__all__" ? [] : [v])
          }
        >
          <SelectTrigger className="w-48">
            <SelectValue placeholder="All Containers" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">All Containers</SelectItem>
            {services.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Time range buttons */}
        <div className="flex gap-1">
          {TIME_RANGES.map((range) => (
            <Button
              key={range}
              variant={filters.timeRange === range ? "default" : "outline"}
              size="sm"
              className="h-9 px-3"
              onClick={() => updateFilter("timeRange", range)}
            >
              {range}
            </Button>
          ))}
        </div>

        {/* Search */}
        <div className="relative flex-1 min-w-[200px]">
          <IconSearch className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search logs..."
            value={filters.search}
            onChange={(e) => updateFilter("search", e.target.value)}
            className="pl-9 pr-8"
          />
          {filters.search && (
            <Button
              variant="ghost"
              size="sm"
              className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7 p-0"
              onClick={() => updateFilter("search", "")}
            >
              <IconX className="h-3 w-3" />
            </Button>
          )}
        </div>

        {/* Direction */}
        <Button
          variant="outline"
          size="sm"
          className="h-9"
          onClick={() =>
            updateFilter(
              "direction",
              filters.direction === "backward" ? "forward" : "backward",
            )
          }
          title={
            filters.direction === "backward" ? "Newest first" : "Oldest first"
          }
        >
          {filters.direction === "backward" ? (
            <>
              <IconArrowDown className="h-4 w-4 mr-1" /> Newest
            </>
          ) : (
            <>
              <IconArrowUp className="h-4 w-4 mr-1" /> Oldest
            </>
          )}
        </Button>

        {/* Limit */}
        <Select
          value={String(filters.limit)}
          onValueChange={(v) => updateFilter("limit", parseInt(v, 10))}
        >
          <SelectTrigger className="w-24">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="500">500</SelectItem>
            <SelectItem value="1000">1000</SelectItem>
            <SelectItem value="5000">5000</SelectItem>
          </SelectContent>
        </Select>

        {/* Tail */}
        <Button
          variant={filters.tailing ? "default" : "outline"}
          size="sm"
          className={`h-9 ${filters.tailing ? "bg-green-600 hover:bg-green-700" : ""}`}
          onClick={() => updateFilter("tailing", !filters.tailing)}
        >
          {filters.tailing && (
            <span className="mr-1.5 h-2 w-2 rounded-full bg-green-300 animate-pulse inline-block" />
          )}
          <IconPlayerPlay className="h-4 w-4 mr-1" />
          Tail
        </Button>

        {/* Refresh */}
        <Button
          variant="outline"
          size="icon"
          className="h-9 w-9"
          onClick={handleRefresh}
        >
          <IconRefresh
            className={`h-4 w-4 ${spinning ? "animate-spin" : ""}`}
          />
        </Button>

        {extraActions}
      </div>

    </div>
  );
}
