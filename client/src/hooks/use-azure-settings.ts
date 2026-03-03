import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useCallback } from "react";
import {
  AzureSettingResponse,
  AzureValidationResponse,
  AzureContainerListResponse,
  AzureContainerAccessResponse,
  CreateAzureSettingRequest,
  UpdateAzureSettingRequest,
  ValidateAzureConnectionRequest,
  ConnectivityStatusInfo,
  ConnectivityStatusListResponse,
  ConnectivityStatusFilter,
  AzureContainerFilter,
  AzureContainerSortOptions,
} from "@mini-infra/types";

// Generate correlation ID for debugging
function generateCorrelationId(): string {
  return `azure-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// ====================
// Azure Settings API Functions
// ====================

async function fetchAzureSettings(
  correlationId: string,
): Promise<AzureSettingResponse> {
  const response = await fetch(`/api/settings/azure`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch Azure settings: ${response.statusText}`);
  }

  const data: AzureSettingResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to fetch Azure settings");
  }

  return data;
}

async function updateAzureSettings(
  settings: UpdateAzureSettingRequest,
  correlationId: string,
): Promise<AzureSettingResponse> {
  const response = await fetch(`/api/settings/azure`, {
    method: "PUT",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
    body: JSON.stringify(settings),
  });

  if (!response.ok) {
    throw new Error(`Failed to update Azure settings: ${response.statusText}`);
  }

  const data: AzureSettingResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to update Azure settings");
  }

  return data;
}

async function validateAzureConnection(
  request: ValidateAzureConnectionRequest,
  correlationId: string,
): Promise<AzureValidationResponse> {
  const response = await fetch(`/api/settings/azure/validate`, {
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
      `Failed to validate Azure connection: ${response.statusText}`,
    );
  }

  const data: AzureValidationResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to validate Azure connection");
  }

  return data;
}

async function deleteAzureSettings(
  correlationId: string,
): Promise<{ success: boolean; message: string }> {
  const response = await fetch(`/api/settings/azure`, {
    method: "DELETE",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to delete Azure settings: ${response.statusText}`);
  }

  const data = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to delete Azure settings");
  }

  return data;
}

async function fetchAzureContainers(
  correlationId: string,
): Promise<AzureContainerListResponse> {
  const response = await fetch(`/api/settings/azure/containers`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch Azure containers: ${response.statusText}`);
  }

  const data: AzureContainerListResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to fetch Azure containers");
  }

  return data;
}

async function testAzureContainerAccess(
  containerName: string,
  correlationId: string,
): Promise<AzureContainerAccessResponse> {
  const response = await fetch(`/api/settings/azure/test-container`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
    body: JSON.stringify({ containerName }),
  });

  if (!response.ok) {
    throw new Error(`Failed to test container access: ${response.statusText}`);
  }

  const data: AzureContainerAccessResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to test container access");
  }

  return data;
}

// Azure Connectivity Status API Functions
async function fetchAzureConnectivityStatus(
  correlationId: string,
): Promise<ConnectivityStatusInfo> {
  const response = await fetch(`/api/connectivity/azure`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    if (response.status === 404) {
      // No connectivity status found - return a default status
      return {
        id: "no-status",
        service: "azure",
        status: "unreachable",
        responseTimeMs: null,
        errorMessage: "No connectivity status available",
        errorCode: null,
        lastSuccessfulAt: null,
        checkedAt: new Date().toISOString(),
        checkInitiatedBy: "system",
        metadata: null,
      };
    }
    throw new Error(
      `Failed to fetch Azure connectivity status: ${response.statusText}`,
    );
  }

  const data = await response.json();

  if (!data.success) {
    throw new Error(
      data.message || "Failed to fetch Azure connectivity status",
    );
  }

  return data.data;
}

