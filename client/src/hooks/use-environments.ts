import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useCallback } from "react";
import {
  Environment,
  EnvironmentType,
  EnvironmentDeleteCheck,
  CreateEnvironmentRequest,
  UpdateEnvironmentRequest,
  ListEnvironmentsResponse,
} from "@mini-infra/types";

// Generate correlation ID for debugging
function generateCorrelationId(): string {
  return `environments-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// ====================
// Environment API Functions
// ====================

async function fetchEnvironments(
  filters: {
    type?: EnvironmentType;
    page?: number;
    limit?: number;
  } = {},
  correlationId: string,
): Promise<ListEnvironmentsResponse> {
  const url = new URL(`/api/environments`, window.location.origin);

  // Add query parameters
  if (filters.type) url.searchParams.set("type", filters.type);
  if (filters.page) url.searchParams.set("page", filters.page.toString());
  if (filters.limit) url.searchParams.set("limit", filters.limit.toString());

  const response = await fetch(url.toString(), {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch environments: ${response.statusText}`);
  }

  return await response.json();
}

async function fetchEnvironment(
  id: string,
  correlationId: string,
): Promise<Environment> {
  const response = await fetch(`/api/environments/${id}`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch environment: ${response.statusText}`);
  }

  return await response.json();
}

async function createEnvironment(
  request: CreateEnvironmentRequest,
  correlationId: string,
): Promise<Environment> {
  const response = await fetch(`/api/environments`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(`Failed to create environment: ${response.statusText}`);
  }

  return await response.json();
}

async function updateEnvironment(
  id: string,
  request: UpdateEnvironmentRequest,
  correlationId: string,
): Promise<Environment> {
  const response = await fetch(`/api/environments/${id}`, {
    method: "PUT",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(`Failed to update environment: ${response.statusText}`);
  }

  return await response.json();
}

async function deleteEnvironment(
  options: { id: string; deleteNetworks?: boolean },
  correlationId: string,
): Promise<void> {
  const { id, deleteNetworks = false } = options;
  const url = new URL(`/api/environments/${id}`, window.location.origin);

  // Add query parameters for deletion options
  if (deleteNetworks) url.searchParams.set("deleteNetworks", "true");

  const response = await fetch(url.toString(), {
    method: "DELETE",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    // Try to parse error response for detailed message
    let errorMessage = `Failed to delete environment: ${response.statusText}`;
    try {
      const errorData = await response.json();
      errorMessage = errorData.message || errorData.error || errorMessage;
    } catch {
      // If JSON parsing fails, use the default error message
    }
    throw new Error(errorMessage);
  }
}



async function fetchEnvironmentDeleteCheck(
  id: string,
  correlationId: string,
): Promise<EnvironmentDeleteCheck> {
  const response = await fetch(`/api/environments/${id}/delete-check`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to check delete eligibility: ${response.statusText}`);
  }

  return await response.json();
}

// ====================
// Environment Hooks
// ====================

export interface UseEnvironmentsOptions {
  enabled?: boolean;
  refetchInterval?: number;
  retry?: number | boolean | ((failureCount: number, error: Error) => boolean);
  filters?: {
    type?: EnvironmentType;
    page?: number;
    limit?: number;
  };
}

