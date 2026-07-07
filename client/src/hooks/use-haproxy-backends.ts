import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  HAProxyBackendListResponse,
  HAProxyBackendResponse,
  HAProxyServerListResponse,
  UpdateBackendRequest,
  UpdateServerRequest,
  Channel,
  ServerEvent,
  ApiRoute,
  queryKeys,
} from "@mini-infra/types";
import { useSocket, useSocketChannel, useSocketEvent } from "./use-socket";
import { apiFetch, ApiRequestError } from "@/lib/api-client";

const POLL_INTERVAL_DISCONNECTED = 30000; // 30s when socket is not connected

// ====================
// API Functions
// ====================
//
// These endpoints are enveloped (`{success, data, message?}`), but every
// existing consumer of these hooks (many outside this migration batch) reads
// the *whole* envelope off the query result (e.g. `backendsResponse?.data`,
// `backendResponse?.data`). To avoid rippling type/shape changes into files
// outside this batch's scope, these functions keep returning the full
// envelope via `{ unwrap: false }` rather than letting `apiFetch` auto-
// unwrap to the inner `data` payload.

// `apiFetch` throws a typed `ApiRequestError` (carrying `.code`/`.status`/
// `.body.resource`/`.body.action`) on any non-2xx response — the server
// routes backing these now always return `success: true` on a 2xx, so
// there's no remaining `{ success: false }`-on-200 case to flatten into a
// generic Error.

async function fetchAllBackends(): Promise<HAProxyBackendListResponse> {
  return apiFetch<HAProxyBackendListResponse>(ApiRoute.haproxy.backends(), {
    correlationIdPrefix: "haproxy-backends",
    unwrap: false,
  });
}

async function fetchBackendByName(
  backendName: string,
  environmentId: string,
): Promise<HAProxyBackendResponse> {
  const url = new URL(ApiRoute.haproxy.backend(backendName), window.location.origin);
  url.searchParams.set("environmentId", environmentId);

  return apiFetch<HAProxyBackendResponse>(url.toString(), {
    correlationIdPrefix: "haproxy-backend",
    unwrap: false,
  });
}

async function fetchBackendServers(
  backendName: string,
  environmentId: string,
): Promise<HAProxyServerListResponse> {
  const url = new URL(ApiRoute.haproxy.backendServers(backendName), window.location.origin);
  url.searchParams.set("environmentId", environmentId);

  return apiFetch<HAProxyServerListResponse>(url.toString(), {
    correlationIdPrefix: "haproxy-servers",
    unwrap: false,
  });
}

async function updateBackend(
  backendName: string,
  environmentId: string,
  request: UpdateBackendRequest,
): Promise<HAProxyBackendResponse> {
  const url = new URL(ApiRoute.haproxy.backend(backendName), window.location.origin);
  url.searchParams.set("environmentId", environmentId);

  return apiFetch<HAProxyBackendResponse>(url.toString(), {
    method: "PATCH",
    body: request,
    correlationIdPrefix: "haproxy-backend-update",
    unwrap: false,
  });
}

async function updateServer(
  backendName: string,
  serverName: string,
  environmentId: string,
  request: UpdateServerRequest,
): Promise<HAProxyBackendResponse> {
  const url = new URL(
    ApiRoute.haproxy.backendServer(backendName, serverName),
    window.location.origin,
  );
  url.searchParams.set("environmentId", environmentId);

  return apiFetch<HAProxyBackendResponse>(url.toString(), {
    method: "PATCH",
    body: request,
    correlationIdPrefix: "haproxy-server-update",
    unwrap: false,
  });
}

// ====================
// Hooks
// ====================

export interface UseHAProxyBackendsOptions {
  enabled?: boolean;
  refetchInterval?: number;
}

/**
 * Hook to get all backends
 */
