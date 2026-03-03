import { useQuery } from "@tanstack/react-query";
import { useState, useCallback } from "react";
import {
  DeploymentInfo,
  DeploymentListResponse,
  DeploymentFilter,
  DeploymentSortOptions,
  DeploymentStatus,
  DeploymentTriggerType,
} from "@mini-infra/types";

// Generate correlation ID for debugging
function generateCorrelationId(): string {
  return `deployment-history-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// ====================
// Deployment History API Functions
// ====================

async function fetchDeploymentHistory(
  filters: DeploymentFilter = {},
  page = 1,
  limit = 20,
  sortBy: keyof DeploymentInfo = "startedAt",
  sortOrder: "asc" | "desc" = "desc", // Default to newest first
  correlationId: string,
): Promise<DeploymentListResponse> {
  const url = new URL(`/api/deployments/history`, window.location.origin);

  // Add query parameters
  url.searchParams.set("page", page.toString());
  url.searchParams.set("limit", limit.toString());
  url.searchParams.set("sortBy", sortBy);
  url.searchParams.set("sortOrder", sortOrder);
  
  if (filters.configurationId) {
    url.searchParams.set("configurationId", filters.configurationId);
  }
  if (filters.status) {
    url.searchParams.set("status", filters.status);
  }
  if (filters.triggerType) {
    url.searchParams.set("triggerType", filters.triggerType);
  }
  if (filters.startDate) {
    url.searchParams.set("startDate", filters.startDate.toISOString());
  }
  if (filters.endDate) {
    url.searchParams.set("endDate", filters.endDate.toISOString());
  }

  const response = await fetch(url.toString(), {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch deployment history: ${response.statusText}`,
    );
  }

  const data: DeploymentListResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to fetch deployment history");
  }

  return data;
}

// ====================
// Deployment History Hooks
// ====================

export interface UseDeploymentHistoryOptions {
  enabled?: boolean;
  refetchInterval?: number;
  retry?: number | boolean | ((failureCount: number, error: Error) => boolean);
  filters?: DeploymentFilter;
  page?: number;
  limit?: number;
  sortBy?: keyof DeploymentInfo;
  sortOrder?: "asc" | "desc";
}

