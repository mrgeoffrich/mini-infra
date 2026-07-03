import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useCallback } from "react";
import {
  BackupOperationInfo,
  BackupOperationListResponse,
  BackupOperationResponse,
  BackupOperationStatusResponse,
  BackupOperationDeleteResponse,
  ManualBackupResponse,
  CreateManualBackupRequest,
  BackupOperationFilter,
  BackupOperationSortOptions,
  BackupOperationType,
  BackupOperationStatus,
  BackupOperationProgress,
  ApiRoute,
  queryKeys,
} from "@mini-infra/types";
import { apiFetch } from "@/lib/api-client";

// ====================
// PostgreSQL Backup Operations API Functions
// ====================

async function fetchPostgresBackupOperations(
  databaseId: string,
  filters: BackupOperationFilter = {},
  page = 1,
  limit = 20,
  sortBy: keyof BackupOperationInfo = "startedAt",
  sortOrder: "asc" | "desc" = "desc",
): Promise<BackupOperationListResponse> {
  const url = new URL(
    ApiRoute.postgres.backupsForDatabase(databaseId),
    window.location.origin,
  );

  // Add query parameters
  url.searchParams.set("page", page.toString());
  url.searchParams.set("limit", limit.toString());
  url.searchParams.set("sortBy", sortBy);
  url.searchParams.set("sortOrder", sortOrder);
  if (filters.status) url.searchParams.set("status", filters.status);
  if (filters.operationType)
    url.searchParams.set("operationType", filters.operationType);
  if (filters.startedAfter)
    url.searchParams.set("startedAfter", filters.startedAfter);
  if (filters.startedBefore)
    url.searchParams.set("startedBefore", filters.startedBefore);

  return apiFetch<BackupOperationListResponse>(url.toString(), {
    correlationIdPrefix: "postgres-backup-ops",
    unwrap: false,
  });
}

async function fetchPostgresBackupOperationStatus(
  backupId: string,
): Promise<BackupOperationStatusResponse> {
  return apiFetch<BackupOperationStatusResponse>(
    ApiRoute.postgres.backupStatus(backupId),
    { correlationIdPrefix: "postgres-backup-ops", unwrap: false },
  );
}

async function createManualBackup(
  databaseId: string,
): Promise<ManualBackupResponse> {
  return apiFetch<ManualBackupResponse>(ApiRoute.postgres.manualBackup(databaseId), {
    method: "POST",
    correlationIdPrefix: "postgres-backup-ops",
    unwrap: false,
  });
}

async function deleteBackupOperation(
  backupId: string,
): Promise<BackupOperationDeleteResponse> {
  return apiFetch<BackupOperationDeleteResponse>(ApiRoute.postgres.backup(backupId), {
    method: "DELETE",
    correlationIdPrefix: "postgres-backup-ops",
    unwrap: false,
  });
}

async function fetchBackupOperationProgress(
  backupId: string,
): Promise<{ success: boolean; data: BackupOperationProgress }> {
  return apiFetch<{ success: boolean; data: BackupOperationProgress }>(
    ApiRoute.postgres.backupProgress(backupId),
    { correlationIdPrefix: "postgres-backup-ops", unwrap: false },
  );
}

// ====================
// PostgreSQL Backup Operations Hooks
// ====================

export interface UsePostgresBackupOperationsOptions {
  enabled?: boolean;
  refetchInterval?: number;
  retry?: number | boolean | ((failureCount: number, error: Error) => boolean);
  filters?: BackupOperationFilter;
  page?: number;
  limit?: number;
  sortBy?: keyof BackupOperationInfo;
  sortOrder?: "asc" | "desc";
}

