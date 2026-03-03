import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  HAProxyRoutesListResponse,
  CreateRouteRequest,
  CreateRouteResponse,
  DeleteRouteResponse,
  HAProxyRouteInfo,
} from "@mini-infra/types";

// Generate correlation ID for debugging
function generateCorrelationId(): string {
  return `haproxy-route-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// ====================
// API Functions
// ====================

async function fetchFrontendRoutes(
  frontendName: string,
  correlationId: string,
): Promise<HAProxyRoutesListResponse> {
  const response = await fetch(`/api/haproxy/frontends/${encodeURIComponent(frontendName)}/routes`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch routes: ${response.statusText}`);
  }

  const data: HAProxyRoutesListResponse = await response.json();

  if (!data.success) {
    throw new Error("Failed to fetch routes");
  }

  return data;
}

async function createRoute(
  frontendName: string,
  request: CreateRouteRequest,
  correlationId: string,
): Promise<CreateRouteResponse> {
  const response = await fetch(`/api/haproxy/frontends/${encodeURIComponent(frontendName)}/routes`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.message || `Failed to create route: ${response.statusText}`);
  }

  const data: CreateRouteResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to create route");
  }

  return data;
}

async function deleteRoute(
  frontendName: string,
  routeId: string,
  correlationId: string,
): Promise<DeleteRouteResponse> {
  const response = await fetch(
    `/api/haproxy/frontends/${encodeURIComponent(frontendName)}/routes/${routeId}`,
    {
      method: "DELETE",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "X-Correlation-ID": correlationId,
      },
    },
  );

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.message || `Failed to delete route: ${response.statusText}`);
  }

  const data: DeleteRouteResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to delete route");
  }

  return data;
}

async function updateRoute(
  frontendName: string,
  routeId: string,
  request: Partial<Pick<HAProxyRouteInfo, "hostname" | "backendName" | "useSSL" | "tlsCertificateId" | "priority">>,
  correlationId: string,
): Promise<{ success: boolean; data: HAProxyRouteInfo; message?: string }> {
  const response = await fetch(
    `/api/haproxy/frontends/${encodeURIComponent(frontendName)}/routes/${routeId}`,
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
    throw new Error(errorData.message || `Failed to update route: ${response.statusText}`);
  }

  const data = await response.json();

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
  const { enabled = true, refetchInterval } = options;
  const correlationId = generateCorrelationId();

  return useQuery({
    queryKey: ["haproxy-routes", frontendName],
    queryFn: () => fetchFrontendRoutes(frontendName!, correlationId),
    enabled: enabled && !!frontendName,
    refetchInterval,
    retry: (failureCount: number, error: Error) => {
      // Don't retry on certain errors
      if (
        error.message.includes("401") ||
        error.message.includes("Unauthorized") ||
        error.message.includes("404") ||
        error.message.includes("not a shared frontend")
      ) {
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
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: ({
      frontendName,
      request,
    }: {
      frontendName: string;
      request: CreateRouteRequest;
    }) => createRoute(frontendName, request, correlationId),
    onSuccess: (_, variables) => {
      // Invalidate routes list
      queryClient.invalidateQueries({ queryKey: ["haproxy-routes", variables.frontendName] });
      // Invalidate frontend details
      queryClient.invalidateQueries({ queryKey: ["haproxy-frontend", variables.frontendName] });
      // Invalidate all frontends list
      queryClient.invalidateQueries({ queryKey: ["haproxy-frontends"] });
    },
  });
}

/**
 * Hook to delete a route from a shared frontend
 */
export function useDeleteRoute() {
  const queryClient = useQueryClient();
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: ({
      frontendName,
      routeId,
    }: {
      frontendName: string;
      routeId: string;
    }) => deleteRoute(frontendName, routeId, correlationId),
    onSuccess: (_, variables) => {
      // Invalidate routes list
      queryClient.invalidateQueries({ queryKey: ["haproxy-routes", variables.frontendName] });
      // Invalidate frontend details
      queryClient.invalidateQueries({ queryKey: ["haproxy-frontend", variables.frontendName] });
      // Invalidate all frontends list
      queryClient.invalidateQueries({ queryKey: ["haproxy-frontends"] });
    },
  });
}

/**
 * Hook to update a route on a shared frontend
 */
export function useUpdateRoute() {
  const queryClient = useQueryClient();
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: ({
      frontendName,
      routeId,
      request,
    }: {
      frontendName: string;
      routeId: string;
      request: Partial<Pick<HAProxyRouteInfo, "hostname" | "backendName" | "useSSL" | "tlsCertificateId" | "priority">>;
    }) => updateRoute(frontendName, routeId, request, correlationId),
    onSuccess: (_, variables) => {
      // Invalidate routes list
      queryClient.invalidateQueries({ queryKey: ["haproxy-routes", variables.frontendName] });
      // Invalidate frontend details
      queryClient.invalidateQueries({ queryKey: ["haproxy-frontend", variables.frontendName] });
      // Invalidate all frontends list
      queryClient.invalidateQueries({ queryKey: ["haproxy-frontends"] });
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