export function useAllBackends(options: UseHAProxyBackendsOptions = {}) {
  const { enabled = true } = options;
  const queryClient = useQueryClient();
  const { connected } = useSocket();

  const refetchInterval =
    options.refetchInterval ?? (connected ? false : POLL_INTERVAL_DISCONNECTED);

  useSocketChannel(Channel.HAPROXY, enabled);

  useSocketEvent(
    ServerEvent.HAPROXY_BACKENDS_LIST,
    () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.haproxy.backends });
      queryClient.invalidateQueries({ queryKey: queryKeys.haproxy.backendAll });
      queryClient.invalidateQueries({ queryKey: queryKeys.haproxy.serversAll });
    },
    enabled,
  );

  return useQuery({
    queryKey: queryKeys.haproxy.backends,
    queryFn: () => fetchAllBackends(),
    enabled,
    refetchInterval,
    retry: (failureCount: number, error: Error) => {
      if (error instanceof ApiRequestError && error.isAuth) {
        return false;
      }
      return failureCount < 3;
    },
    staleTime: 10000,
    gcTime: 5 * 60 * 1000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

/**
 * Hook to get a specific backend by name
 */
export function useBackendByName(
  backendName: string | undefined,
  environmentId: string | undefined,
  options: UseHAProxyBackendsOptions = {},
) {
  const { enabled = true } = options;
  const { connected } = useSocket();

  const refetchInterval =
    options.refetchInterval ?? (connected ? false : POLL_INTERVAL_DISCONNECTED);

  return useQuery({
    queryKey: queryKeys.haproxy.backend(backendName!, environmentId!),
    queryFn: () => fetchBackendByName(backendName!, environmentId!),
    enabled: enabled && !!backendName && !!environmentId,
    refetchInterval,
    retry: (failureCount: number, error: Error) => {
      if (error instanceof ApiRequestError && (error.isAuth || error.status === 404)) {
        return false;
      }
      return failureCount < 3;
    },
    staleTime: 10000,
    gcTime: 5 * 60 * 1000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

/**
 * Hook to get servers for a specific backend
 */
export function useBackendServers(
  backendName: string | undefined,
  environmentId: string | undefined,
  options: UseHAProxyBackendsOptions = {},
) {
  const { enabled = true } = options;
  const { connected } = useSocket();

  const refetchInterval =
    options.refetchInterval ?? (connected ? false : POLL_INTERVAL_DISCONNECTED);

  return useQuery({
    queryKey: queryKeys.haproxy.servers(backendName!, environmentId!),
    queryFn: () => fetchBackendServers(backendName!, environmentId!),
    enabled: enabled && !!backendName && !!environmentId,
    refetchInterval,
    retry: (failureCount: number, error: Error) => {
      if (error instanceof ApiRequestError && (error.isAuth || error.status === 404)) {
        return false;
      }
      return failureCount < 3;
    },
    staleTime: 10000,
    gcTime: 5 * 60 * 1000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

/**
 * Hook to update a backend configuration
 */
export function useUpdateBackend() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      backendName,
      environmentId,
      request,
    }: {
      backendName: string;
      environmentId: string;
      request: UpdateBackendRequest;
    }) => updateBackend(backendName, environmentId, request),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.haproxy.backend(variables.backendName, variables.environmentId),
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.haproxy.backends });
    },
  });
}

/**
 * Hook to update a server configuration
 */
export function useUpdateServer() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      backendName,
      serverName,
      environmentId,
      request,
    }: {
      backendName: string;
      serverName: string;
      environmentId: string;
      request: UpdateServerRequest;
    }) => updateServer(backendName, serverName, environmentId, request),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.haproxy.servers(variables.backendName, variables.environmentId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.haproxy.backend(variables.backendName, variables.environmentId),
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.haproxy.backends });
    },
  });
}

// ====================
// Type Exports
// ====================

export type {
  HAProxyBackendListResponse,
  HAProxyBackendResponse,
  HAProxyServerListResponse,
  UpdateBackendRequest,
  UpdateServerRequest,
};