export function usePostgresBackupOperations(
  databaseId: string,
  options: UsePostgresBackupOperationsOptions = {},
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
    queryKey: queryKeys.postgresBackupOperations.list(
      databaseId,
      filters,
      page,
      limit,
      sortBy,
      sortOrder,
    ),
    queryFn: () =>
      fetchPostgresBackupOperations(
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

export interface UsePostgresBackupOperationStatusOptions {
  enabled?: boolean;
  refetchInterval?: number;
  retry?: number | boolean | ((failureCount: number, error: Error) => boolean);
}

export function usePostgresBackupOperationStatus(
  backupId: string,
  options: UsePostgresBackupOperationStatusOptions = {},
) {
  const {
    enabled = true,
    refetchInterval = 5000, // Check status every 5 seconds for active operations
    retry = 3,
  } = options;

  return useQuery({
    queryKey: queryKeys.postgresBackupOperations.status(backupId),
    queryFn: () => fetchPostgresBackupOperationStatus(backupId),
    enabled: enabled && !!backupId,
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

export interface UsePostgresBackupOperationProgressOptions {
  enabled?: boolean;
  refetchInterval?: number;
  retry?: number | boolean | ((failureCount: number, error: Error) => boolean);
}

export function usePostgresBackupOperationProgress(
  backupId: string,
  options: UsePostgresBackupOperationProgressOptions = {},
) {
  const {
    enabled = true,
    refetchInterval = 3000, // Check progress every 3 seconds for active operations
    retry = 3,
  } = options;

  return useQuery({
    queryKey: queryKeys.postgresBackupOperations.progress(backupId),
    queryFn: () => fetchBackupOperationProgress(backupId),
    enabled: enabled && !!backupId,
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

// Mutation hooks for backup operations
export function useCreateManualBackup() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (databaseId: string) => createManualBackup(databaseId),
    onSuccess: (_, databaseId) => {
      // Invalidate and refetch backup operations list
      queryClient.invalidateQueries({
        queryKey: queryKeys.postgresBackupOperations.forDatabase(databaseId),
      });
      // Also update backup configuration as it might show last backup time
      queryClient.invalidateQueries({
        queryKey: queryKeys.postgresBackupConfig.forDatabase(databaseId),
      });
    },
  });
}

export function useDeleteBackupOperation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ backupId }: { backupId: string; databaseId: string }) =>
      deleteBackupOperation(backupId),
    onSuccess: (_, { databaseId, backupId }) => {
      // Invalidate and refetch backup operations list
      queryClient.invalidateQueries({
        queryKey: queryKeys.postgresBackupOperations.forDatabase(databaseId),
      });
      // Remove specific operation status from cache
      queryClient.removeQueries({
        queryKey: queryKeys.postgresBackupOperations.status(backupId),
      });
      queryClient.removeQueries({
        queryKey: queryKeys.postgresBackupOperations.progress(backupId),
      });
    },
  });
}

// ====================
// Backup Operations Filter Hook
// ====================

export interface PostgresBackupOperationFiltersState {
  status?: BackupOperationStatus;
  operationType?: BackupOperationType;
  startedAfter?: Date;
  startedBefore?: Date;
  sortBy: keyof BackupOperationInfo;
  sortOrder: "asc" | "desc";
  page: number;
  limit: number;
}

export function usePostgresBackupOperationFilters(
  initialFilters: Partial<PostgresBackupOperationFiltersState> = {},
) {
  const [filters, setFilters] = useState<PostgresBackupOperationFiltersState>({
    sortBy: "startedAt",
    sortOrder: "desc",
    page: 1,
    limit: 20,
    ...initialFilters,
  });

  const updateFilter = useCallback(
    <K extends keyof PostgresBackupOperationFiltersState>(
      key: K,
      value: PostgresBackupOperationFiltersState[K],
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
// Type Exports
// ====================

export type {
  BackupOperationInfo,
  BackupOperationListResponse,
  BackupOperationResponse,
  BackupOperationStatusResponse,
  BackupOperationDeleteResponse,
  ManualBackupResponse,
  CreateManualBackupRequest,
  BackupOperationFilter,
  BackupOperationSortOptions,
  BackupOperationType,
  BackupOperationStatus,
  BackupOperationProgress,
};
