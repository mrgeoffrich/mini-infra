import { useState, useCallback } from "react";
import { formatDistanceToNow, format } from "date-fns";
import {
  IconRefresh,
  IconCircleCheck,
  IconAlertCircle,
  IconHistory,
  IconCalendar,
  IconServer,
  IconBolt,
  IconChartBar,
  IconActivity,
} from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Progress } from "@/components/ui/progress";
import {
  ConnectivityStatusInfo,
  ConnectivityStatusType,
} from "@mini-infra/types";
import {
  StatusBadge,
  StatusDot,
  ServiceStatusCard,
} from "@/components/connectivity-status";
import {
  useAzureConnectivityStatus,
  useAzureConnectivityHistory,
  useAzureConnectivityFilters,
} from "@/hooks/use-azure-settings";

// ====================
// Response Time Chart Component
// ====================

interface ResponseTimeChartProps {
  history?: ConnectivityStatusInfo[];
  isLoading?: boolean;
}

function ResponseTimeChart({ history, isLoading }: ResponseTimeChartProps) {
  if (isLoading || !history || history.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <IconChartBar className="h-4 w-4" />
            Response Time Trend
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No response time data available
            </p>
          )}
        </CardContent>
      </Card>
    );
  }

  // Get successful connections with response times
  const successfulConnections = history
    .filter((status) => status.status === "connected" && status.responseTimeMs)
    .slice(0, 10)
    .reverse(); // Show most recent first

  if (successfulConnections.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <IconChartBar className="h-4 w-4" />
            Response Time Trend
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            No successful connections to display response times
          </p>
        </CardContent>
      </Card>
    );
  }

  const maxResponseTime = Math.max(
    ...successfulConnections.map((s) => s.responseTimeMs || 0),
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <IconChartBar className="h-4 w-4" />
          Response Time Trend
        </CardTitle>
        <CardDescription>
          Last {successfulConnections.length} successful connections
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {successfulConnections.map((status) => (
          <div key={status.id} className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">
                {formatDistanceToNow(new Date(status.checkedAt), {
                  addSuffix: true,
                })}
              </span>
              <span className="font-medium">
                {status.responseTimeMs! < 1000
                  ? `${status.responseTimeMs}ms`
                  : `${(status.responseTimeMs! / 1000).toFixed(1)}s`}
              </span>
            </div>
            <Progress
              value={(status.responseTimeMs! / maxResponseTime) * 100}
              className="h-2"
            />
          </div>
        ))}
        <div className="text-xs text-muted-foreground mt-3 pt-2 border-t">
          Average:{" "}
          {Math.round(
            successfulConnections.reduce(
              (sum, s) => sum + (s.responseTimeMs || 0),
              0,
            ) / successfulConnections.length,
          )}
          ms
        </div>
      </CardContent>
    </Card>
  );
}

// ====================
// Status History Timeline Component
// ====================

interface StatusHistoryTimelineProps {
  isLoading?: boolean;
  onRefresh?: () => void;
}

