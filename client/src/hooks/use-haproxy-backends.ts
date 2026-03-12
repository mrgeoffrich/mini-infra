import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  HAProxyBackendListResponse,
  HAProxyBackendResponse,
  HAProxyServerListResponse,
  UpdateBackendRequest,
  UpdateServerRequest,
  Channel,
  ServerEvent,
} from "@mini-infra/types";
import { useSocket, useSocketChannel, useSocketEvent } from "./use-socket";

const POLL_INTERVAL_DISCONNECTED = 30000; // 30s when socket is not connected

// Generate correlation ID for debugging
function generateCorrelationId(): string {
  return `haproxy-backend-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// ====================
// API Functions
// ====================

async function fetchAllBackends(
  correlationId: string,
): Promise<HAProxyBackendListResponse> {
  const response = await fetch(`/api/haproxy/backends`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch backends: ${response.statusText}`);
  }

  const data: HAProxyBackendListResponse = await response.json();

  if (!data.success) {
    throw new Error("Failed to fetch backends");
  }

  return data;
}

async function fetchBackendByName(
  backendName: string,
  environmentId: string,
  correlationId: string,
): Promise<HAProxyBackendResponse> {
  const response = await fetch(
    `/api/haproxy/backends/${encodeURIComponent(backendName)}?environmentId=${encodeURIComponent(environmentId)}`,
    {
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "X-Correlation-ID": correlationId,
      },
    },
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch backend: ${response.statusText}`);
  }

  const data: HAProxyBackendResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to fetch backend");
  }

  return data;
}

async function fetchBackendServers(
  backendName: string,
  environmentId: string,
  correlationId: string,
): Promise<HAProxyServerListResponse> {
  const response = await fetch(
    `/api/haproxy/backends/${encodeURIComponent(backendName)}/servers?environmentId=${encodeURIComponent(environmentId)}`,
    {
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "X-Correlation-ID": correlationId,
      },
    },
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch servers: ${response.statusText}`);
  }

  const data: HAProxyServerListResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to fetch servers");
  }

  return data;
}

async function updateBackend(
  backendName: string,
  environmentId: string,
  request: UpdateBackendRequest,
  correlationId: string,
): Promise<HAProxyBackendResponse> {
  const response = await fetch(
    `/api/haproxy/backends/${encodeURIComponent(backendName)}?environmentId=${encodeURIComponent(environmentId)}`,
    {
      method: "PATCH",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "X-Correlation-ID": correlationId,
      },
      body: JSON.stringify(request),
    },
  );

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.message || `Failed to update backend: ${response.statusText}`);
  }

  const data: HAProxyBackendResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to update backend");
  }

  return data;
}

async function updateServer(
  backendName: string,
  serverName: string,
  environmentId: string,
  request: UpdateServerRequest,
  correlationId: string,
): Promise<HAProxyBackendResponse> {
  const response = await fetch(
    `/api/haproxy/backends/${encodeURIComponent(backendName)}/servers/${encodeURIComponent(serverName)}?environmentId=${encodeURIComponent(environmentId)}`,
    {
      method: "PATCH",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "X-Correlation-ID": correlationId,
      },
      body: JSON.stringify(request),
    },
  );

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.message || `Failed to update server: ${response.statusText}`);
  }

  const data = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to update server");
  }

  return data;
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
  const correlationId = generateCorrelationId();
  const queryClient = useQueryClient();
  const { connected } = useSocket();

  const refetchInterval =
    options.refetchInterval ?? (connected ? false : POLL_INTERVAL_DISCONNECTED);

  useSocketChannel(Channel.HAPROXY, enabled);

  useSocketEvent(
    ServerEvent.HAPROXY_BACKENDS_LIST,
    () => {
      queryClient.invalidateQueries({ queryKey: ["haproxy-backends"] });
      queryClient.invalidateQueries({ queryKey: ["haproxy-backend"] });
      queryClient.invalidateQueries({ queryKey: ["haproxy-servers"] });
    },
    enabled,
  );

  return useQuery({
    queryKey: ["haproxy-backends"],
    queryFn: () => fetchAllBackends(correlationId),
    enabled,
    refetchInterval,
    retry: (failureCount: number, error: Error) => {
      if (
        error.message.includes("401") ||
        error.message.includes("Unauthorized")
      ) {
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
  const correlationId = generateCorrelationId();
  const { connected } = useSocket();

  const refetchInterval =
    options.refetchInterval ?? (connected ? false : POLL_INTERVAL_DISCONNECTED);

  return useQuery({
    queryKey: ["haproxy-backend", backendName, environmentId],
    queryFn: () => fetchBackendByName(backendName!, environmentId!, correlationId),
    enabled: enabled && !!backendName && !!environmentId,
    refetchInterval,
    retry: (failureCount: number, error: Error) => {
      if (
        error.message.includes("401") ||
        error.message.includes("Unauthorized") ||
        error.message.includes("404") ||
        error.message.includes("Not found")
      ) {
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
  const correlationId = generateCorrelationId();
  const { connected } = useSocket();

  const refetchInterval =
    options.refetchInterval ?? (connected ? false : POLL_INTERVAL_DISCONNECTED);

  return useQuery({
    queryKey: ["haproxy-servers", backendName, environmentId],
    queryFn: () => fetchBackendServers(backendName!, environmentId!, correlationId),
    enabled: enabled && !!backendName && !!environmentId,
    refetchInterval,
    retry: (failureCount: number, error: Error) => {
      if (
        error.message.includes("401") ||
        error.message.includes("Unauthorized") ||
        error.message.includes("404") ||
        error.message.includes("Not found")
      ) {
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
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: ({
      backendName,
      environmentId,
      request,
    }: {
      backendName: string;
      environmentId: string;
      request: UpdateBackendRequest;
    }) => updateBackend(backendName, environmentId, request, correlationId),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["haproxy-backend", variables.backendName, variables.environmentId],
      });
      queryClient.invalidateQueries({ queryKey: ["haproxy-backends"] });
    },
  });
}

/**
 * Hook to update a server configuration
 */
export function useUpdateServer() {
  const queryClient = useQueryClient();
  const correlationId = generateCorrelationId();

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
    }) => updateServer(backendName, serverName, environmentId, request, correlationId),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["haproxy-servers", variables.backendName, variables.environmentId],
      });
      queryClient.invalidateQueries({
        queryKey: ["haproxy-backend", variables.backendName, variables.environmentId],
      });
      queryClient.invalidateQueries({ queryKey: ["haproxy-backends"] });
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
