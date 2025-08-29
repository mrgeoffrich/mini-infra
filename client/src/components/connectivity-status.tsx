import React, { useState, useCallback } from "react";
import {
  RefreshCcw,
  CheckCircle,
  XCircle,
  Clock,
  AlertCircle,
} from "lucide-react";
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
  ConnectivityStatusInfo,
  ConnectivityService,
  ConnectivityStatusType,
} from "@mini-infra/types";
import {
  useServiceConnectivity,
  useValidateService,
} from "@/hooks/use-settings-validation";
import { formatDistanceToNow } from "date-fns";

// ====================
// Status Badge Component
// ====================

interface StatusBadgeProps {
  status: ConnectivityStatusType;
  responseTimeMs?: number | null;
  size?: "sm" | "md" | "lg";
  showResponseTime?: boolean;
}

const statusConfig = {
  connected: {
    label: "Connected",
    icon: CheckCircle,
    variant: "default" as const,
    className:
      "bg-green-100 text-green-800 border-green-200 hover:bg-green-100",
  },
  failed: {
    label: "Failed",
    icon: XCircle,
    variant: "destructive" as const,
    className: "bg-red-100 text-red-800 border-red-200 hover:bg-red-100",
  },
  timeout: {
    label: "Timeout",
    icon: Clock,
    variant: "secondary" as const,
    className:
      "bg-yellow-100 text-yellow-800 border-yellow-200 hover:bg-yellow-100",
  },
  unreachable: {
    label: "Unreachable",
    icon: AlertCircle,
    variant: "outline" as const,
    className: "bg-gray-100 text-gray-800 border-gray-200 hover:bg-gray-100",
  },
} as const;

