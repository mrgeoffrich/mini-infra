import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useCallback } from "react";
import {
  DeploymentConfigurationInfo,
  DeploymentConfigListResponse,
  DeploymentConfigResponse,
  CreateDeploymentConfigRequest,
  UpdateDeploymentConfigRequest,
  DeploymentConfigFilter,
  DeploymentConfigSortOptions,
  UninstallDeploymentConfigResponse,
} from "@mini-infra/types";

// Generate correlation ID for debugging
function generateCorrelationId(): string {
  return `deployment-config-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// ====================
// Deployment Configuration API Functions
// ====================

async function fetchDeploymentConfigs(
  filters: DeploymentConfigFilter = {},
  page = 1,
  limit = 20,
  sortBy: keyof DeploymentConfigurationInfo = "applicationName",
  sortOrder: "asc" | "desc" = "asc",
  correlationId: string,
): Promise<DeploymentConfigListResponse> {
  const url = new URL(`/api/deployments/configs`, window.location.origin);

  // Add query parameters
  url.searchParams.set("page", page.toString());
  url.searchParams.set("limit", limit.toString());
  url.searchParams.set("sortBy", sortBy);
  url.searchParams.set("sortOrder", sortOrder);
  if (filters.applicationName) url.searchParams.set("applicationName", filters.applicationName);
  if (filters.dockerImage) url.searchParams.set("dockerImage", filters.dockerImage);
  if (filters.isActive !== undefined) url.searchParams.set("isActive", filters.isActive.toString());

  const response = await fetch(url.toString(), {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch deployment configurations: ${response.statusText}`,
    );
  }

  const data: DeploymentConfigListResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to fetch deployment configurations");
  }

  return data;
}

async function fetchDeploymentConfig(
  id: string,
  correlationId: string,
): Promise<DeploymentConfigResponse> {
  const response = await fetch(`/api/deployments/configs/${id}`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch deployment configuration: ${response.statusText}`,
    );
  }

  const data: DeploymentConfigResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to fetch deployment configuration");
  }

  return data;
}

async function createDeploymentConfig(
  request: CreateDeploymentConfigRequest,
  correlationId: string,
): Promise<DeploymentConfigResponse> {
  const response = await fetch(`/api/deployments/configs`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to create deployment configuration: ${response.statusText}`,
    );
  }

  const data: DeploymentConfigResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to create deployment configuration");
  }

  return data;
}

async function updateDeploymentConfig(
  id: string,
  request: UpdateDeploymentConfigRequest,
  correlationId: string,
): Promise<DeploymentConfigResponse> {
  const response = await fetch(`/api/deployments/configs/${id}`, {
    method: "PUT",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to update deployment configuration: ${response.statusText}`,
    );
  }

  const data: DeploymentConfigResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to update deployment configuration");
  }

  return data;
}

async function deleteDeploymentConfig(
  id: string,
  correlationId: string,
): Promise<{ success: boolean; message: string }> {
  const response = await fetch(`/api/deployments/configs/${id}`, {
    method: "DELETE",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(errorData.message || `Failed to delete deployment configuration: ${response.statusText}`);
  }

  const data = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to delete deployment configuration");
  }

  return data;
}

async function removeDeploymentContainers(
  id: string,
  correlationId: string,
): Promise<UninstallDeploymentConfigResponse> {
  const response = await fetch(`/api/deployments/configs/${id}/remove-containers`, {
    method: "DELETE",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to remove deployment containers: ${response.statusText}`,
    );
  }

  const data: UninstallDeploymentConfigResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to remove deployment containers");
  }

  return data;
}

// ====================
// Deployment Configuration Hooks
// ====================

export interface UseDeploymentConfigsOptions {
  enabled?: boolean;
  refetchInterval?: number;
  retry?: number | boolean | ((failureCount: number, error: Error) => boolean);
  filters?: DeploymentConfigFilter;
  page?: number;
  limit?: number;
  sortBy?: keyof DeploymentConfigurationInfo;
  sortOrder?: "asc" | "desc";
}

