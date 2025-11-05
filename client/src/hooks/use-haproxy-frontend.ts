import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  HAProxyFrontendInfo,
  HAProxyFrontendResponse,
  HAProxyFrontendListResponse,
  SyncFrontendRequest,
  SyncFrontendResponse,
} from "@mini-infra/types";

// Generate correlation ID for debugging
function generateCorrelationId(): string {
  return `haproxy-frontend-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// ====================
// HAProxy Frontend API Functions
// ====================

async function fetchDeploymentFrontend(
  configId: string,
  correlationId: string,
): Promise<HAProxyFrontendResponse> {
  const response = await fetch(`/api/deployments/configs/${configId}/frontend`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch HAProxy frontend: ${response.statusText}`,
    );
  }

  const data: HAProxyFrontendResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to fetch HAProxy frontend");
  }

  return data;
}

async function fetchAllFrontends(
  correlationId: string,
): Promise<HAProxyFrontendListResponse> {
  const response = await fetch(`/api/haproxy/frontends`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch HAProxy frontends: ${response.statusText}`,
    );
  }

  const data: HAProxyFrontendListResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to fetch HAProxy frontends");
  }

  return data;
}

async function syncDeploymentFrontend(
  configId: string,
  correlationId: string,
): Promise<SyncFrontendResponse> {
  const request: SyncFrontendRequest = {
    deploymentConfigId: configId,
  };

  const response = await fetch(`/api/deployments/configs/${configId}/frontend/sync`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to sync frontend: ${response.statusText}`,
    );
  }

  const data: SyncFrontendResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to sync frontend");
  }

  return data;
}

// ====================
// HAProxy Frontend Hooks
// ====================

export interface UseHAProxyFrontendOptions {
  enabled?: boolean;
  refetchInterval?: number;
  retry?: number | boolean | ((failureCount: number, error: Error) => boolean);
}

export function useDeploymentFrontend(
  configId: string,
  options: UseHAProxyFrontendOptions = {},
) {
  const { enabled = true, refetchInterval, retry = 3 } = options;

  const correlationId = generateCorrelationId();

  return useQuery({
    queryKey: ["deployment-frontend", configId],
    queryFn: () => fetchDeploymentFrontend(configId, correlationId),
    enabled: enabled && !!configId,
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
    staleTime: 5000, // Data is fresh for 5 seconds
    gcTime: 5 * 60 * 1000, // Keep in cache for 5 minutes
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

export function useAllFrontends(
  options: UseHAProxyFrontendOptions = {},
) {
  const { enabled = true, refetchInterval, retry = 3 } = options;

  const correlationId = generateCorrelationId();

  return useQuery({
    queryKey: ["haproxy-frontends"],
    queryFn: () => fetchAllFrontends(correlationId),
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
    staleTime: 10000, // Data is fresh for 10 seconds
    gcTime: 5 * 60 * 1000, // Keep in cache for 5 minutes
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

// Mutation hook for syncing frontend configuration
export function useSyncDeploymentFrontend() {
  const queryClient = useQueryClient();
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: (configId: string) => syncDeploymentFrontend(configId, correlationId),
    onSuccess: (_, configId) => {
      // Invalidate and refetch frontend for this config
      queryClient.invalidateQueries({ queryKey: ["deployment-frontend", configId] });
      // Also invalidate deployment config to get updated data
      queryClient.invalidateQueries({ queryKey: ["deploymentConfig", configId] });
      // Invalidate all frontends list
      queryClient.invalidateQueries({ queryKey: ["haproxy-frontends"] });
    },
  });
}

// ====================
// Type Exports
// ====================

export type {
  HAProxyFrontendInfo,
  HAProxyFrontendResponse,
  HAProxyFrontendListResponse,
  SyncFrontendRequest,
  SyncFrontendResponse,
};
