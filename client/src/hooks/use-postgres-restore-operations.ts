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
  ApiRoute,
  queryKeys,
} from "@mini-infra/types";
import { apiFetch } from "@/lib/api-client";

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
): Promise<RestoreOperationListResponse> {
  const url = new URL(
    ApiRoute.postgres.restoreOperations(databaseId),
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

  return apiFetch<RestoreOperationListResponse>(url.toString(), {
    correlationIdPrefix: "postgres-restore-ops",
    unwrap: false,
  });
}

async function fetchPostgresRestoreOperationStatus(
  operationId: string,
): Promise<RestoreOperationStatusResponse> {
  return apiFetch<RestoreOperationStatusResponse>(
    ApiRoute.postgres.restoreStatus(operationId),
    { correlationIdPrefix: "postgres-restore-ops", unwrap: false },
  );
}

async function createRestoreOperation(
  request: CreateRestoreOperationRequest,
): Promise<CreateRestoreOperationResponse> {
  return apiFetch<CreateRestoreOperationResponse>(
    ApiRoute.postgres.restore(request.databaseId),
    {
      method: "POST",
      body: request,
      correlationIdPrefix: "postgres-restore-ops",
      unwrap: false,
    },
  );
}

async function fetchRestoreOperationProgress(
  operationId: string,
): Promise<{ success: boolean; data: RestoreOperationProgress }> {
  return apiFetch(ApiRoute.postgres.restoreProgress(operationId), {
    correlationIdPrefix: "postgres-restore-ops",
    unwrap: false,
  });
}

async function fetchAvailableBackups(
  containerName: string,
  databaseId: string,
  filters: BackupBrowserFilter = {},
  page = 1,
  limit = 20,
  sortBy: "createdAt" | "sizeBytes" | "name" = "createdAt",
  sortOrder: "asc" | "desc" = "desc",
): Promise<BackupBrowserResponse> {
  // The server route is `GET /api/postgres/restore/backups/:containerName`
  // (no `:databaseId` path segment — appending one 404'd). Backups live in a
  // container shared across databases and are keyed by a `<databaseId>/...`
  // blob prefix, so we scope to the current database with a `databaseId`
  // query param that the route filters on.
  const url = new URL(
    ApiRoute.postgres.restoreBackupsForContainer(containerName),
    window.location.origin,
  );

  // Add query parameters
  url.searchParams.set("databaseId", databaseId);
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

  return apiFetch<BackupBrowserResponse>(url.toString(), {
    correlationIdPrefix: "postgres-restore-ops",
    unwrap: false,
  });
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

  return useQuery({
    queryKey: queryKeys.postgresRestoreOperations.list(
      databaseId,
      filters,
      page,
      limit,
      sortBy,
      sortOrder,
    ),
    queryFn: () =>
      fetchPostgresRestoreOperations(
        databaseId,
        filters,
        page,
        limit,
        sortBy,
        sortOrder,
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

  return useQuery({
    queryKey: queryKeys.postgresRestoreOperations.status(operationId),
    queryFn: () =>
      fetchPostgresRestoreOperationStatus(operationId),
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

  return useQuery({
    queryKey: queryKeys.postgresRestoreOperations.progress(operationId),
    queryFn: () => fetchRestoreOperationProgress(operationId),
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
  databaseId: string,
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

  return useQuery({
    queryKey: queryKeys.postgresRestoreOperations.availableBackups(
      containerName,
      databaseId,
      filters,
      page,
      limit,
      sortBy,
      sortOrder,
    ),
    queryFn: () =>
      fetchAvailableBackups(
        containerName,
        databaseId,
        filters,
        page,
        limit,
        sortBy,
        sortOrder,
      ),
    enabled: enabled && !!containerName && !!databaseId,
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

  return useMutation({
    mutationFn: (request: CreateRestoreOperationRequest) =>
      createRestoreOperation(request),
    onSuccess: (_, request) => {
      // Invalidate and refetch restore operations list
      queryClient.invalidateQueries({
        queryKey: queryKeys.postgresRestoreOperations.forDatabase(request.databaseId),
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
