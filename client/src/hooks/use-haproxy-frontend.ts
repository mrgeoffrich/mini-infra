import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  HAProxyFrontendInfo,
  HAProxyFrontendResponse,
  HAProxyFrontendListResponse,
  Channel,
  ServerEvent,
} from "@mini-infra/types";
import { useSocket, useSocketChannel, useSocketEvent } from "./use-socket";

const POLL_INTERVAL_DISCONNECTED = 30000; // 30s when socket is not connected

// Generate correlation ID for debugging
function generateCorrelationId(): string {
  return `haproxy-frontend-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// ====================
// HAProxy Frontend API Functions
// ====================

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

async function fetchFrontendByName(
  frontendName: string,
  correlationId: string,
): Promise<HAProxyFrontendResponse> {
  const response = await fetch(`/api/haproxy/frontends/${encodeURIComponent(frontendName)}`, {
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

// ====================
// HAProxy Frontend Hooks
// ====================

export interface UseHAProxyFrontendOptions {
  enabled?: boolean;
  refetchInterval?: number;
  retry?: number | boolean | ((failureCount: number, error: Error) => boolean);
}

export function useAllFrontends(
  options: UseHAProxyFrontendOptions = {},
) {
  const { enabled = true, retry = 3 } = options;

  const correlationId = generateCorrelationId();
  const queryClient = useQueryClient();
  const { connected } = useSocket();

  const refetchInterval =
    options.refetchInterval ?? (connected ? false : POLL_INTERVAL_DISCONNECTED);

  useSocketChannel(Channel.HAPROXY, enabled);

  useSocketEvent(
    ServerEvent.HAPROXY_FRONTENDS_LIST,
    () => {
      queryClient.invalidateQueries({ queryKey: ["haproxy-frontends"] });
      queryClient.invalidateQueries({ queryKey: ["haproxy-frontend"] });
    },
    enabled,
  );

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

/**
 * Hook to get a specific HAProxy frontend by name
 */
export function useFrontendByName(
  frontendName: string | undefined,
  options: UseHAProxyFrontendOptions = {},
) {
  const { enabled = true, retry = 3 } = options;

  const correlationId = generateCorrelationId();
  const { connected } = useSocket();

  const refetchInterval =
    options.refetchInterval ?? (connected ? false : POLL_INTERVAL_DISCONNECTED);

  return useQuery({
    queryKey: ["haproxy-frontend", frontendName],
    queryFn: () => fetchFrontendByName(frontendName!, correlationId),
    enabled: enabled && !!frontendName,
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

// ====================
// Type Exports
// ====================

export type {
  HAProxyFrontendInfo,
  HAProxyFrontendResponse,
  HAProxyFrontendListResponse,
};
