import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  DeploymentDNSRecordInfo,
  DeploymentDNSRecordListResponse,
  DeploymentDNSRecordResponse,
  SyncDNSRequest,
  SyncDNSResponse,
} from "@mini-infra/types";

// Generate correlation ID for debugging
function generateCorrelationId(): string {
  return `deployment-dns-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// ====================
// Deployment DNS API Functions
// ====================

async function fetchDeploymentDNSRecords(
  configId: string,
  correlationId: string,
): Promise<DeploymentDNSRecordListResponse> {
  const response = await fetch(`/api/deployments/configs/${configId}/dns`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch DNS records: ${response.statusText}`,
    );
  }

  const data: DeploymentDNSRecordListResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to fetch DNS records");
  }

  return data;
}

async function syncDeploymentDNS(
  configId: string,
  correlationId: string,
): Promise<SyncDNSResponse> {
  const request: SyncDNSRequest = {
    deploymentConfigId: configId,
  };

  const response = await fetch(`/api/deployments/configs/${configId}/dns/sync`, {
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
      `Failed to sync DNS: ${response.statusText}`,
    );
  }

  const data: SyncDNSResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to sync DNS");
  }

  return data;
}

async function deleteDeploymentDNS(
  configId: string,
  correlationId: string,
): Promise<{ success: boolean; message: string }> {
  const response = await fetch(`/api/deployments/configs/${configId}/dns`, {
    method: "DELETE",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to delete DNS record: ${response.statusText}`,
    );
  }

  const data = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to delete DNS record");
  }

  return data;
}

// ====================
// Deployment DNS Hooks
// ====================

export interface UseDeploymentDNSOptions {
  enabled?: boolean;
  refetchInterval?: number;
  retry?: number | boolean | ((failureCount: number, error: Error) => boolean);
}

export function useDeploymentDNS(
  configId: string,
  options: UseDeploymentDNSOptions = {},
) {
  const { enabled = true, refetchInterval, retry = 3 } = options;

  const correlationId = generateCorrelationId();

  return useQuery({
    queryKey: ["deployment-dns", configId],
    queryFn: () => fetchDeploymentDNSRecords(configId, correlationId),
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

// Mutation hook for syncing DNS records
export function useSyncDeploymentDNS() {
  const queryClient = useQueryClient();
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: (configId: string) => syncDeploymentDNS(configId, correlationId),
    onSuccess: (_, configId) => {
      // Invalidate and refetch DNS records for this config
      queryClient.invalidateQueries({ queryKey: ["deployment-dns", configId] });
      // Also invalidate deployment config to get updated data
      queryClient.invalidateQueries({ queryKey: ["deploymentConfig", configId] });
    },
  });
}

// Mutation hook for deleting DNS records
export function useDeleteDeploymentDNS() {
  const queryClient = useQueryClient();
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: (configId: string) => deleteDeploymentDNS(configId, correlationId),
    onSuccess: (_, configId) => {
      // Invalidate and refetch DNS records for this config
      queryClient.invalidateQueries({ queryKey: ["deployment-dns", configId] });
      // Also invalidate deployment config to get updated data
      queryClient.invalidateQueries({ queryKey: ["deploymentConfig", configId] });
    },
  });
}

// ====================
// Type Exports
// ====================

export type {
  DeploymentDNSRecordInfo,
  DeploymentDNSRecordListResponse,
  DeploymentDNSRecordResponse,
  SyncDNSRequest,
  SyncDNSResponse,
};
