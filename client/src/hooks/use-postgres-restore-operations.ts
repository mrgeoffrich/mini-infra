import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useCallback } from "react";
import {
  RestoreOperationInfo,
  RestoreOperationListResponse,
  RestoreOperationResponse,
  RestoreOperationStatusResponse,
  CreateRestoreOperationRequest,
  CreateRestoreOperationResponse,
  RestoreOperationFilter,
  RestoreOperationSortOptions,
  RestoreOperationStatus,
  RestoreOperationProgress,
  BackupBrowserItem,
  BackupBrowserResponse,
  BackupBrowserFilter,
  BackupBrowserSortOptions,
} from "@mini-infra/types";

// Generate correlation ID for debugging
function generateCorrelationId(): string {
  return `postgres-restore-ops-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// ====================
// PostgreSQL Restore Operations API Functions
// ====================

async function fetchPostgresRestoreOperations(
  databaseId: string,
  filters: RestoreOperationFilter = {},
  page = 1,
  limit = 20,
  sortBy: keyof RestoreOperationInfo = "startedAt",
  sortOrder: "asc" | "desc" = "desc",
  correlationId: string,
): Promise<RestoreOperationListResponse> {
  const url = new URL(
    `/api/postgres/restore/${databaseId}/operations`,
    window.location.origin,
  );

  // Add query parameters
  url.searchParams.set("page", page.toString());
  url.searchParams.set("limit", limit.toString());
  url.searchParams.set("sortBy", sortBy);
  url.searchParams.set("sortOrder", sortOrder);
  if (filters.status) url.searchParams.set("status", filters.status);
  if (filters.startedAfter)
    url.searchParams.set("startedAfter", filters.startedAfter);
  if (filters.startedBefore)
    url.searchParams.set("startedBefore", filters.startedBefore);

  const response = await fetch(url.toString(), {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch restore operations: ${response.statusText}`,
    );
  }

  const data: RestoreOperationListResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to fetch restore operations");
  }

  return data;
}

async function fetchPostgresRestoreOperationStatus(
  operationId: string,
  correlationId: string,
): Promise<RestoreOperationStatusResponse> {
  const response = await fetch(`/api/postgres/restore/${operationId}/status`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch restore operation status: ${response.statusText}`,
    );
  }

  const data: RestoreOperationStatusResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to fetch restore operation status");
  }

  return data;
}

async function createRestoreOperation(
  request: CreateRestoreOperationRequest,
  correlationId: string,
): Promise<CreateRestoreOperationResponse> {
  const response = await fetch(`/api/postgres/restore/${request.databaseId}`, {
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
      `Failed to create restore operation: ${response.statusText}`,
    );
  }

  const data: CreateRestoreOperationResponse = await response.json();

  if (!data.success) {
    throw new Error(data.data?.message || "Failed to create restore operation");
  }

  return data;
}

async function fetchRestoreOperationProgress(
  operationId: string,
  correlationId: string,
): Promise<{ success: boolean; data: RestoreOperationProgress }> {
  const response = await fetch(
    `/api/postgres/restore/${operationId}/progress`,
    {
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "X-Correlation-ID": correlationId,
      },
    },
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch restore progress: ${response.statusText}`);
  }

  const data = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to fetch restore progress");
  }

  return data;
}

