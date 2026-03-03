import { useQuery } from "@tanstack/react-query";
import {
  RemovalStatus,
  RemovalOperationResponse,
  RemovalOperationInfo,
} from "@mini-infra/types";

// Generate correlation ID for debugging
function generateCorrelationId(): string {
  return `removal-status-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// ====================
// Removal Status API Functions
// ====================

async function fetchRemovalStatus(
  removalId: string,
  correlationId: string,
): Promise<RemovalOperationResponse> {
  const response = await fetch(`/api/deployments/removal/${removalId}/status`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch removal status: ${response.statusText}`,
    );
  }

  const data: RemovalOperationResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to fetch removal status");
  }

  return data;
}

// ====================
// Removal Status Hooks
// ====================

export interface UseRemovalStatusOptions {
  enabled?: boolean;
  refetchInterval?: number;
  retry?: number | boolean | ((failureCount: number, error: Error) => boolean);
  /**
   * Auto-disable polling when removal reaches a terminal state
   * (completed, failed)
   */
  stopPollingOnTerminal?: boolean;
}

/**
 * Hook for fetching removal operation status with optional real-time polling
 * Automatically adjusts polling behavior based on removal status
 */
export function useRemovalStatus(
  removalId: string,
  options: UseRemovalStatusOptions = {},
) {
  const {
    enabled = true,
    retry = 3,
    stopPollingOnTerminal = true,
  } = options;

  const correlationId = generateCorrelationId();

  return useQuery({
    queryKey: ["removalStatus", removalId],
    queryFn: () => fetchRemovalStatus(removalId, correlationId),
    enabled: enabled && !!removalId,
    // Dynamic refetch interval based on removal status
    refetchInterval: (query) => {
      if (!query?.state?.data?.data) return false;

      const status = query.state.data.data.status;
      const terminalStates: RemovalStatus[] = ["completed", "failed"];

      // Stop polling if removal is in terminal state and option is enabled
      if (stopPollingOnTerminal && terminalStates.includes(status)) {
        return false;
      }

      // More frequent polling for active removals
      const activeStates: RemovalStatus[] = [
        "in_progress",
        "removing_from_lb",
        "stopping_application",
        "removing_application",
        "cleanup",
      ];

      if (activeStates.includes(status)) {
        return 2000; // Poll every 2 seconds during active removal
      }

      return 5000; // Default 5 second polling for other states
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

// ====================
// Utility Functions
// ====================

/**
 * Check if a removal status is in a terminal state
 */
export function isTerminalRemovalStatus(status: RemovalStatus): boolean {
  return ["completed", "failed"].includes(status);
}

/**
 * Check if a removal status is active (in progress)
 */
export function isActiveRemovalStatus(status: RemovalStatus): boolean {
  return [
    "in_progress",
    "removing_from_lb",
    "stopping_application",
    "removing_application",
    "cleanup",
  ].includes(status);
}

/**
 * Get human-readable removal status text
 */
export function getRemovalStatusText(status: RemovalStatus): string {
  const statusMap: Record<RemovalStatus, string> = {
    in_progress: "Starting Removal",
    removing_from_lb: "Removing from Load Balancer",
    stopping_application: "Stopping Application",
    removing_application: "Removing Application",
    cleanup: "Cleaning Up",
    completed: "Completed",
    failed: "Failed",
  };

  return statusMap[status] || status;
}

/**
 * Get removal status color for UI display
 */
export function getRemovalStatusColor(status: RemovalStatus): string {
  const colorMap: Record<RemovalStatus, string> = {
    in_progress: "text-blue-600",
    removing_from_lb: "text-blue-600",
    stopping_application: "text-blue-600",
    removing_application: "text-blue-600",
    cleanup: "text-blue-600",
    completed: "text-green-600",
    failed: "text-red-600",
  };

  return colorMap[status] || "text-gray-600";
}

// ====================
// Type Exports
// ====================

export type {
  RemovalStatus,
  RemovalOperationInfo,
};