export function StatusBadge({
  status,
  responseTimeMs,
  size = "md",
  showResponseTime = true,
}: StatusBadgeProps) {
  const config = statusConfig[status];
  const Icon = config.icon;

  const sizeClasses = {
    sm: "text-xs px-2 py-1",
    md: "text-sm px-2.5 py-1.5",
    lg: "text-base px-3 py-2",
  };

  const iconSizes = {
    sm: "h-3 w-3",
    md: "h-4 w-4",
    lg: "h-5 w-5",
  };

  const formatResponseTime = (ms: number | null | undefined): string => {
    if (!ms) return "";
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  return (
    <Badge
      variant={config.variant}
      className={cn(
        config.className,
        sizeClasses[size],
        "inline-flex items-center gap-1.5",
      )}
    >
      <Icon className={iconSizes[size]} />
      <span>{config.label}</span>
      {showResponseTime && responseTimeMs && status === "connected" && (
        <span className="ml-1 opacity-75">
          ({formatResponseTime(responseTimeMs)})
        </span>
      )}
    </Badge>
  );
}

// ====================
// Status Indicator Dot Component
// ====================

interface StatusDotProps {
  status: ConnectivityStatusType;
  size?: "sm" | "md" | "lg";
  pulse?: boolean;
}

export function StatusDot({
  status,
  size = "md",
  pulse = false,
}: StatusDotProps) {
  const config = statusConfig[status];

  const dotSizes = {
    sm: "h-2 w-2",
    md: "h-3 w-3",
    lg: "h-4 w-4",
  };

  const colors = {
    connected: "bg-green-500",
    failed: "bg-red-500",
    timeout: "bg-yellow-500",
    unreachable: "bg-gray-500",
  };

  return (
    <div
      className={cn(
        "rounded-full",
        dotSizes[size],
        colors[status],
        pulse && "animate-pulse",
      )}
      aria-label={`Status: ${config.label}`}
    />
  );
}

// ====================
// Service Status Card Component
// ====================

interface ServiceStatusCardProps {
  service: ConnectivityService;
  status?: ConnectivityStatusInfo;
  isLoading?: boolean;
  showRefreshButton?: boolean;
  onRefresh?: () => void;
  className?: string;
}

const serviceLabels = {
  docker: "Docker",
  cloudflare: "Cloudflare",
  azure: "Azure Storage",
} as const;

export function ServiceStatusCard({
  service,
  status,
  isLoading = false,
  showRefreshButton = true,
  onRefresh,
  className,
}: ServiceStatusCardProps) {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const validateService = useValidateService();

  const handleRefresh = useCallback(async () => {
    if (isRefreshing) return;

    setIsRefreshing(true);
    try {
      if (onRefresh) {
        onRefresh();
      } else {
        // Trigger manual validation
        await validateService.mutateAsync({ service });
      }
    } finally {
      setIsRefreshing(false);
    }
  }, [isRefreshing, onRefresh, validateService, service]);

  const formatDate = (dateString: string): string => {
    try {
      const date = new Date(dateString);
      return formatDistanceToNow(date, { addSuffix: true });
    } catch {
      return "Unknown";
    }
  };

  if (isLoading || !status) {
    return (
      <Card className={cn("w-full", className)}>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-3 w-32" />
            </div>
            <Skeleton className="h-8 w-16" />
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex items-center justify-between">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-3 w-16" />
          </div>
          <div className="flex items-center justify-between">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-3 w-12" />
          </div>
        </CardContent>
      </Card>
    );
  }

  const isHealthy = status.status === "connected";
  const hasError = status.errorMessage && status.status !== "connected";

  return (
    <TooltipProvider>
      <Card className={cn("w-full transition-colors", className)}>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <CardTitle className="text-base font-medium flex items-center gap-2">
                <StatusDot status={status.status as ConnectivityStatusType} />
                {serviceLabels[service]}
              </CardTitle>
              <CardDescription className="text-sm">
                Service connectivity status
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <StatusBadge
                status={status.status as ConnectivityStatusType}
                responseTimeMs={status.responseTimeMs}
                size="sm"
              />
              {showRefreshButton && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleRefresh}
                      disabled={isRefreshing}
                      className="h-8 w-8 p-0"
                    >
                      <RefreshCcw
                        className={cn(
                          "h-4 w-4",
                          isRefreshing && "animate-spin",
                        )}
                      />
                      <span className="sr-only">Refresh status</span>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>Check connectivity now</p>
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-muted-foreground">Last Checked:</span>
              <p className="font-medium">{formatDate(status.checkedAt)}</p>
            </div>
            {isHealthy && status.responseTimeMs && (
              <div>
                <span className="text-muted-foreground">Response Time:</span>
                <p className="font-medium text-green-600">
                  {status.responseTimeMs < 1000
                    ? `${status.responseTimeMs}ms`
                    : `${(status.responseTimeMs / 1000).toFixed(1)}s`}
                </p>
              </div>
            )}
            {status.lastSuccessfulAt && (
              <div>
                <span className="text-muted-foreground">Last Success:</span>
                <p className="font-medium">
                  {formatDate(status.lastSuccessfulAt)}
                </p>
              </div>
            )}
          </div>

          {hasError && (
            <div className="rounded-md bg-red-50 border border-red-200 p-3">
              <div className="text-sm">
                <span className="text-red-800 font-medium">Error:</span>
                <p className="text-red-700 mt-1">{status.errorMessage}</p>
                {status.errorCode && (
                  <p className="text-red-600 text-xs mt-1">
                    Code: {status.errorCode}
                  </p>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </TooltipProvider>
  );
}

// ====================
// Compact Status Indicator Component
// ====================

interface CompactStatusProps {
  service: ConnectivityService;
  status?: ConnectivityStatusInfo;
  isLoading?: boolean;
  onClick?: () => void;
  showLabel?: boolean;
}

export function CompactStatus({
  service,
  status,
  isLoading = false,
  onClick,
  showLabel = true,
}: CompactStatusProps) {
  if (isLoading || !status) {
    return (
      <div className="flex items-center gap-2">
        <Skeleton className="h-3 w-3 rounded-full" />
        {showLabel && <Skeleton className="h-4 w-16" />}
      </div>
    );
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className={cn(
              "flex items-center gap-2 text-sm",
              onClick && "cursor-pointer hover:opacity-75 transition-opacity",
            )}
            onClick={onClick}
          >
            <StatusDot status={status.status as ConnectivityStatusType} />
            {showLabel && (
              <span className="font-medium">{serviceLabels[service]}</span>
            )}
            {status.responseTimeMs && status.status === "connected" && (
              <span className="text-xs text-muted-foreground">
                (
                {status.responseTimeMs < 1000
                  ? `${status.responseTimeMs}ms`
                  : `${(status.responseTimeMs / 1000).toFixed(1)}s`}
                )
              </span>
            )}
          </div>
        </TooltipTrigger>
        <TooltipContent>
          <div className="space-y-1 text-sm">
            <p className="font-medium">{serviceLabels[service]}</p>
            <div className="flex items-center gap-2">
              <StatusBadge
                status={status.status as ConnectivityStatusType}
                responseTimeMs={status.responseTimeMs}
                size="sm"
                showResponseTime={false}
              />
              {status.responseTimeMs && status.status === "connected" && (
                <span className="text-xs opacity-75">
                  {status.responseTimeMs < 1000
                    ? `${status.responseTimeMs}ms`
                    : `${(status.responseTimeMs / 1000).toFixed(1)}s`}
                </span>
              )}
            </div>
            {status.errorMessage && status.status !== "connected" && (
              <p className="text-red-400 text-xs max-w-48 break-words">
                {status.errorMessage}
              </p>
            )}
            <p className="text-xs opacity-75">
              Last checked:{" "}
              {formatDistanceToNow(new Date(status.checkedAt), {
                addSuffix: true,
              })}
            </p>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// ====================
// Real-time Status Monitor Component
// ====================

interface StatusMonitorProps {
  service: ConnectivityService;
  pollInterval?: number;
  onStatusChange?: (status: ConnectivityStatusInfo) => void;
  children: (props: {
    status?: ConnectivityStatusInfo;
    isLoading: boolean;
    error?: Error | null;
    refresh: () => void;
    isRefreshing: boolean;
  }) => React.ReactNode;
}

export function StatusMonitor({
  service,
  pollInterval = 30000,
  onStatusChange,
  children,
}: StatusMonitorProps) {
  const {
    data: connectivityData,
    isLoading,
    error,
    refetch,
    isFetching,
  } = useServiceConnectivity(service, {
    enabled: true,
    pollingInterval: pollInterval,
  });

  const latestStatus = connectivityData?.data?.[0];

  // Call status change callback when status changes
  React.useEffect(() => {
    if (latestStatus && onStatusChange) {
      onStatusChange(latestStatus);
    }
  }, [latestStatus, onStatusChange]);

  const refresh = useCallback(() => {
    refetch();
  }, [refetch]);

  return (
    <>
      {children({
        status: latestStatus,
        isLoading,
        error: error as Error | null,
        refresh,
        isRefreshing: isFetching && !isLoading,
      })}
    </>
  );
}

// ====================
// Type Exports
// ====================

export type {
  StatusBadgeProps,
  StatusDotProps,
  ServiceStatusCardProps,
  CompactStatusProps,
  StatusMonitorProps,
};