async function fetchAvailableBackups(
  containerName: string,
  filters: BackupBrowserFilter = {},
  page = 1,
  limit = 20,
  sortBy: "createdAt" | "sizeBytes" | "name" = "createdAt",
  sortOrder: "asc" | "desc" = "desc",
  correlationId: string,
): Promise<BackupBrowserResponse> {
  const url = new URL(
    `/api/postgres/restore/backups/${containerName}`,
    window.location.origin,
  );

  // Add query parameters
  url.searchParams.set("page", page.toString());
  url.searchParams.set("limit", limit.toString());
  url.searchParams.set("sortBy", sortBy);
  url.searchParams.set("sortOrder", sortOrder);
  if (filters.createdAfter)
    url.searchParams.set("createdAfter", filters.createdAfter);
  if (filters.createdBefore)
    url.searchParams.set("createdBefore", filters.createdBefore);
  if (filters.sizeMin)
    url.searchParams.set("sizeMin", filters.sizeMin.toString());
  if (filters.sizeMax)
    url.searchParams.set("sizeMax", filters.sizeMax.toString());

  const response = await fetch(url.toString(), {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch available backups: ${response.statusText}`,
    );
  }

  const data: BackupBrowserResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to fetch available backups");
  }

  return data;
}

// ====================
// PostgreSQL Restore Operations Hooks
// ====================

export interface UsePostgresRestoreOperationsOptions {
  enabled?: boolean;
  refetchInterval?: number;
  retry?: number | boolean | ((failureCount: number, error: Error) => boolean);
  filters?: RestoreOperationFilter;
  page?: number;
  limit?: number;
  sortBy?: keyof RestoreOperationInfo;
  sortOrder?: "asc" | "desc";
}

export function usePostgresRestoreOperations(
  databaseId: string,
  options: UsePostgresRestoreOperationsOptions = {},
) {
  const {
    enabled = true,
    refetchInterval = 30000, // Auto-refresh every 30 seconds for active operations
    retry = 3,
    filters = {},
    page = 1,
    limit = 20,
    sortBy = "startedAt",
    sortOrder = "desc",
  } = options;

  const correlationId = generateCorrelationId();

  return useQuery({
    queryKey: [
      "postgresRestoreOperations",
      databaseId,
      filters,
      page,
      limit,
      sortBy,
      sortOrder,
    ],
    queryFn: () =>
      fetchPostgresRestoreOperations(
        databaseId,
        filters,
        page,
        limit,
        sortBy,
        sortOrder,
        correlationId,
      ),
    enabled: enabled && !!databaseId,
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

export interface UsePostgresRestoreOperationStatusOptions {
  enabled?: boolean;
  refetchInterval?: number;
  retry?: number | boolean | ((failureCount: number, error: Error) => boolean);
}

export function usePostgresRestoreOperationStatus(
  operationId: string,
  options: UsePostgresRestoreOperationStatusOptions = {},
) {
  const {
    enabled = true,
    refetchInterval = 5000, // Check status every 5 seconds for active operations
    retry = 3,
  } = options;

  const correlationId = generateCorrelationId();

  return useQuery({
    queryKey: ["postgresRestoreOperationStatus", operationId],
    queryFn: () =>
      fetchPostgresRestoreOperationStatus(operationId, correlationId),
    enabled: enabled && !!operationId,
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
    staleTime: 2000, // Status data is fresh for 2 seconds
    gcTime: 5 * 60 * 1000, // Keep in cache for 5 minutes
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

export interface UsePostgresRestoreOperationProgressOptions {
  enabled?: boolean;
  refetchInterval?: number;
  retry?: number | boolean | ((failureCount: number, error: Error) => boolean);
}

export function usePostgresRestoreOperationProgress(
  operationId: string,
  options: UsePostgresRestoreOperationProgressOptions = {},
) {
  const {
    enabled = true,
    refetchInterval = 3000, // Check progress every 3 seconds for active operations
    retry = 3,
  } = options;

  const correlationId = generateCorrelationId();

  return useQuery({
    queryKey: ["postgresRestoreOperationProgress", operationId],
    queryFn: () => fetchRestoreOperationProgress(operationId, correlationId),
    enabled: enabled && !!operationId,
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
    staleTime: 1000, // Progress data is fresh for 1 second
    gcTime: 5 * 60 * 1000, // Keep in cache for 5 minutes
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

export interface UseAvailableBackupsOptions {
  enabled?: boolean;
  refetchInterval?: number;
  retry?: number | boolean | ((failureCount: number, error: Error) => boolean);
  filters?: BackupBrowserFilter;
  page?: number;
  limit?: number;
  sortBy?: "createdAt" | "sizeBytes" | "name";
  sortOrder?: "asc" | "desc";
}

export function useAvailableBackups(
  containerName: string,
  options: UseAvailableBackupsOptions = {},
) {
  const {
    enabled = true,
    refetchInterval,
    retry = 3,
    filters = {},
    page = 1,
    limit = 20,
    sortBy = "createdAt",
    sortOrder = "desc",
  } = options;

  const correlationId = generateCorrelationId();

  return useQuery({
    queryKey: [
      "availableBackups",
      containerName,
      filters,
      page,
      limit,
      sortBy,
      sortOrder,
    ],
    queryFn: () =>
      fetchAvailableBackups(
        containerName,
        filters,
        page,
        limit,
        sortBy,
        sortOrder,
        correlationId,
      ),
    enabled: enabled && !!containerName,
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
            // Don't retry on configuration errors (likely missing Azure config)
            if (
              error.message.includes("No configuration found") ||
              error.message.includes("Invalid container")
            ) {
              return false;
            }
            // Retry up to the specified number of times for other errors
            return typeof retry === "boolean" ? retry : failureCount < retry;
          },
    retryDelay: (attemptIndex) => Math.min(2000 * 2 ** attemptIndex, 30000), // Longer delays for Azure API calls
    staleTime: 60000, // Backup list data is fresh for 1 minute
    gcTime: 10 * 60 * 1000, // Keep in cache for 10 minutes
    refetchOnWindowFocus: false, // Don't auto-refetch on focus as it might be expensive
    refetchOnReconnect: true,
  });
}

// Mutation hooks for restore operations
export function useCreateRestoreOperation() {
  const queryClient = useQueryClient();
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: (request: CreateRestoreOperationRequest) =>
      createRestoreOperation(request, correlationId),
    onSuccess: (_, request) => {
      // Invalidate and refetch restore operations list
      queryClient.invalidateQueries({
        queryKey: ["postgresRestoreOperations", request.databaseId],
      });
    },
  });
}

// ====================
// Restore Operations Filter Hook
// ====================

export interface PostgresRestoreOperationFiltersState {
  status?: RestoreOperationStatus;
  startedAfter?: Date;
  startedBefore?: Date;
  sortBy: keyof RestoreOperationInfo;
  sortOrder: "asc" | "desc";
  page: number;
  limit: number;
}

export function usePostgresRestoreOperationFilters(
  initialFilters: Partial<PostgresRestoreOperationFiltersState> = {},
) {
  const [filters, setFilters] = useState<PostgresRestoreOperationFiltersState>({
    sortBy: "startedAt",
    sortOrder: "desc",
    page: 1,
    limit: 20,
    ...initialFilters,
  });

  const updateFilter = useCallback(
    <K extends keyof PostgresRestoreOperationFiltersState>(
      key: K,
      value: PostgresRestoreOperationFiltersState[K],
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
      sortBy: "startedAt",
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
// Backup Browser Filter Hook
// ====================

export interface BackupBrowserFiltersState {
  createdAfter?: Date;
  createdBefore?: Date;
  sizeMin?: number;
  sizeMax?: number;
  sortBy: "createdAt" | "sizeBytes" | "name";
  sortOrder: "asc" | "desc";
  page: number;
  limit: number;
}

export function useBackupBrowserFilters(
  initialFilters: Partial<BackupBrowserFiltersState> = {},
) {
  const [filters, setFilters] = useState<BackupBrowserFiltersState>({
    sortBy: "createdAt",
    sortOrder: "desc",
    page: 1,
    limit: 20,
    ...initialFilters,
  });

  const updateFilter = useCallback(
    <K extends keyof BackupBrowserFiltersState>(
      key: K,
      value: BackupBrowserFiltersState[K],
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
      sortBy: "createdAt",
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
  RestoreOperationInfo,
  RestoreOperationListResponse,
  RestoreOperationResponse,
  RestoreOperationStatusResponse,
  CreateRestoreOperationRequest,
  CreateRestoreOperationResponse,
  RestoreOperationFilter,
  RestoreOperationSortOptions,
  RestoreOperationStatus,
  RestoreOperationProgress,
  BackupBrowserItem,
  BackupBrowserResponse,
  BackupBrowserFilter,
  BackupBrowserSortOptions,
};
