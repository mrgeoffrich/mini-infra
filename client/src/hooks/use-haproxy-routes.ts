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
  ErrorCode,
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

// `apiFetch` throws a typed `ApiRequestError` (carrying `.code`/`.status`/
// `.body.resource`/`.body.action`) on any non-2xx response — the server
// routes backing these now always return `success: true` on a 2xx, so
// there's no remaining `{ success: false }`-on-200 case to flatten into a
// generic Error.

async function fetchFrontendRoutes(frontendName: string): Promise<HAProxyRoutesListResponse> {
  return apiFetch<HAProxyRoutesListResponse>(
    ApiRoute.haproxy.frontendRoutes(frontendName),
    { correlationIdPrefix: "haproxy-route", unwrap: false },
  );
}

async function createRoute(
  frontendName: string,
  request: CreateRouteRequest,
): Promise<CreateRouteResponse> {
  return apiFetch<CreateRouteResponse>(ApiRoute.haproxy.frontendRoutes(frontendName), {
    method: "POST",
    body: request,
    correlationIdPrefix: "haproxy-route",
    unwrap: false,
  });
}

async function deleteRoute(
  frontendName: string,
  routeId: string,
): Promise<DeleteRouteResponse> {
  return apiFetch<DeleteRouteResponse>(
    ApiRoute.haproxy.frontendRoute(frontendName, routeId),
    { method: "DELETE", correlationIdPrefix: "haproxy-route", unwrap: false },
  );
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
  return apiFetch<UpdateRouteResponse>(
    ApiRoute.haproxy.frontendRoute(frontendName, routeId),
    { method: "PATCH", body: request, correlationIdPrefix: "haproxy-route", unwrap: false },
  );
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
      if (error instanceof ApiRequestError) {
        if (error.isAuth || error.status === 404) {
          return false;
        }
        // The frontend exists but isn't a shared frontend — retrying won't
        // change that.
        if (error.code === ErrorCode.HAPROXY_FRONTEND_TYPE_MISMATCH) {
          return false;
        }
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
