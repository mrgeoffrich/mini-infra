import { useCallback } from "react";
import { IconFilter, IconX } from "@tabler/icons-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EventFiltersState } from "@/hooks/use-events";

interface EventsFiltersProps {
  filters: EventFiltersState;
  onFilterChange: <K extends keyof EventFiltersState>(
    key: K,
    value: EventFiltersState[K],
  ) => void;
  onResetFilters: () => void;
}

const EVENT_TYPES = [
  { value: "deployment", label: "Deployment" },
  { value: "deployment_rollback", label: "Deployment Rollback" },
  { value: "deployment_uninstall", label: "Deployment Uninstall" },
  { value: "environment_start", label: "Environment Start" },
  { value: "environment_stop", label: "Environment Stop" },
  { value: "environment_create", label: "Environment Create" },
  { value: "environment_delete", label: "Environment Delete" },
  { value: "certificate_create", label: "Certificate Create" },
  { value: "certificate_renew", label: "Certificate Renew" },
  { value: "certificate_revoke", label: "Certificate Revoke" },
  { value: "backup", label: "Backup" },
  { value: "backup_cleanup", label: "Backup Cleanup" },
  { value: "restore", label: "Restore" },
  { value: "container_cleanup", label: "Container Cleanup" },
  { value: "database_create", label: "Database Create" },
  { value: "database_delete", label: "Database Delete" },
  { value: "user_create", label: "User Create" },
  { value: "user_delete", label: "User Delete" },
  { value: "system_maintenance", label: "System Maintenance" },
  { value: "other", label: "Other" },
];

const EVENT_CATEGORIES = [
  { value: "infrastructure", label: "Infrastructure" },
  { value: "database", label: "Database" },
  { value: "security", label: "Security" },
  { value: "maintenance", label: "Maintenance" },
  { value: "configuration", label: "Configuration" },
];

const EVENT_STATUSES = [
  { value: "pending", label: "Pending" },
  { value: "running", label: "Running" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
  { value: "cancelled", label: "Cancelled" },
];

export function EventsFilters({
  filters,
  onFilterChange,
  onResetFilters,
}: EventsFiltersProps) {
  const hasActiveFilters =
    filters.eventType?.length ||
    filters.eventCategory?.length ||
    filters.status?.length ||
    filters.search ||
    filters.startDate ||
    filters.endDate;

  const handleMultiSelectChange = useCallback(
    (key: "eventType" | "eventCategory" | "status", value: string) => {
      const currentValues = filters[key] || [];
      const newValues = currentValues.includes(value)
        ? currentValues.filter((v) => v !== value)
        : [...currentValues, value];
      onFilterChange(key, newValues.length > 0 ? newValues : undefined);
    },
    [filters, onFilterChange],
  );

  const removeFilter = useCallback(
    (key: "eventType" | "eventCategory" | "status", value: string) => {
      const currentValues = filters[key] || [];
      const newValues = currentValues.filter((v) => v !== value);
      onFilterChange(key, newValues.length > 0 ? newValues : undefined);
    },
    [filters, onFilterChange],
  );

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <IconFilter className="h-5 w-5" />
            Filters
          </CardTitle>
          {hasActiveFilters && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onResetFilters}
              className="h-8"
            >
              <IconX className="h-4 w-4 mr-1" />
              Clear All
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Search */}
        <div className="space-y-2">
          <Label htmlFor="search">Search</Label>
          <Input
            id="search"
            placeholder="Search event name, description..."
            value={filters.search || ""}
            onChange={(e) => onFilterChange("search", e.target.value || undefined)}
          />
        </div>

        {/* Event Type */}
        <div className="space-y-2">
          <Label>Event Type</Label>
          <Select onValueChange={(value) => handleMultiSelectChange("eventType", value)}>
            <SelectTrigger>
              <SelectValue placeholder="Select event type" />
            </SelectTrigger>
            <SelectContent>
              {EVENT_TYPES.map((type) => (
                <SelectItem key={type.value} value={type.value}>
                  {type.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {filters.eventType && filters.eventType.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {filters.eventType.map((type) => (
                <Badge key={type} variant="secondary" className="gap-1">
                  {EVENT_TYPES.find((t) => t.value === type)?.label || type}
                  <button
                    onClick={() => removeFilter("eventType", type)}
                    className="ml-1 hover:bg-secondary-foreground/20 rounded-full p-0.5"
                  >
                    <IconX className="h-3 w-3" />
                  </button>
                </Badge>
              ))}
            </div>
          )}
        </div>

        {/* Event Category */}
        <div className="space-y-2">
          <Label>Event Category</Label>
          <Select onValueChange={(value) => handleMultiSelectChange("eventCategory", value)}>
            <SelectTrigger>
              <SelectValue placeholder="Select category" />
            </SelectTrigger>
            <SelectContent>
              {EVENT_CATEGORIES.map((category) => (
                <SelectItem key={category.value} value={category.value}>
                  {category.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {filters.eventCategory && filters.eventCategory.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {filters.eventCategory.map((category) => (
                <Badge key={category} variant="secondary" className="gap-1">
                  {EVENT_CATEGORIES.find((c) => c.value === category)?.label || category}
                  <button
                    onClick={() => removeFilter("eventCategory", category)}
                    className="ml-1 hover:bg-secondary-foreground/20 rounded-full p-0.5"
                  >
                    <IconX className="h-3 w-3" />
                  </button>
                </Badge>
              ))}
            </div>
          )}
        </div>

        {/* Status */}
        <div className="space-y-2">
          <Label>Status</Label>
          <Select onValueChange={(value) => handleMultiSelectChange("status", value)}>
            <SelectTrigger>
              <SelectValue placeholder="Select status" />
            </SelectTrigger>
            <SelectContent>
              {EVENT_STATUSES.map((status) => (
                <SelectItem key={status.value} value={status.value}>
                  {status.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {filters.status && filters.status.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {filters.status.map((status) => (
                <Badge key={status} variant="secondary" className="gap-1">
                  {EVENT_STATUSES.find((s) => s.value === status)?.label || status}
                  <button
                    onClick={() => removeFilter("status", status)}
                    className="ml-1 hover:bg-secondary-foreground/20 rounded-full p-0.5"
                  >
                    <IconX className="h-3 w-3" />
                  </button>
                </Badge>
              ))}
            </div>
          )}
        </div>

        {/* Date Range */}
        <div className="space-y-2">
          <Label htmlFor="startDate">Start Date</Label>
          <Input
            id="startDate"
            type="datetime-local"
            value={filters.startDate || ""}
            onChange={(e) => onFilterChange("startDate", e.target.value || undefined)}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="endDate">End Date</Label>
          <Input
            id="endDate"
            type="datetime-local"
            value={filters.endDate || ""}
            onChange={(e) => onFilterChange("endDate", e.target.value || undefined)}
          />
        </div>
      </CardContent>
    </Card>
  );
}
