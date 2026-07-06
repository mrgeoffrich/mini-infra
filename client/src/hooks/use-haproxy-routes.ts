import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  HAProxyRoutesListResponse,
  CreateRouteRequest,
  CreateRouteResponse,
  DeleteRouteResponse,
  HAProxyRouteInfo,
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
// the *whole* envelope off the query result (e.g. `routesResponse?.data?.routes`).
// To avoid rippling type/shape changes into files outside this batch's
// scope, these functions keep returning the full envelope via
// `{ unwrap: false }` rather than letting `apiFetch` auto-unwrap to the
// inner `data` payload.

async function fetchFrontendRoutes(frontendName: string): Promise<HAProxyRoutesListResponse> {
  const data = await apiFetch<HAProxyRoutesListResponse>(
    ApiRoute.haproxy.frontendRoutes(frontendName),
    { correlationIdPrefix: "haproxy-route", unwrap: false },
  );

  if (!data.success) {
    throw new Error("Failed to fetch routes");
  }

  return data;
}

async function createRoute(
  frontendName: string,
  request: CreateRouteRequest,
): Promise<CreateRouteResponse> {
  const data = await apiFetch<CreateRouteResponse>(ApiRoute.haproxy.frontendRoutes(frontendName), {
    method: "POST",
    body: request,
    correlationIdPrefix: "haproxy-route",
    unwrap: false,
  });

  if (!data.success) {
    throw new Error(data.message || "Failed to create route");
  }

  return data;
}

async function deleteRoute(
  frontendName: string,
  routeId: string,
): Promise<DeleteRouteResponse> {
  const data = await apiFetch<DeleteRouteResponse>(
    ApiRoute.haproxy.frontendRoute(frontendName, routeId),
    { method: "DELETE", correlationIdPrefix: "haproxy-route", unwrap: false },
  );

  if (!data.success) {
    throw new Error(data.message || "Failed to delete route");
  }

  return data;
}

interface UpdateRouteResponse {
  success: boolean;
  data: HAProxyRouteInfo;
  message?: string;
}

async function updateRoute(
  frontendName: string,
  routeId: string,
  request: Partial<Pick<HAProxyRouteInfo, "hostname" | "backendName" | "useSSL" | "tlsCertificateId" | "priority">>,
): Promise<UpdateRouteResponse> {
  const data = await apiFetch<UpdateRouteResponse>(
    ApiRoute.haproxy.frontendRoute(frontendName, routeId),
    { method: "PATCH", body: request, correlationIdPrefix: "haproxy-route", unwrap: false },
  );

  if (!data.success) {
    throw new Error(data.message || "Failed to update route");
  }

  return data;
}

// ====================
// Hooks
// ====================

export interface UseHAProxyRoutesOptions {
  enabled?: boolean;
  refetchInterval?: number;
}

/**
 * Hook to get routes for a shared frontend
 */
export function useFrontendRoutes(
  frontendName: string | undefined,
  options: UseHAProxyRoutesOptions = {},
) {
  const { enabled = true } = options;
  const queryClient = useQueryClient();
  const { connected } = useSocket();

  const refetchInterval =
    options.refetchInterval ?? (connected ? false : POLL_INTERVAL_DISCONNECTED);

  useSocketChannel(Channel.HAPROXY, enabled && !!frontendName);

  useSocketEvent(
    ServerEvent.HAPROXY_FRONTENDS_LIST,
    () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.haproxy.routes(frontendName!) });
    },
    enabled && !!frontendName,
  );

  return useQuery({
    queryKey: queryKeys.haproxy.routes(frontendName!),
    queryFn: () => fetchFrontendRoutes(frontendName!),
    enabled: enabled && !!frontendName,
    refetchInterval,
    retry: (failureCount: number, error: Error) => {
      // Don't retry on certain errors
      if (error instanceof ApiRequestError && (error.isAuth || error.status === 404)) {
        return false;
      }
      if (error.message.includes("not a shared frontend")) {
        return false;
      }
      return failureCount < 3;
    },
    staleTime: 10000, // Data is fresh for 10 seconds
    gcTime: 5 * 60 * 1000, // Keep in cache for 5 minutes
  });
}

/**
 * Hook to create a route on a shared frontend
 */
export function useCreateRoute() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      frontendName,
      request,
    }: {
      frontendName: string;
      request: CreateRouteRequest;
    }) => createRoute(frontendName, request),
    onSuccess: (_, variables) => {
      // Invalidate routes list
      queryClient.invalidateQueries({ queryKey: queryKeys.haproxy.routes(variables.frontendName) });
      // Invalidate frontend details
      queryClient.invalidateQueries({ queryKey: queryKeys.haproxy.frontend(variables.frontendName) });
      // Invalidate all frontends list
      queryClient.invalidateQueries({ queryKey: queryKeys.haproxy.frontends });
    },
  });
}

/**
 * Hook to delete a route from a shared frontend
 */
export function useDeleteRoute() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      frontendName,
      routeId,
    }: {
      frontendName: string;
      routeId: string;
    }) => deleteRoute(frontendName, routeId),
    onSuccess: (_, variables) => {
      // Invalidate routes list
      queryClient.invalidateQueries({ queryKey: queryKeys.haproxy.routes(variables.frontendName) });
      // Invalidate frontend details
      queryClient.invalidateQueries({ queryKey: queryKeys.haproxy.frontend(variables.frontendName) });
      // Invalidate all frontends list
      queryClient.invalidateQueries({ queryKey: queryKeys.haproxy.frontends });
    },
  });
}

/**
 * Hook to update a route on a shared frontend
 */
export function useUpdateRoute() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      frontendName,
      routeId,
      request,
    }: {
      frontendName: string;
      routeId: string;
      request: Partial<Pick<HAProxyRouteInfo, "hostname" | "backendName" | "useSSL" | "tlsCertificateId" | "priority">>;
    }) => updateRoute(frontendName, routeId, request),
    onSuccess: (_, variables) => {
      // Invalidate routes list
      queryClient.invalidateQueries({ queryKey: queryKeys.haproxy.routes(variables.frontendName) });
      // Invalidate frontend details
      queryClient.invalidateQueries({ queryKey: queryKeys.haproxy.frontend(variables.frontendName) });
      // Invalidate all frontends list
      queryClient.invalidateQueries({ queryKey: queryKeys.haproxy.frontends });
    },
  });
}

// ====================
// Type Exports
// ====================

export type {
  HAProxyRoutesListResponse,
  CreateRouteRequest,
  CreateRouteResponse,
  DeleteRouteResponse,
};
