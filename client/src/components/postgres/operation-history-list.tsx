import { useState } from "react";
import { useFormattedDate } from "@/hooks/use-formatted-date";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  History,
  RefreshCw,
  Filter,
  ChevronDown,
  ChevronRight,
  AlertCircle,
  Database,
} from "lucide-react";
import {
  useOperationHistory,
  useOperationHistoryFilters,
} from "@/hooks/use-postgres-progress";
import {
  OperationStatusBadge,
  OperationTypeBadge,
  ProgressBadge,
} from "./operation-status-badge";
import type { OperationHistoryItem } from "@mini-infra/types";

interface OperationHistoryListProps {
  databaseId?: string;
  showDatabaseFilter?: boolean;
  maxHeight?: string;
  className?: string;
}

function formatBytes(bytes: number | null): string {
  if (!bytes || bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function formatDuration(startedAt: string, completedAt: string | null): string {
  if (!completedAt) return "-";

  const start = new Date(startedAt).getTime();
  const end = new Date(completedAt).getTime();
  const durationMs = end - start;

  if (durationMs < 1000) return "< 1s";
  if (durationMs < 60000) return `${Math.round(durationMs / 1000)}s`;
  if (durationMs < 3600000) return `${Math.round(durationMs / 60000)}m`;
  return `${Math.round(durationMs / 3600000)}h`;
}

function OperationDetailsRow({
  operation,
}: {
  operation: OperationHistoryItem;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const { formatDateTime } = useFormattedDate();

  return (
    <>
      <TableRow className="cursor-pointer hover:bg-muted/50">
        <TableCell>
          <div className="flex items-center space-x-2">
            <Collapsible open={isOpen} onOpenChange={setIsOpen}>
              <CollapsibleTrigger asChild>
                <Button variant="ghost" size="sm" className="p-0 h-6 w-6">
                  {isOpen ? (
                    <ChevronDown className="h-4 w-4" />
                  ) : (
                    <ChevronRight className="h-4 w-4" />
                  )}
                </Button>
              </CollapsibleTrigger>
            </Collapsible>
            <div className="min-w-0">
              <div className="font-medium text-sm truncate">
                {operation.databaseName || `Database ${operation.databaseId}`}
              </div>
              <div className="text-xs text-muted-foreground">
                {operation.id.substring(0, 8)}
              </div>
            </div>
          </div>
        </TableCell>
        <TableCell>
          <OperationTypeBadge
            type={operation.type}
            operationType={operation.operationType}
            variant="compact"
          />
        </TableCell>
        <TableCell>
          <OperationStatusBadge status={operation.status} variant="compact" />
        </TableCell>
        <TableCell>
          <ProgressBadge progress={operation.progress} variant="compact" />
        </TableCell>
        <TableCell className="text-sm">
          {formatDateTime(operation.startedAt, { showSeconds: false })}
        </TableCell>
        <TableCell className="text-sm">
          {formatDuration(operation.startedAt, operation.completedAt)}
        </TableCell>
        <TableCell className="text-sm">
          {operation.type === "backup" && operation.sizeBytes
            ? formatBytes(operation.sizeBytes)
            : "-"}
        </TableCell>
      </TableRow>
      <TableRow>
        <TableCell colSpan={7} className="p-0">
          <Collapsible open={isOpen} onOpenChange={setIsOpen}>
            <CollapsibleContent className="px-4 pb-4">
              <div className="bg-muted rounded-lg p-4 space-y-3">
                <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
                  <div>
                    <span className="font-medium text-muted-foreground">
                      Operation ID:
                    </span>
                    <div className="font-mono text-xs mt-1">{operation.id}</div>
                  </div>
                  <div>
                    <span className="font-medium text-muted-foreground">
                      Database ID:
                    </span>
                    <div className="font-mono text-xs mt-1">
                      {operation.databaseId}
                    </div>
                  </div>
                  <div>
                    <span className="font-medium text-muted-foreground">
                      Started At:
                    </span>
                    <div className="mt-1">
                      {formatDateTime(operation.startedAt)}
                    </div>
                  </div>
                  {operation.completedAt && (
                    <div>
                      <span className="font-medium text-muted-foreground">
                        Completed At:
                      </span>
                      <div className="mt-1">
                        {formatDateTime(operation.completedAt)}
                      </div>
                    </div>
                  )}
                  {operation.type === "backup" && operation.sizeBytes && (
                    <div>
                      <span className="font-medium text-muted-foreground">
                        Backup Size:
                      </span>
                      <div className="mt-1">
                        {formatBytes(operation.sizeBytes)}
                      </div>
                    </div>
                  )}
                  {operation.backupUrl && (
                    <div>
                      <span className="font-medium text-muted-foreground">
                        Backup URL:
                      </span>
                      <div className="font-mono text-xs mt-1 break-all">
                        {operation.backupUrl}
                      </div>
                    </div>
                  )}
                </div>

                {operation.errorMessage && (
                  <Alert variant="destructive">
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription className="text-sm">
                      <span className="font-medium">Error:</span>{" "}
                      {operation.errorMessage}
                    </AlertDescription>
                  </Alert>
                )}
              </div>
            </CollapsibleContent>
          </Collapsible>
        </TableCell>
      </TableRow>
    </>
  );
}

export function OperationHistoryList({
  databaseId,
  maxHeight = "600px",
  className,
}: OperationHistoryListProps) {
  const { filters, updateFilter, resetFilters } = useOperationHistoryFilters();
  const [showFilters, setShowFilters] = useState(false);

  // Set database filter if provided
  const effectiveFilters = databaseId ? { ...filters, databaseId } : filters;

  const {
    data: historyResponse,
    isLoading,
    error,
    refetch,
  } = useOperationHistory({
    filters: effectiveFilters,
  });

  const history = historyResponse?.data || [];
  const pagination = historyResponse?.pagination;

  const handleLoadMore = () => {
    if (pagination?.hasMore) {
      updateFilter(
        "offset",
        (pagination.offset || 0) + (pagination.limit || 20),
      );
    }
  };

  const handleRefresh = () => {
    refetch();
  };

  return (
    <Card className={className}>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <History className="w-5 h-5" />
            <div>
              <CardTitle className="text-lg">Operation History</CardTitle>
              <CardDescription>
                {databaseId
                  ? "Recent backup and restore operations for this database"
                  : "Recent backup and restore operations across all databases"}
              </CardDescription>
            </div>
          </div>
          <div className="flex items-center space-x-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowFilters(!showFilters)}
            >
              <Filter className="w-4 h-4 mr-2" />
              Filters
            </Button>
            <Button variant="outline" size="sm" onClick={handleRefresh}>
              <RefreshCw className="w-4 h-4 mr-2" />
              Refresh
            </Button>
          </div>
        </div>

        {/* Filters */}
        <Collapsible open={showFilters} onOpenChange={setShowFilters}>
          <CollapsibleContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4 p-4 bg-muted rounded-lg">
              <div>
                <label className="text-sm font-medium mb-2 block">
                  Operation Type
                </label>
                <Select
                  value={filters.operationType}
                  onValueChange={(value) =>
                    updateFilter("operationType", value)
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="All types" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Types</SelectItem>
                    <SelectItem value="backup">Backup</SelectItem>
                    <SelectItem value="restore">Restore</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div>
                <label className="text-sm font-medium mb-2 block">Status</label>
                <Select
                  value={filters.status}
                  onValueChange={(value) => updateFilter("status", value)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="All statuses" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Statuses</SelectItem>
                    <SelectItem value="pending">Pending</SelectItem>
                    <SelectItem value="running">Running</SelectItem>
                    <SelectItem value="completed">Completed</SelectItem>
                    <SelectItem value="failed">Failed</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div>
                <label className="text-sm font-medium mb-2 block">
                  Items per page
                </label>
                <Select
                  value={filters.limit?.toString()}
                  onValueChange={(value) =>
                    updateFilter("limit", parseInt(value))
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="20" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="10">10</SelectItem>
                    <SelectItem value="20">20</SelectItem>
                    <SelectItem value="50">50</SelectItem>
                    <SelectItem value="100">100</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex items-end">
                <Button
                  variant="outline"
                  onClick={resetFilters}
                  className="w-full"
                >
                  Reset Filters
                </Button>
              </div>
            </div>
          </CollapsibleContent>
        </Collapsible>
      </CardHeader>

      <CardContent>
        {error && (
          <Alert variant="destructive" className="mb-4">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              Failed to load operation history: {error.message}
            </AlertDescription>
          </Alert>
        )}

        <div style={{ maxHeight }} className="overflow-y-auto">
          {isLoading ? (
            <div className="space-y-2">
              {[...Array(5)].map((_, i) => (
                <div
                  key={i}
                  className="flex items-center space-x-4 p-4 border rounded"
                >
                  <Skeleton className="h-6 w-6" />
                  <Skeleton className="h-4 w-[150px]" />
                  <Skeleton className="h-4 w-[100px]" />
                  <Skeleton className="h-4 w-[80px]" />
                  <Skeleton className="h-4 w-[120px]" />
                  <Skeleton className="h-4 w-[80px]" />
                  <Skeleton className="h-4 w-[100px]" />
                </div>
              ))}
            </div>
          ) : history.length === 0 ? (
            <div className="text-center py-12">
              <Database className="w-12 h-12 mx-auto mb-4 text-muted-foreground" />
              <h3 className="text-lg font-semibold mb-2">
                No operations found
              </h3>
              <p className="text-muted-foreground">
                {databaseId
                  ? "No backup or restore operations have been performed for this database yet."
                  : "No backup or restore operations have been performed yet."}
              </p>
            </div>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Database</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Progress</TableHead>
                    <TableHead>Started</TableHead>
                    <TableHead>Duration</TableHead>
                    <TableHead>Size</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {history.map((operation) => (
                    <OperationDetailsRow
                      key={operation.id}
                      operation={operation}
                    />
                  ))}
                </TableBody>
              </Table>

              {/* Pagination */}
              {pagination && (
                <div className="flex items-center justify-between mt-4 pt-4 border-t">
                  <div className="text-sm text-muted-foreground">
                    Showing {(pagination.offset || 0) + 1} to{" "}
                    {Math.min(
                      (pagination.offset || 0) + history.length,
                      pagination.totalCount || 0,
                    )}{" "}
                    of {pagination.totalCount || 0} operations
                  </div>
                  {pagination.hasMore && (
                    <Button variant="outline" onClick={handleLoadMore}>
                      Load More
                    </Button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