function StatusHistoryTimeline({
  isLoading,
  onRefresh,
}: StatusHistoryTimelineProps) {
  const { filters, updateFilter } = useAzureConnectivityFilters({
    limit: 10,
  });

  const {
    data: historyData,
    isLoading: historyLoading,
    refetch: refetchHistory,
  } = useAzureConnectivityHistory({
    ...filters,
    enabled: true,
  });

  const historyItems = historyData?.data || [];
  const loading = isLoading || historyLoading;

  const handleRefresh = useCallback(() => {
    refetchHistory();
    if (onRefresh) onRefresh();
  }, [refetchHistory, onRefresh]);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <IconHistory className="h-4 w-4" />
              Connection History
            </CardTitle>
            <CardDescription>Recent connectivity checks</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Select
              value={filters.limit.toString()}
              onValueChange={(value) => updateFilter("limit", parseInt(value))}
            >
              <SelectTrigger className="w-20">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="5">5</SelectItem>
                <SelectItem value="10">10</SelectItem>
                <SelectItem value="20">20</SelectItem>
                <SelectItem value="50">50</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="ghost" size="sm" onClick={handleRefresh}>
              <IconRefresh className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-3">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="h-3 w-3 rounded-full" />
                <div className="flex-1 space-y-1">
                  <Skeleton className="h-3 w-full" />
                  <Skeleton className="h-2 w-1/2" />
                </div>
              </div>
            ))}
          </div>
        ) : historyItems.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No connectivity history available
          </p>
        ) : (
          <div className="space-y-4">
            {historyItems.map((status, index) => {
              const isLatest = index === 0;
              return (
                <div key={status.id} className="flex items-start gap-3">
                  <div className="relative">
                    <StatusDot
                      status={status.status as ConnectivityStatusType}
                      pulse={isLatest}
                    />
                    {index < historyItems.length - 1 && (
                      <div className="absolute top-3 left-1/2 w-px h-8 bg-border transform -translate-x-1/2" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0 pb-4">
                    <div className="flex items-center gap-2 mb-1">
                      <StatusBadge
                        status={status.status as ConnectivityStatusType}
                        responseTimeMs={status.responseTimeMs}
                        size="sm"
                      />
                      {isLatest && (
                        <Badge variant="outline" className="text-xs">
                          Latest
                        </Badge>
                      )}
                    </div>
                    <div className="text-sm text-muted-foreground">
                      {format(new Date(status.checkedAt), "PPp")}
                      {status.checkInitiatedBy !== "system" && (
                        <span className="ml-2">
                          • Manual check by {status.checkInitiatedBy}
                        </span>
                      )}
                    </div>
                    {status.errorMessage && (
                      <div className="text-sm text-red-600 mt-1">
                        {status.errorMessage}
                        {status.errorCode && (
                          <span className="text-xs text-red-500 ml-2">
                            ({status.errorCode})
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ====================
// Main Azure Connectivity Status Component
// ====================

export interface AzureConnectivityStatusProps {
  /**
   * Auto-refresh interval in milliseconds (default: 30000ms = 30s)
   */
  refreshInterval?: number;
  /**
   * Show response time chart (default: true)
   */
  showResponseTimeChart?: boolean;
  /**
   * Show status history timeline (default: true)
   */
  showHistoryTimeline?: boolean;
  /**
   * Custom CSS class for the container
   */
  className?: string;
}

export function AzureConnectivityStatus({
  refreshInterval = 30000,
  showResponseTimeChart = true,
  showHistoryTimeline = true,
  className,
}: AzureConnectivityStatusProps) {
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Fetch current Azure connectivity status with auto-refresh
  const {
    data: currentStatus,
    isLoading: statusLoading,
    refetch: refetchStatus,
  } = useAzureConnectivityStatus({
    enabled: true,
    refetchInterval: refreshInterval,
  });

  // Fetch recent history for charts
  const {
    data: historyData,
    isLoading: historyLoading,
    refetch: refetchHistory,
  } = useAzureConnectivityHistory({
    enabled: showResponseTimeChart || showHistoryTimeline,
    limit: showResponseTimeChart ? 50 : 20,
  });

  const history = historyData?.data || [];

  const handleRefresh = useCallback(async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    try {
      await Promise.all([refetchStatus(), refetchHistory()]);
    } finally {
      setIsRefreshing(false);
    }
  }, [isRefreshing, refetchStatus, refetchHistory]);

  // Parse metadata if available
  const metadata = currentStatus?.metadata
    ? JSON.parse(currentStatus.metadata)
    : null;

  return (
    <TooltipProvider>
      <div className={cn("space-y-6", className)}>
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-md bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300">
              <IconActivity className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-xl font-semibold">
                Azure Connectivity Status
              </h2>
              <p className="text-sm text-muted-foreground">
                Real-time Azure Storage connectivity monitoring
              </p>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={isRefreshing}
          >
            <IconRefresh
              className={cn("h-4 w-4 mr-2", isRefreshing && "animate-spin")}
            />
            Refresh All
          </Button>
        </div>

        {/* Current Status Card */}
        <ServiceStatusCard
          service="azure"
          status={currentStatus}
          isLoading={statusLoading}
          showRefreshButton={true}
          onRefresh={handleRefresh}
        />

        {/* Status Details Grid */}
        {currentStatus && (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            {/* Last Successful Connection */}
            {currentStatus.lastSuccessfulAt && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <IconCircleCheck className="h-4 w-4 text-green-600" />
                    Last Success
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div className="text-sm font-medium">
                        {formatDistanceToNow(
                          new Date(currentStatus.lastSuccessfulAt),
                          { addSuffix: true },
                        )}
                      </div>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>
                        {format(
                          new Date(currentStatus.lastSuccessfulAt),
                          "PPpp",
                        )}
                      </p>
                    </TooltipContent>
                  </Tooltip>
                  <p className="text-xs text-muted-foreground mt-1">
                    Connection established
                  </p>
                </CardContent>
              </Card>
            )}

            {/* Response Time */}
            {currentStatus.responseTimeMs && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <IconBolt className="h-4 w-4 text-blue-600" />
                    Response Time
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-sm font-medium">
                    {currentStatus.responseTimeMs < 1000
                      ? `${currentStatus.responseTimeMs}ms`
                      : `${(currentStatus.responseTimeMs / 1000).toFixed(1)}s`}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    Latest check
                  </p>
                </CardContent>
              </Card>
            )}

            {/* Storage Account */}
            {metadata?.accountName && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <IconServer className="h-4 w-4 text-purple-600" />
                    Storage Account
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-sm font-medium">
                    {metadata.accountName}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    {metadata.skuName || "Standard Storage"}
                  </p>
                </CardContent>
              </Card>
            )}

            {/* Check Frequency */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <IconCalendar className="h-4 w-4 text-orange-600" />
                  Check Interval
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-sm font-medium">
                  {Math.round(refreshInterval / 1000)}s
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  Auto-refresh rate
                </p>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Charts and Timeline */}
        <div className="grid gap-6 lg:grid-cols-2">
          {/* Response Time Chart */}
          {showResponseTimeChart && (
            <ResponseTimeChart history={history} isLoading={historyLoading} />
          )}

          {/* Status History Timeline */}
          {showHistoryTimeline && (
            <StatusHistoryTimeline
              isLoading={historyLoading}
              onRefresh={handleRefresh}
            />
          )}
        </div>

        {/* Error Details */}
        {currentStatus?.errorMessage &&
          currentStatus.status !== "connected" && (
            <Card className="border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950">
              <CardHeader>
                <CardTitle className="text-sm font-medium flex items-center gap-2 text-red-800 dark:text-red-200">
                  <IconAlertCircle className="h-4 w-4" />
                  Connection Error Details
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-sm text-red-700 dark:text-red-300">
                  {currentStatus.errorMessage}
                </div>
                {currentStatus.errorCode && (
                  <div className="text-xs text-red-600 dark:text-red-400 mt-2">
                    Error Code: {currentStatus.errorCode}
                  </div>
                )}
                <div className="text-xs text-red-600 dark:text-red-400 mt-2">
                  Last checked:{" "}
                  {format(new Date(currentStatus.checkedAt), "PPpp")}
                </div>
              </CardContent>
            </Card>
          )}

        {/* Auto-refresh indicator */}
        <div className="text-xs text-muted-foreground text-center">
          Auto-refreshing every {Math.round(refreshInterval / 1000)} seconds •
          Last updated:{" "}
          {currentStatus
            ? formatDistanceToNow(new Date(currentStatus.checkedAt), {
                addSuffix: true,
              })
            : "Never"}
        </div>
      </div>
    </TooltipProvider>
  );
}
