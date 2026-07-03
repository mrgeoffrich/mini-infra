import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useCallback } from "react";
import {
  Environment,
  EnvironmentType,
  EnvironmentDeleteCheck,
  CreateEnvironmentRequest,
  UpdateEnvironmentRequest,
  ListEnvironmentsResponse,
  ApiRoute,
  queryKeys,
} from "@mini-infra/types";
import { apiFetch, ApiRequestError } from "@/lib/api-client";

// ====================
// Environment API Functions
// ====================
//
// The environments API returns raw resource bodies (no `{success,data}`
// envelope), so every call here passes `unwrap: false`.

async function fetchEnvironments(
  filters: {
    type?: EnvironmentType;
    page?: number;
    limit?: number;
  } = {},
): Promise<ListEnvironmentsResponse> {
  const url = new URL(ApiRoute.environments.list(), window.location.origin);

  // Add query parameters
  if (filters.type) url.searchParams.set("type", filters.type);
  if (filters.page) url.searchParams.set("page", filters.page.toString());
  if (filters.limit) url.searchParams.set("limit", filters.limit.toString());

  return apiFetch<ListEnvironmentsResponse>(url.toString(), {
    correlationIdPrefix: "environments",
    unwrap: false,
  });
}

async function fetchEnvironment(id: string): Promise<Environment> {
  return apiFetch<Environment>(ApiRoute.environments.get(id), {
    correlationIdPrefix: "environments",
    unwrap: false,
  });
}

async function createEnvironment(
  request: CreateEnvironmentRequest,
): Promise<Environment> {
  return apiFetch<Environment>(ApiRoute.environments.list(), {
    method: "POST",
    body: request,
    correlationIdPrefix: "environments",
    unwrap: false,
  });
}

async function updateEnvironment(
  id: string,
  request: UpdateEnvironmentRequest,
): Promise<Environment> {
  return apiFetch<Environment>(ApiRoute.environments.get(id), {
    method: "PUT",
    body: request,
    correlationIdPrefix: "environments",
    unwrap: false,
  });
}

async function deleteEnvironment(options: {
  id: string;
  deleteNetworks?: boolean;
}): Promise<void> {
  const { id, deleteNetworks = false } = options;
  const url = new URL(ApiRoute.environments.get(id), window.location.origin);

  // Add query parameters for deletion options
  if (deleteNetworks) url.searchParams.set("deleteNetworks", "true");

  await apiFetch<void>(url.toString(), {
    method: "DELETE",
    correlationIdPrefix: "environments",
    unwrap: false,
  });
}

async function fetchEnvironmentDeleteCheck(
  id: string,
): Promise<EnvironmentDeleteCheck> {
  return apiFetch<EnvironmentDeleteCheck>(ApiRoute.environments.deleteCheck(id), {
    correlationIdPrefix: "environments",
    unwrap: false,
  });
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

  return useQuery({
    queryKey: queryKeys.environments.list(filters),
    queryFn: () => fetchEnvironments(filters),
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

  return useQuery({
    queryKey: queryKeys.environments.detail(id),
    queryFn: () => fetchEnvironment(id),
    enabled: enabled && !!id,
    refetchInterval,
    retry:
      typeof retry === "function"
        ? retry
        : (failureCount: number, error: Error) => {
            if (
              error instanceof ApiRequestError &&
              (error.isAuth || error.status === 404)
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

  return useMutation({
    mutationFn: (request: CreateEnvironmentRequest) =>
      createEnvironment(request),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.environments.all });
    },
  });
}

export function useUpdateEnvironment() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      id,
      request,
    }: {
      id: string;
      request: UpdateEnvironmentRequest;
    }) => updateEnvironment(id, request),
    onSuccess: (_, { id }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.environments.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.environments.detail(id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.environments.status(id) });
    },
  });
}

export function useDeleteEnvironment() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (options: { id: string; deleteNetworks?: boolean }) =>
      deleteEnvironment(options),
    onSuccess: (_, options) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.environments.all });
      queryClient.removeQueries({ queryKey: queryKeys.environments.detail(options.id) });
      queryClient.removeQueries({ queryKey: queryKeys.environments.status(options.id) });
    },
  });
}

export function useEnvironmentDeleteCheck(
  id: string,
  options: { enabled?: boolean } = {},
) {
  const { enabled = true } = options;

  return useQuery({
    queryKey: queryKeys.environments.deleteCheck(id),
    queryFn: () => fetchEnvironmentDeleteCheck(id),
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
