import { useQuery } from "@tanstack/react-query";
import {
  DeploymentStatus,
  DeploymentStepInfo,
} from "@mini-infra/types";

// Generate correlation ID for debugging
function generateCorrelationId(): string {
  return `deployment-status-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// ====================
// Deployment Status API Functions
// ====================

export interface DeploymentStatusResponse {
  success: boolean;
  data: {
    id: string;
    status: DeploymentStatus;
    progress: number;
    steps: DeploymentStepInfo[];
    logs: string[];
    errorMessage?: string;
    startedAt: string;
    completedAt: string | null;
  };
  message?: string;
}

async function fetchDeploymentStatus(
  deploymentId: string,
  correlationId: string,
): Promise<DeploymentStatusResponse> {
  const response = await fetch(`/api/deployments/${deploymentId}/status`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch deployment status: ${response.statusText}`,
    );
  }

  const data: DeploymentStatusResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to fetch deployment status");
  }

  return data;
}

// ====================
// Deployment Status Hooks
// ====================

export interface UseDeploymentStatusOptions {
  enabled?: boolean;
  refetchInterval?: number;
  retry?: number | boolean | ((failureCount: number, error: Error) => boolean);
  /**
   * Auto-disable polling when deployment reaches a terminal state
   * (completed, failed, etc.)
   */
  stopPollingOnTerminal?: boolean;
}

/**
 * Hook for fetching deployment status with optional real-time polling
 * Automatically adjusts polling behavior based on deployment status
 */
export function useDeploymentStatus(
  deploymentId: string,
  options: UseDeploymentStatusOptions = {},
) {
  const {
    enabled = true,
    retry = 3,
    stopPollingOnTerminal = true,
  } = options;

  const correlationId = generateCorrelationId();

  return useQuery({
    queryKey: ["deploymentStatus", deploymentId],
    queryFn: () => fetchDeploymentStatus(deploymentId, correlationId),
    enabled: enabled && !!deploymentId,
    // Dynamic refetch interval based on deployment status
    refetchInterval: (query) => {
      if (!query?.state?.data?.data) return false;

      const status = query.state.data.data.status;
      const terminalStates: DeploymentStatus[] = ["completed", "failed"];

      // Stop polling if deployment is in terminal state and option is enabled
      if (stopPollingOnTerminal && terminalStates.includes(status)) {
        return false;
      }

      // More frequent polling for active deployments
      const activeStates: DeploymentStatus[] = [
        "preparing",
        "deploying",
        "health_checking",
        "switching_traffic",
        "cleanup",
        "rolling_back",
      ];

      if (activeStates.includes(status)) {
        return 2000; // Poll every 2 seconds during active deployment
      }

      // Less frequent polling for pending deployments
      if (status === "pending") {
        return 5000; // Poll every 5 seconds for pending
      }

      return 10000; // Default 10 second polling for other states
    },
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
            // Don't retry on not found errors
            if (
              error.message.includes("404") ||
              error.message.includes("Not found")
            ) {
              return false;
            }
            // Retry up to the specified number of times for other errors
            return typeof retry === "boolean" ? retry : failureCount < retry;
          },
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000), // Exponential backoff with max 30s
    staleTime: 1000, // Data is fresh for 1 second (real-time updates)
    gcTime: 10 * 60 * 1000, // Keep in cache for 10 minutes
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

/**
 * Hook for monitoring multiple deployment statuses
 * Useful for dashboard views showing multiple deployments
 */
export function useDeploymentStatuses(
  deploymentIds: string[],
  options: UseDeploymentStatusOptions = {},
) {
  const {
    enabled = true,
    retry = 3,
    stopPollingOnTerminal = true,
  } = options;

  const correlationId = generateCorrelationId();

  return useQuery({
    queryKey: ["deploymentStatuses", deploymentIds],
    queryFn: async () => {
      // Fetch all deployment statuses in parallel
      const promises = deploymentIds.map(id =>
        fetchDeploymentStatus(id, correlationId)
      );
      const results = await Promise.all(promises);
      return results;
    },
    enabled: enabled && deploymentIds.length > 0,
    // Dynamic refetch interval - use shortest interval from all deployments
    refetchInterval: (query) => {
      if (!query?.state?.data) return false;

      const statuses = query.state.data.map((d: DeploymentStatusResponse) => d.data.status);
      const terminalStates: DeploymentStatus[] = ["completed", "failed"];
      const activeStates: DeploymentStatus[] = [
        "preparing",
        "deploying",
        "health_checking",
        "switching_traffic",
        "cleanup",
        "rolling_back",
      ];

      // Stop polling if all deployments are in terminal state and option is enabled
      const allTerminal = stopPollingOnTerminal && statuses.every((status: DeploymentStatus) =>
        terminalStates.includes(status)
      );
      if (allTerminal) return false;

      // Use frequent polling if any deployment is active
      const hasActive = statuses.some((status: DeploymentStatus) => activeStates.includes(status));
      if (hasActive) return 2000; // Poll every 2 seconds

      // Use medium polling if any deployment is pending
      const hasPending = statuses.some((status: DeploymentStatus) => status === "pending");
      if (hasPending) return 5000; // Poll every 5 seconds

      return 10000; // Default 10 second polling
    },
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
    staleTime: 1000, // Data is fresh for 1 second
    gcTime: 10 * 60 * 1000, // Keep in cache for 10 minutes
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

// ====================
// Utility Functions
// ====================

/**
 * Check if a deployment status is in a terminal state
 */
export function isTerminalStatus(status: DeploymentStatus): boolean {
  return ["completed", "failed"].includes(status);
}

/**
 * Check if a deployment status is active (in progress)
 */
export function isActiveStatus(status: DeploymentStatus): boolean {
  return [
    "preparing",
    "deploying",
    "health_checking",
    "switching_traffic",
    "cleanup",
    "rolling_back",
  ].includes(status);
}

/**
 * Get human-readable status text
 */
export function getStatusText(status: DeploymentStatus): string {
  const statusMap: Record<DeploymentStatus, string> = {
    pending: "Pending",
    preparing: "Preparing",
    deploying: "Deploying",
    health_checking: "Health Checking",
    switching_traffic: "Switching Traffic",
    cleanup: "Cleaning Up",
    completed: "Completed",
    failed: "Failed",
    rolling_back: "Rolling Back",
    uninstalling: "Uninstalling",
    removing_from_lb: "Removing from LB",
    stopping_application: "Stopping Application",
    removing_application: "Removing Application",
    uninstalled: "Uninstalled",
  };

  return statusMap[status] || status;
}

/**
 * Get status color for UI display
 */
export function getStatusColor(status: DeploymentStatus): string {
  const colorMap: Record<DeploymentStatus, string> = {
    pending: "text-yellow-600",
    preparing: "text-blue-600",
    deploying: "text-blue-600",
    health_checking: "text-blue-600",
    switching_traffic: "text-blue-600",
    cleanup: "text-blue-600",
    completed: "text-green-600",
    failed: "text-red-600",
    rolling_back: "text-orange-600",
    uninstalling: "text-purple-600",
    removing_from_lb: "text-purple-600",
    stopping_application: "text-purple-600",
    removing_application: "text-purple-600",
    uninstalled: "text-gray-600",
  };
  
  return colorMap[status] || "text-gray-600";
}

// ====================
// Type Exports
// ====================

export type {
  DeploymentStatus,
  DeploymentStepInfo,
};