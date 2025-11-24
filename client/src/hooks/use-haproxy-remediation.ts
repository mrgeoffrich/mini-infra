import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  HAProxyStatusResponse,
  RemediationPreviewResponse,
  RemediateHAProxyResponse,
} from "@mini-infra/types";

// Generate correlation ID for debugging
function generateCorrelationId(): string {
  return `haproxy-remediation-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// ====================
// API Functions
// ====================

async function fetchHAProxyStatus(
  environmentId: string,
  correlationId: string,
): Promise<HAProxyStatusResponse> {
  const response = await fetch(`/api/environments/${environmentId}/haproxy-status`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch HAProxy status: ${response.statusText}`);
  }

  const data: HAProxyStatusResponse = await response.json();

  if (!data.success) {
    throw new Error("Failed to fetch HAProxy status");
  }

  return data;
}

async function fetchRemediationPreview(
  environmentId: string,
  correlationId: string,
): Promise<RemediationPreviewResponse> {
  const response = await fetch(`/api/environments/${environmentId}/remediation-preview`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch remediation preview: ${response.statusText}`);
  }

  const data: RemediationPreviewResponse = await response.json();

  if (!data.success) {
    throw new Error("Failed to fetch remediation preview");
  }

  return data;
}

async function remediateHAProxy(
  environmentId: string,
  correlationId: string,
): Promise<RemediateHAProxyResponse> {
  const response = await fetch(`/api/environments/${environmentId}/remediate-haproxy`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.message || `Failed to remediate HAProxy: ${response.statusText}`);
  }

  const data: RemediateHAProxyResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to remediate HAProxy");
  }

  return data;
}

// ====================
// Hooks
// ====================

export interface UseHAProxyRemediationOptions {
  enabled?: boolean;
  refetchInterval?: number;
}

/**
 * Hook to get HAProxy status for an environment
 */
export function useHAProxyStatus(
  environmentId: string | undefined,
  options: UseHAProxyRemediationOptions = {},
) {
  const { enabled = true, refetchInterval } = options;
  const correlationId = generateCorrelationId();

  return useQuery({
    queryKey: ["haproxy-status", environmentId],
    queryFn: () => fetchHAProxyStatus(environmentId!, correlationId),
    enabled: enabled && !!environmentId,
    refetchInterval,
    retry: (failureCount: number, error: Error) => {
      // Don't retry on 404 or auth errors
      if (
        error.message.includes("401") ||
        error.message.includes("Unauthorized") ||
        error.message.includes("404")
      ) {
        return false;
      }
      return failureCount < 3;
    },
    staleTime: 30000, // Data is fresh for 30 seconds
    gcTime: 5 * 60 * 1000, // Keep in cache for 5 minutes
  });
}

/**
 * Hook to get remediation preview for an environment
 */
export function useRemediationPreview(
  environmentId: string | undefined,
  options: UseHAProxyRemediationOptions = {},
) {
  const { enabled = true } = options;
  const correlationId = generateCorrelationId();

  return useQuery({
    queryKey: ["remediation-preview", environmentId],
    queryFn: () => fetchRemediationPreview(environmentId!, correlationId),
    enabled: enabled && !!environmentId,
    retry: (failureCount: number, error: Error) => {
      // Don't retry on certain errors
      if (
        error.message.includes("401") ||
        error.message.includes("Unauthorized") ||
        error.message.includes("404") ||
        error.message.includes("503") ||
        error.message.includes("unavailable")
      ) {
        return false;
      }
      return failureCount < 2;
    },
    staleTime: 10000, // Preview data is fresh for 10 seconds
    gcTime: 60 * 1000, // Keep in cache for 1 minute
  });
}

/**
 * Hook to trigger HAProxy remediation for an environment
 */
export function useRemediateHAProxy() {
  const queryClient = useQueryClient();
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: (environmentId: string) => remediateHAProxy(environmentId, correlationId),
    onSuccess: (_, environmentId) => {
      // Invalidate related queries
      queryClient.invalidateQueries({ queryKey: ["haproxy-status", environmentId] });
      queryClient.invalidateQueries({ queryKey: ["remediation-preview", environmentId] });
      queryClient.invalidateQueries({ queryKey: ["haproxy-frontends"] });
      queryClient.invalidateQueries({ queryKey: ["environment", environmentId] });
    },
  });
}

// ====================
// Type Exports
// ====================

export type {
  HAProxyStatusResponse,
  RemediationPreviewResponse,
  RemediateHAProxyResponse,
};