export function useDeploymentConfigs(
  options: UseDeploymentConfigsOptions = {},
) {
  const {
    enabled = true,
    refetchInterval,
    retry = 3,
    filters = {},
    page = 1,
    limit = 20,
    sortBy = "applicationName",
    sortOrder = "asc",
  } = options;

  const correlationId = generateCorrelationId();

  return useQuery({
    queryKey: ["deploymentConfigs", filters, page, limit, sortBy, sortOrder],
    queryFn: () =>
      fetchDeploymentConfigs(
        filters,
        page,
        limit,
        sortBy,
        sortOrder,
        correlationId,
      ),
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

export interface UseDeploymentConfigOptions {
  enabled?: boolean;
  refetchInterval?: number;
  retry?: number | boolean | ((failureCount: number, error: Error) => boolean);
}

export function useDeploymentConfig(
  id: string,
  options: UseDeploymentConfigOptions = {},
) {
  const { enabled = true, refetchInterval, retry = 3 } = options;

  const correlationId = generateCorrelationId();

  return useQuery({
    queryKey: ["deploymentConfig", id],
    queryFn: () => fetchDeploymentConfig(id, correlationId),
    enabled: enabled && !!id,
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

// Mutation hooks for deployment configuration operations
export function useCreateDeploymentConfig() {
  const queryClient = useQueryClient();
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: (request: CreateDeploymentConfigRequest) =>
      createDeploymentConfig(request, correlationId),
    onSuccess: () => {
      // Invalidate and refetch deployment configs list
      queryClient.invalidateQueries({ queryKey: ["deploymentConfigs"] });
    },
  });
}

export function useUpdateDeploymentConfig() {
  const queryClient = useQueryClient();
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: ({
      id,
      request,
    }: {
      id: string;
      request: UpdateDeploymentConfigRequest;
    }) => updateDeploymentConfig(id, request, correlationId),
    onSuccess: (_, { id }) => {
      // Invalidate and refetch deployment configs list and specific config
      queryClient.invalidateQueries({ queryKey: ["deploymentConfigs"] });
      queryClient.invalidateQueries({ queryKey: ["deploymentConfig", id] });
      // Also invalidate deployments history as config changes might affect them
      queryClient.invalidateQueries({ queryKey: ["deploymentHistory"] });
    },
  });
}

export function useDeleteDeploymentConfig() {
  const queryClient = useQueryClient();
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: (id: string) => deleteDeploymentConfig(id, correlationId),
    onSuccess: async (_, id) => {
      // Invalidate and refetch deployment configs list
      await queryClient.invalidateQueries({ queryKey: ["deploymentConfigs"] });
      // Remove specific deployment config from cache
      queryClient.removeQueries({ queryKey: ["deploymentConfig", id] });
      // Remove related deployment data
      queryClient.removeQueries({ queryKey: ["deploymentHistory", id] });
      queryClient.removeQueries({ queryKey: ["deploymentStatus", id] });
      // Invalidate deployment history queries
      await queryClient.invalidateQueries({ queryKey: ["activeDeployments"] });
      await queryClient.invalidateQueries({ queryKey: ["latestDeployments"] });
    },
  });
}

export function useRemoveDeploymentContainers() {
  const queryClient = useQueryClient();
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: (id: string) => removeDeploymentContainers(id, correlationId),
    onSuccess: () => {
      // Invalidate deployment data to reflect removal
      queryClient.invalidateQueries({ queryKey: ["deploymentHistory"] });
      queryClient.invalidateQueries({ queryKey: ["activeDeployments"] });
      queryClient.invalidateQueries({ queryKey: ["latestDeployments"] });
      // Invalidate containers list
      queryClient.invalidateQueries({ queryKey: ["containers"] });
    },
  });
}

// ====================
// Deployment Configuration Filter Hook
// ====================

export interface DeploymentConfigFiltersState {
  applicationName?: string;
  dockerImage?: string;
  isActive?: boolean;
  sortBy: keyof DeploymentConfigurationInfo;
  sortOrder: "asc" | "desc";
  page: number;
  limit: number;
}

export function useDeploymentConfigFilters(
  initialFilters: Partial<DeploymentConfigFiltersState> = {},
) {
  const [filters, setFilters] = useState<DeploymentConfigFiltersState>({
    sortBy: "applicationName",
    sortOrder: "asc",
    page: 1,
    limit: 20,
    ...initialFilters,
  });

  const updateFilter = useCallback(
    <K extends keyof DeploymentConfigFiltersState>(
      key: K,
      value: DeploymentConfigFiltersState[K],
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
      sortBy: "applicationName",
      sortOrder: "asc",
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
  DeploymentConfigurationInfo,
  DeploymentConfigListResponse,
  DeploymentConfigResponse,
  CreateDeploymentConfigRequest,
  UpdateDeploymentConfigRequest,
  DeploymentConfigFilter,
  DeploymentConfigSortOptions,
};