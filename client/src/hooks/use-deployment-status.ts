import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DeploymentStatus,
  DeploymentStepInfo,
  Channel,
  ServerEvent,
  ParameterizedChannel,
} from "@mini-infra/types";
import { useSocket, useSocketChannel, useSocketEvent } from "./use-socket";

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
    containers?: Array<{
      id: string;
      deploymentId: string;
      containerId: string;
      containerName: string;
      containerRole: string;
      dockerImage: string;
      imageId: string | null;
      status: string;
      ipAddress: string | null;
      createdAt: string;
      startedAt: string | null;
      capturedAt: string;
    }>;
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

const POLL_INTERVAL_DISCONNECTED = 5000; // 5s fallback when socket not connected

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
 * Hook for fetching deployment status with real-time Socket.IO updates.
 * Socket events update the TanStack Query cache directly; polling is only
 * used as a fallback when the socket is disconnected.
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

  const queryClient = useQueryClient();
  const { connected } = useSocket();

  const correlationId = generateCorrelationId();

  // Subscribe to the deployment-specific channel for push updates
  useSocketChannel(
    deploymentId ? ParameterizedChannel.deployment(deploymentId) : undefined,
    enabled && !!deploymentId,
  );

  // When server pushes a status change, invalidate so TanStack Query refetches
  useSocketEvent(
    ServerEvent.DEPLOYMENT_STATUS,
    (data) => {
      if (data.id === deploymentId) {
        queryClient.invalidateQueries({ queryKey: ["deploymentStatus", deploymentId] });
      }
    },
    enabled && !!deploymentId,
  );

  // When deployment completes, invalidate to get final data
  useSocketEvent(
    ServerEvent.DEPLOYMENT_COMPLETED,
    (data) => {
      if (data.id === deploymentId) {
        queryClient.invalidateQueries({ queryKey: ["deploymentStatus", deploymentId] });
      }
    },
    enabled && !!deploymentId,
  );

  // No polling when socket is connected; fall back to adaptive polling when disconnected
  const refetchInterval =
    options.refetchInterval ??
    (connected
      ? false
      : (query: any) => {
          if (!query?.state?.data?.data) return POLL_INTERVAL_DISCONNECTED;

          const status = query.state.data.data.status;
          const terminalStates: DeploymentStatus[] = ["completed", "failed", "rolledback"];

          if (stopPollingOnTerminal && terminalStates.includes(status)) {
            return false;
          }

          const activeStates: DeploymentStatus[] = [
            "preparing", "deploying", "health_checking",
            "switching_traffic", "cleanup", "rolling_back",
          ];

          if (activeStates.includes(status)) return 2000;
          if (status === "pending") return 5000;
          return 10000;
        });

  return useQuery({
    queryKey: ["deploymentStatus", deploymentId],
    queryFn: () => fetchDeploymentStatus(deploymentId, correlationId),
    enabled: enabled && !!deploymentId,
    refetchInterval,
    retry:
      typeof retry === "function"
        ? retry
        : (failureCount: number, error: Error) => {
            if (
              error.message.includes("401") ||
              error.message.includes("Unauthorized")
            ) {
              return false;
            }
            if (
              error.message.includes("404") ||
              error.message.includes("Not found")
            ) {
              return false;
            }
            return typeof retry === "boolean" ? retry : failureCount < retry;
          },
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),
    staleTime: 1000,
    gcTime: 10 * 60 * 1000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

/**
 * Hook for monitoring multiple deployment statuses.
 * Subscribes to the global deployments channel and invalidates when any
 * tracked deployment status changes.
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

  const queryClient = useQueryClient();
  const { connected } = useSocket();
  const correlationId = generateCorrelationId();

  // Subscribe to the global deployments channel
  useSocketChannel(Channel.DEPLOYMENTS, enabled && deploymentIds.length > 0);

  // When any deployment status changes, invalidate if it's one we're tracking
  useSocketEvent(
    ServerEvent.DEPLOYMENT_STATUS,
    (data) => {
      if (deploymentIds.includes(data.id)) {
        queryClient.invalidateQueries({ queryKey: ["deploymentStatuses", deploymentIds] });
      }
    },
    enabled && deploymentIds.length > 0,
  );

  useSocketEvent(
    ServerEvent.DEPLOYMENT_COMPLETED,
    (data) => {
      if (deploymentIds.includes(data.id)) {
        queryClient.invalidateQueries({ queryKey: ["deploymentStatuses", deploymentIds] });
      }
    },
    enabled && deploymentIds.length > 0,
  );

  const refetchInterval =
    options.refetchInterval ??
    (connected
      ? false
      : (query: any) => {
          if (!query?.state?.data) return POLL_INTERVAL_DISCONNECTED;

          const statuses = query.state.data.map((d: DeploymentStatusResponse) => d.data.status);
          const terminalStates: DeploymentStatus[] = ["completed", "failed", "rolledback"];
          const activeStates: DeploymentStatus[] = [
            "preparing", "deploying", "health_checking",
            "switching_traffic", "cleanup", "rolling_back",
          ];

          const allTerminal = stopPollingOnTerminal && statuses.every((status: DeploymentStatus) =>
            terminalStates.includes(status)
          );
          if (allTerminal) return false;

          const hasActive = statuses.some((status: DeploymentStatus) => activeStates.includes(status));
          if (hasActive) return 2000;

          const hasPending = statuses.some((status: DeploymentStatus) => status === "pending");
          if (hasPending) return 5000;

          return 10000;
        });

  return useQuery({
    queryKey: ["deploymentStatuses", deploymentIds],
    queryFn: async () => {
      const promises = deploymentIds.map(id =>
        fetchDeploymentStatus(id, correlationId)
      );
      return Promise.all(promises);
    },
    enabled: enabled && deploymentIds.length > 0,
    refetchInterval,
    retry:
      typeof retry === "function"
        ? retry
        : (failureCount: number, error: Error) => {
            if (
              error.message.includes("401") ||
              error.message.includes("Unauthorized")
            ) {
              return false;
            }
            return typeof retry === "boolean" ? retry : failureCount < retry;
          },
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),
    staleTime: 1000,
    gcTime: 10 * 60 * 1000,
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
    rolledback: "Rolled Back",
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
    rolledback: "text-orange-600",
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