export function useDeploymentHistory(
  options: UseDeploymentHistoryOptions = {},
) {
  const {
    enabled = true,
    refetchInterval,
    retry = 3,
    filters = {},
    page = 1,
    limit = 20,
    sortBy = "startedAt",
    sortOrder = "desc",
  } = options;

  const correlationId = generateCorrelationId();

  return useQuery({
    queryKey: ["deploymentHistory", filters, page, limit, sortBy, sortOrder],
    queryFn: () =>
      fetchDeploymentHistory(
        filters,
        page,
        limit,
        sortBy,
        sortOrder,
        correlationId,
      ),
    enabled,
    refetchInterval,
    retry:
      typeof retry === "function"
        ? retry
        : (failureCount: number, error: Error) => {
            // Don't retry on authentication errors
            if (
              error.message.includes("401") ||
              error.message.includes("Unauthorized")
            ) {
              return false;
            }
            // Retry up to the specified number of times for other errors
            return typeof retry === "boolean" ? retry : failureCount < retry;
          },
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000), // Exponential backoff with max 30s
    staleTime: 30000, // Data is fresh for 30 seconds (less frequent updates for history)
    gcTime: 10 * 60 * 1000, // Keep in cache for 10 minutes
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

/**
 * Hook for fetching deployment history for a specific configuration
 */
export function useConfigurationDeploymentHistory(
  configurationId: string,
  options: Omit<UseDeploymentHistoryOptions, 'filters'> = {},
) {
  return useDeploymentHistory({
    ...options,
    filters: { configurationId },
  });
}

/**
 * Hook for fetching recent deployments (last 24 hours)
 */
export function useRecentDeployments(
  options: Omit<UseDeploymentHistoryOptions, 'filters'> = {},
) {
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 1); // Last 24 hours

  return useDeploymentHistory({
    ...options,
    filters: { startDate, endDate },
  });
}

/**
 * Hook for fetching active/running deployments
 */
export function useActiveDeployments(
  options: Omit<UseDeploymentHistoryOptions, 'filters'> = {},
) {
  const activeStatuses: DeploymentStatus[] = [
    "pending",
    "preparing", 
    "deploying",
    "health_checking",
    "switching_traffic",
    "cleanup",
    "rolling_back",
  ];

  // For active deployments, we want more frequent updates
  const { refetchInterval = 5000, ...restOptions } = options;

  return useQuery({
    queryKey: ["activeDeployments"],
    queryFn: async () => {
      const correlationId = generateCorrelationId();
      
      // Fetch all active deployments by querying with no specific status
      // and filtering on the frontend
      const data = await fetchDeploymentHistory(
        {},
        1,
        100, // Get more results to ensure we capture all active ones
        "startedAt",
        "desc",
        correlationId,
      );

      // Filter to only active deployments
      const activeDeployments = data.data.filter(deployment =>
        activeStatuses.includes(deployment.status as DeploymentStatus)
      );

      return {
        ...data,
        data: activeDeployments,
      };
    },
    enabled: restOptions.enabled !== false,
    refetchInterval,
    retry: restOptions.retry ?? 3,
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),
    staleTime: 2000, // Very fresh data for active deployments
    gcTime: 5 * 60 * 1000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

/**
 * Hook for fetching the latest deployment for each configuration
 * This includes all deployments (active, completed, failed) to show the most recent status
 */
export function useLatestDeployments(
  options: Omit<UseDeploymentHistoryOptions, 'filters'> = {},
) {
  // For latest deployments, we want moderate refresh rate
  const { refetchInterval = 15000, ...restOptions } = options;

  return useQuery({
    queryKey: ["latestDeployments"],
    queryFn: async () => {
      const correlationId = generateCorrelationId();
      
      // Fetch recent deployments (more than we need to ensure we get latest for each config)
      const data = await fetchDeploymentHistory(
        {},
        1,
        100, // Get enough results to capture latest for each configuration
        "startedAt",
        "desc",
        correlationId,
      );

      // Create map of latest deployment per configuration
      const latestByConfig = new Map<string, DeploymentInfo>();
      
      data.data.forEach(deployment => {
        const configId = deployment.configurationId;
        const existing = latestByConfig.get(configId);
        
        if (!existing || new Date(deployment.startedAt) > new Date(existing.startedAt)) {
          latestByConfig.set(configId, deployment);
        }
      });

      return {
        success: true,
        data: Array.from(latestByConfig.values()),
        pagination: data.pagination,
      };
    },
    enabled: restOptions.enabled !== false,
    refetchInterval,
    retry: restOptions.retry ?? 3,
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),
    staleTime: 10000, // Data is fresh for 10 seconds
    gcTime: 5 * 60 * 1000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

// ====================
// Deployment History Filter Hook
// ====================

export interface DeploymentHistoryFiltersState {
  configurationId?: string;
  status?: DeploymentStatus;
  triggerType?: DeploymentTriggerType;
  startDate?: Date;
  endDate?: Date;
  sortBy: keyof DeploymentInfo;
  sortOrder: "asc" | "desc";
  page: number;
  limit: number;
}

export function useDeploymentHistoryFilters(
  initialFilters: Partial<DeploymentHistoryFiltersState> = {},
) {
  const [filters, setFilters] = useState<DeploymentHistoryFiltersState>({
    sortBy: "startedAt",
    sortOrder: "desc",
    page: 1,
    limit: 20,
    ...initialFilters,
  });

  const updateFilter = useCallback(
    <K extends keyof DeploymentHistoryFiltersState>(
      key: K,
      value: DeploymentHistoryFiltersState[K],
    ) => {
      setFilters((prev) => ({
        ...prev,
        [key]: value,
        // Reset to first page when filters change (except when updating page itself)
        page: key === "page" ? (value as number) : 1,
      }));
    },
    [],
  );

  const resetFilters = useCallback(() => {
    setFilters({
      sortBy: "startedAt",
      sortOrder: "desc",
      page: 1,
      limit: 20,
      ...initialFilters,
    });
  }, [initialFilters]);

  // Convenience methods for common filter operations
  const setDateRange = useCallback((startDate: Date | undefined, endDate: Date | undefined) => {
    setFilters((prev) => ({
      ...prev,
      startDate,
      endDate,
      page: 1, // Reset to first page
    }));
  }, []);

  const setConfigurationFilter = useCallback((configurationId: string | undefined) => {
    setFilters((prev) => ({
      ...prev,
      configurationId,
      page: 1, // Reset to first page
    }));
  }, []);

  const setStatusFilter = useCallback((status: DeploymentStatus | undefined) => {
    setFilters((prev) => ({
      ...prev,
      status,
      page: 1, // Reset to first page
    }));
  }, []);

  return {
    filters,
    updateFilter,
    resetFilters,
    setDateRange,
    setConfigurationFilter,
    setStatusFilter,
  };
}

// ====================
// Utility Functions
// ====================

/**
 * Get deployment duration in human-readable format
 */
export function formatDeploymentDuration(deploymentTime: number | null): string {
  if (!deploymentTime) return "N/A";
  
  if (deploymentTime < 60) {
    return `${deploymentTime}s`;
  } else if (deploymentTime < 3600) {
    const minutes = Math.floor(deploymentTime / 60);
    const seconds = deploymentTime % 60;
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  } else {
    const hours = Math.floor(deploymentTime / 3600);
    const minutes = Math.floor((deploymentTime % 3600) / 60);
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
}

/**
 * Get downtime in human-readable format
 */
export function formatDowntime(downtime: number): string {
  if (downtime === 0) return "0ms";
  
  if (downtime < 1000) {
    return `${downtime}ms`;
  } else if (downtime < 60000) {
    const seconds = Math.floor(downtime / 1000);
    const ms = downtime % 1000;
    return ms > 0 ? `${seconds}.${Math.floor(ms / 100)}s` : `${seconds}s`;
  } else {
    const minutes = Math.floor(downtime / 60000);
    const seconds = Math.floor((downtime % 60000) / 1000);
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
}

// ====================
// Type Exports
// ====================

export type {
  DeploymentInfo,
  DeploymentListResponse,
  DeploymentFilter,
  DeploymentSortOptions,
  DeploymentStatus,
  DeploymentTriggerType,
};