async function fetchAzureConnectivityHistory(
  filters: ConnectivityStatusFilter = {},
  page = 1,
  limit = 20,
  sortBy: "checkedAt" | "status" | "responseTimeMs" = "checkedAt",
  sortOrder: "asc" | "desc" = "desc",
  correlationId: string,
): Promise<ConnectivityStatusListResponse> {
  const url = new URL(
    `/api/connectivity/azure/history`,
    window.location.origin,
  );

  // Add query parameters
  url.searchParams.set("page", page.toString());
  url.searchParams.set("limit", limit.toString());
  url.searchParams.set("sortBy", sortBy);
  url.searchParams.set("sortOrder", sortOrder);
  if (filters.status) url.searchParams.set("status", filters.status);
  if (filters.checkInitiatedBy)
    url.searchParams.set("checkInitiatedBy", filters.checkInitiatedBy);
  if (filters.startDate)
    url.searchParams.set("startDate", filters.startDate.toISOString());
  if (filters.endDate)
    url.searchParams.set("endDate", filters.endDate.toISOString());

  const response = await fetch(url.toString(), {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch Azure connectivity history: ${response.statusText}`,
    );
  }

  const data: ConnectivityStatusListResponse = await response.json();

  if (!data.success) {
    throw new Error(
      data.message || "Failed to fetch Azure connectivity history",
    );
  }

  return data;
}

// ====================
// Azure Settings Hooks
// ====================

export interface UseAzureSettingsOptions {
  enabled?: boolean;
  refetchInterval?: number;
  retry?: number | boolean | ((failureCount: number, error: Error) => boolean);
}

export function useAzureSettings(options: UseAzureSettingsOptions = {}) {
  const { enabled = true, refetchInterval, retry = 3 } = options;

  const correlationId = generateCorrelationId();

  return useQuery({
    queryKey: ["azureSettings"],
    queryFn: () => fetchAzureSettings(correlationId),
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
    staleTime: 5000, // Data is fresh for 5 seconds
    gcTime: 5 * 60 * 1000, // Keep in cache for 5 minutes
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

// Mutation hooks for Azure settings operations
export function useUpdateAzureSettings() {
  const queryClient = useQueryClient();
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: (settings: UpdateAzureSettingRequest) =>
      updateAzureSettings(settings, correlationId),
    onSuccess: () => {
      // Invalidate and refetch Azure settings
      queryClient.invalidateQueries({ queryKey: ["azureSettings"] });
      // Also invalidate connectivity status as it may have changed
      queryClient.invalidateQueries({ queryKey: ["azureConnectivityStatus"] });
    },
  });
}

export function useValidateAzureConnection() {
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: (request: ValidateAzureConnectionRequest = {}) =>
      validateAzureConnection(request, correlationId),
  });
}

export function useDeleteAzureSettings() {
  const queryClient = useQueryClient();
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: () => deleteAzureSettings(correlationId),
    onSuccess: () => {
      // Invalidate and refetch Azure settings
      queryClient.invalidateQueries({ queryKey: ["azureSettings"] });
      // Clear containers cache as they're no longer accessible
      queryClient.removeQueries({ queryKey: ["azureContainers"] });
      // Also invalidate connectivity status
      queryClient.invalidateQueries({ queryKey: ["azureConnectivityStatus"] });
    },
  });
}

// ====================
// Azure Containers Hooks
// ====================

export interface UseAzureContainersOptions {
  enabled?: boolean;
  refetchInterval?: number;
  retry?: number | boolean | ((failureCount: number, error: Error) => boolean);
}

export function useAzureContainers(options: UseAzureContainersOptions = {}) {
  const { enabled = true, refetchInterval, retry = 3 } = options;

  const correlationId = generateCorrelationId();

  return useQuery({
    queryKey: ["azureContainers"],
    queryFn: () => fetchAzureContainers(correlationId),
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
            // Don't retry on Azure configuration errors (likely missing config)
            if (
              error.message.includes("Failed to fetch Azure containers") ||
              error.message.includes("No configuration found")
            ) {
              return false;
            }
            // Retry up to the specified number of times for other errors
            return typeof retry === "boolean" ? retry : failureCount < retry;
          },
    retryDelay: (attemptIndex) => Math.min(2000 * 2 ** attemptIndex, 30000), // Longer delays for Azure API calls
    staleTime: 30000, // Container data is fresh for 30 seconds
    gcTime: 5 * 60 * 1000, // Keep in cache for 5 minutes
    refetchOnWindowFocus: false, // Don't auto-refetch on focus as it might be expensive
    refetchOnReconnect: true,
  });
}

export function useTestAzureContainerAccess() {
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: (containerName: string) =>
      testAzureContainerAccess(containerName, correlationId),
  });
}

// ====================
// Azure Connectivity Status Hooks
// ====================

export interface UseAzureConnectivityStatusOptions {
  enabled?: boolean;
  refetchInterval?: number;
  retry?: number | boolean | ((failureCount: number, error: Error) => boolean);
}

export function useAzureConnectivityStatus(
  options: UseAzureConnectivityStatusOptions = {},
) {
  const {
    enabled = true,
    refetchInterval = 30000, // 30 seconds for connectivity status
    retry = 3,
  } = options;

  const correlationId = generateCorrelationId();

  return useQuery({
    queryKey: ["azureConnectivityStatus"],
    queryFn: () => fetchAzureConnectivityStatus(correlationId),
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
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),
    staleTime: 10000, // Data is fresh for 10 seconds
    gcTime: 5 * 60 * 1000, // Keep in cache for 5 minutes
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

export interface UseAzureConnectivityHistoryOptions {
  enabled?: boolean;
  filters?: ConnectivityStatusFilter;
  page?: number;
  limit?: number;
  sortBy?: "checkedAt" | "status" | "responseTimeMs";
  sortOrder?: "asc" | "desc";
  retry?: number | boolean | ((failureCount: number, error: Error) => boolean);
}

export function useAzureConnectivityHistory(
  options: UseAzureConnectivityHistoryOptions = {},
) {
  const {
    enabled = true,
    filters = {},
    page = 1,
    limit = 20,
    sortBy = "checkedAt",
    sortOrder = "desc",
    retry = 3,
  } = options;

  const correlationId = generateCorrelationId();

  return useQuery({
    queryKey: [
      "azureConnectivityHistory",
      filters,
      page,
      limit,
      sortBy,
      sortOrder,
    ],
    queryFn: () =>
      fetchAzureConnectivityHistory(
        filters,
        page,
        limit,
        sortBy,
        sortOrder,
        correlationId,
      ),
    enabled,
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
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),
    staleTime: 30000, // History data is fresh for 30 seconds
    gcTime: 10 * 60 * 1000, // Keep in cache for 10 minutes
    refetchOnWindowFocus: false, // Don't auto-refetch history on focus
    refetchOnReconnect: true,
  });
}

// ====================
// Container Filter Hook
// ====================

export interface AzureContainerFiltersState {
  namePrefix?: string;
  leaseStatus?: "locked" | "unlocked";
  leaseState?: "available" | "leased" | "expired" | "breaking" | "broken";
  publicAccess?: "container" | "blob" | null;
  hasMetadata?: boolean;
  lastModifiedAfter?: Date;
  lastModifiedBefore?: Date;
  sortBy: "name" | "lastModified" | "leaseStatus";
  sortOrder: "asc" | "desc";
  page: number;
  limit: number;
}

export function useAzureContainerFilters(
  initialFilters: Partial<AzureContainerFiltersState> = {},
) {
  const [filters, setFilters] = useState<AzureContainerFiltersState>({
    sortBy: "name",
    sortOrder: "asc",
    page: 1,
    limit: 20,
    ...initialFilters,
  });

  const updateFilter = useCallback(
    <K extends keyof AzureContainerFiltersState>(
      key: K,
      value: AzureContainerFiltersState[K],
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
      sortBy: "name",
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
// Connectivity History Filter Hook
// ====================

export interface AzureConnectivityFiltersState {
  status?: "connected" | "failed" | "timeout" | "unreachable";
  checkInitiatedBy?: string;
  startDate?: Date;
  endDate?: Date;
  sortBy: "checkedAt" | "status" | "responseTimeMs";
  sortOrder: "asc" | "desc";
  page: number;
  limit: number;
}

export function useAzureConnectivityFilters(
  initialFilters: Partial<AzureConnectivityFiltersState> = {},
) {
  const [filters, setFilters] = useState<AzureConnectivityFiltersState>({
    sortBy: "checkedAt",
    sortOrder: "desc",
    page: 1,
    limit: 20,
    ...initialFilters,
  });

  const updateFilter = useCallback(
    <K extends keyof AzureConnectivityFiltersState>(
      key: K,
      value: AzureConnectivityFiltersState[K],
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
      sortBy: "checkedAt",
      sortOrder: "desc",
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
  AzureSettingResponse,
  AzureValidationResponse,
  AzureContainerListResponse,
  AzureContainerAccessResponse,
  CreateAzureSettingRequest,
  UpdateAzureSettingRequest,
  ValidateAzureConnectionRequest,
  ConnectivityStatusInfo,
  ConnectivityStatusListResponse,
  ConnectivityStatusFilter,
  AzureContainerFilter,
  AzureContainerSortOptions,
};