export function useEnvironments(options: UseEnvironmentsOptions = {}) {
  const {
    enabled = true,
    refetchInterval,
    retry = 3,
    filters = {},
  } = options;

  const correlationId = generateCorrelationId();

  return useQuery({
    queryKey: ["environments", filters],
    queryFn: () => fetchEnvironments(filters, correlationId),
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
            return typeof retry === "boolean" ? retry : failureCount < retry;
          },
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),
    staleTime: 10000, // Data is fresh for 10 seconds
    gcTime: 5 * 60 * 1000, // Keep in cache for 5 minutes
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

export interface UseEnvironmentOptions {
  enabled?: boolean;
  refetchInterval?: number;
  retry?: number | boolean | ((failureCount: number, error: Error) => boolean);
}

export function useEnvironment(
  id: string,
  options: UseEnvironmentOptions = {},
) {
  const { enabled = true, refetchInterval, retry = 3 } = options;

  const correlationId = generateCorrelationId();

  return useQuery({
    queryKey: ["environment", id],
    queryFn: () => fetchEnvironment(id, correlationId),
    enabled: enabled && !!id,
    refetchInterval,
    retry:
      typeof retry === "function"
        ? retry
        : (failureCount: number, error: Error) => {
            if (
              error.message.includes("401") ||
              error.message.includes("Unauthorized") ||
              error.message.includes("404") ||
              error.message.includes("Not found")
            ) {
              return false;
            }
            return typeof retry === "boolean" ? retry : failureCount < retry;
          },
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),
    staleTime: 5000,
    gcTime: 5 * 60 * 1000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

// Mutation hooks
export function useCreateEnvironment() {
  const queryClient = useQueryClient();
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: (request: CreateEnvironmentRequest) =>
      createEnvironment(request, correlationId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["environments"] });
    },
  });
}

export function useUpdateEnvironment() {
  const queryClient = useQueryClient();
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: ({
      id,
      request,
    }: {
      id: string;
      request: UpdateEnvironmentRequest;
    }) => updateEnvironment(id, request, correlationId),
    onSuccess: (_, { id }) => {
      queryClient.invalidateQueries({ queryKey: ["environments"] });
      queryClient.invalidateQueries({ queryKey: ["environment", id] });
      queryClient.invalidateQueries({ queryKey: ["environmentStatus", id] });
    },
  });
}

export function useDeleteEnvironment() {
  const queryClient = useQueryClient();
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: (options: { id: string; deleteNetworks?: boolean }) =>
      deleteEnvironment(options, correlationId),
    onSuccess: (_, options) => {
      queryClient.invalidateQueries({ queryKey: ["environments"] });
      queryClient.removeQueries({ queryKey: ["environment", options.id] });
      queryClient.removeQueries({ queryKey: ["environmentStatus", options.id] });
    },
  });
}

export function useEnvironmentDeleteCheck(
  id: string,
  options: { enabled?: boolean } = {},
) {
  const { enabled = true } = options;
  const correlationId = generateCorrelationId();

  return useQuery({
    queryKey: ["environmentDeleteCheck", id],
    queryFn: () => fetchEnvironmentDeleteCheck(id, correlationId),
    enabled: enabled && !!id,
    staleTime: 0, // Always refetch when dialog opens
    gcTime: 60 * 1000,
  });
}

// ====================
// Environment Filter Hook
// ====================

export interface EnvironmentFiltersState {
  type?: EnvironmentType;
  page: number;
  limit: number;
}

export function useEnvironmentFilters(
  initialFilters: Partial<EnvironmentFiltersState> = {},
) {
  const [filters, setFilters] = useState<EnvironmentFiltersState>({
    page: 1,
    limit: 20,
    ...initialFilters,
  });

  const updateFilter = useCallback(
    <K extends keyof EnvironmentFiltersState>(
      key: K,
      value: EnvironmentFiltersState[K],
    ) => {
      setFilters((prev) => ({
        ...prev,
        [key]: value,
        // Reset to first page when filters change (except when updating page itself)
        page: key === "page" ? (value as number) : 1,
      }));
    },
    [],
  );

  const resetFilters = useCallback(() => {
    setFilters({
      page: 1,
      limit: 20,
      ...initialFilters,
    });
  }, [initialFilters]);

  return {
    filters,
    updateFilter,
    resetFilters,
  };
}

// ====================
// Type Exports
// ====================

export type {
  Environment,
  EnvironmentType,
  EnvironmentDeleteCheck,
  CreateEnvironmentRequest,
  UpdateEnvironmentRequest,
};