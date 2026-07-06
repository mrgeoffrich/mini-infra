import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  HAProxyFrontendInfo,
  HAProxyFrontendResponse,
  HAProxyFrontendListResponse,
  Channel,
  ServerEvent,
  ApiRoute,
  queryKeys,
} from "@mini-infra/types";
import { useSocket, useSocketChannel, useSocketEvent } from "./use-socket";
import { apiFetch, ApiRequestError } from "@/lib/api-client";

const POLL_INTERVAL_DISCONNECTED = 30000; // 30s when socket is not connected

// ====================
// HAProxy Frontend API Functions
// ====================
//
// These endpoints are enveloped (`{success, data, message?}`), but every
// existing consumer of these hooks (many outside this migration batch) reads
// the *whole* envelope off the query result (e.g. `frontendsResponse?.data`,
// `frontendResponse?.data`). To avoid rippling type/shape changes into files
// outside this batch's scope, these functions keep returning the full
// envelope via `{ unwrap: false }` rather than letting `apiFetch` auto-
// unwrap to the inner `data` payload.

async function fetchAllFrontends(): Promise<HAProxyFrontendListResponse> {
  const data = await apiFetch<HAProxyFrontendListResponse>(ApiRoute.haproxy.frontends(), {
    correlationIdPrefix: "haproxy-frontends",
    unwrap: false,
  });

  if (!data.success) {
    throw new Error(data.message || "Failed to fetch HAProxy frontends");
  }

  return data;
}

async function fetchFrontendByName(frontendName: string): Promise<HAProxyFrontendResponse> {
  const data = await apiFetch<HAProxyFrontendResponse>(ApiRoute.haproxy.frontend(frontendName), {
    correlationIdPrefix: "haproxy-frontend",
    unwrap: false,
  });

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

  const queryClient = useQueryClient();
  const { connected } = useSocket();

  const refetchInterval =
    options.refetchInterval ?? (connected ? false : POLL_INTERVAL_DISCONNECTED);

  useSocketChannel(Channel.HAPROXY, enabled);

  useSocketEvent(
    ServerEvent.HAPROXY_FRONTENDS_LIST,
    () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.haproxy.frontends });
      queryClient.invalidateQueries({ queryKey: queryKeys.haproxy.frontendAll });
    },
    enabled,
  );

  return useQuery({
    queryKey: queryKeys.haproxy.frontends,
    queryFn: () => fetchAllFrontends(),
    enabled,
    refetchInterval,
    retry:
      typeof retry === "function"
        ? retry
        : (failureCount: number, error: Error) => {
            // Don't retry on authentication errors
            if (error instanceof ApiRequestError && error.isAuth) {
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

  const { connected } = useSocket();

  const refetchInterval =
    options.refetchInterval ?? (connected ? false : POLL_INTERVAL_DISCONNECTED);

  return useQuery({
    queryKey: queryKeys.haproxy.frontend(frontendName!),
    queryFn: () => fetchFrontendByName(frontendName!),
    enabled: enabled && !!frontendName,
    refetchInterval,
    retry:
      typeof retry === "function"
        ? retry
        : (failureCount: number, error: Error) => {
            if (error instanceof ApiRequestError) {
              // Don't retry on authentication errors
              if (error.isAuth) {
                return false;
              }
              // Don't retry on not found errors
              if (error.status === 404) {
                return false;
              }
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
