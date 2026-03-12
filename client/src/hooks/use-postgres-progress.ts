import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, useCallback, useEffect } from "react";
import {
  BackupOperationProgress,
  RestoreOperationProgress,
  BackupOperationStatus,
  RestoreOperationStatus,
  OperationHistoryItem,
  Channel,
  ServerEvent,
} from "@mini-infra/types";
import { useSocket, useSocketChannel, useSocketEvent } from "./use-socket";

// Generate correlation ID for debugging
function generateCorrelationId(): string {
  return `postgres-progress-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// ====================
// Progress Tracking API Functions
// ====================

async function fetchActiveOperations(correlationId: string): Promise<{
  success: boolean;
  data: {
    backupOperations: BackupOperationProgress[];
    restoreOperations: RestoreOperationProgress[];
  };
}> {
  const response = await fetch("/api/postgres/progress/active", {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch active operations: ${response.statusText}`,
    );
  }

  const data = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to fetch active operations");
  }

  return data;
}

async function fetchBackupProgress(
  operationId: string,
  correlationId: string,
): Promise<{ success: boolean; data: BackupOperationProgress }> {
  const response = await fetch(`/api/postgres/progress/backup/${operationId}`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch backup progress: ${response.statusText}`);
  }

  const data = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to fetch backup progress");
  }

  return data;
}

async function fetchRestoreProgress(
  operationId: string,
  correlationId: string,
): Promise<{ success: boolean; data: RestoreOperationProgress }> {
  const response = await fetch(
    `/api/postgres/progress/restore/${operationId}`,
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

interface OperationHistoryFilter {
  userId?: string;
  databaseId?: string;
  operationType?: "backup" | "restore" | "all";
  status?: BackupOperationStatus | RestoreOperationStatus | "all";
  startedAfter?: string;
  startedBefore?: string;
  limit?: number;
  offset?: number;
}

async function fetchOperationHistory(
  filters: OperationHistoryFilter = {},
  correlationId: string,
): Promise<{
  success: boolean;
  data: OperationHistoryItem[];
  pagination: {
    offset: number;
    limit: number;
    totalCount: number;
    hasMore: boolean;
  };
}> {
  const url = new URL("/api/postgres/progress/history", window.location.origin);

  // Add query parameters
  if (filters.databaseId)
    url.searchParams.set("databaseId", filters.databaseId);
  if (filters.operationType)
    url.searchParams.set("operationType", filters.operationType);
  if (filters.status && filters.status !== "all")
    url.searchParams.set("status", filters.status);
  if (filters.startedAfter)
    url.searchParams.set("startedAfter", filters.startedAfter);
  if (filters.startedBefore)
    url.searchParams.set("startedBefore", filters.startedBefore);
  if (filters.limit) url.searchParams.set("limit", filters.limit.toString());
  if (filters.offset) url.searchParams.set("offset", filters.offset.toString());

  const response = await fetch(url.toString(), {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch operation history: ${response.statusText}`,
    );
  }

  const data = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to fetch operation history");
  }

  return data;
}

// ====================
// Progress Tracking Hooks
// ====================

export interface UseActiveOperationsOptions {
  enabled?: boolean;
  refetchInterval?: number;
  retry?: number | boolean | ((failureCount: number, error: Error) => boolean);
}

const POLL_INTERVAL_DISCONNECTED = 3000; // 3s fallback when socket not connected

/**
 * Hook to fetch all active (pending or running) backup and restore operations.
 * Uses Socket.IO push events for real-time updates; falls back to polling when disconnected.
 */
export function useActiveOperations(options: UseActiveOperationsOptions = {}) {
  const {
    enabled = true,
    retry = 3,
  } = options;

  const queryClient = useQueryClient();
  const { connected } = useSocket();
  const correlationId = generateCorrelationId();

  // Subscribe to the postgres channel for push updates
  useSocketChannel(Channel.POSTGRES, enabled);

  // When server pushes operation progress, invalidate active operations
  useSocketEvent(
    ServerEvent.POSTGRES_OPERATION,
    () => {
      queryClient.invalidateQueries({ queryKey: ["postgresActiveOperations"] });
    },
    enabled,
  );

  // When an operation completes, invalidate active operations and history
  useSocketEvent(
    ServerEvent.POSTGRES_OPERATION_COMPLETED,
    () => {
      queryClient.invalidateQueries({ queryKey: ["postgresActiveOperations"] });
      queryClient.invalidateQueries({ queryKey: ["postgresOperationHistory"] });
      queryClient.invalidateQueries({ queryKey: ["postgresBackupOperations"] });
      queryClient.invalidateQueries({ queryKey: ["postgresRestoreOperations"] });
    },
    enabled,
  );

  // No polling when socket is connected; fall back when disconnected
  const refetchInterval =
    options.refetchInterval ?? (connected ? false : POLL_INTERVAL_DISCONNECTED);

  return useQuery({
    queryKey: ["postgresActiveOperations"],
    queryFn: () => fetchActiveOperations(correlationId),
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
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 10000), // Exponential backoff with max 10s
    staleTime: 1000, // Data is fresh for 1 second (since we poll frequently)
    gcTime: 2 * 60 * 1000, // Keep in cache for 2 minutes
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

export interface UseBackupProgressOptions {
  enabled?: boolean;
  refetchInterval?: number;
  retry?: number | boolean | ((failureCount: number, error: Error) => boolean);
}

/**
 * Hook to fetch progress for a specific backup operation.
 * Uses Socket.IO push events; falls back to polling when disconnected.
 */
export function useBackupProgress(
  operationId: string,
  options: UseBackupProgressOptions = {},
) {
  const {
    enabled = true,
    retry = 3,
  } = options;

  const queryClient = useQueryClient();
  const { connected } = useSocket();
  const correlationId = generateCorrelationId();

  // Subscribe to the postgres channel
  useSocketChannel(Channel.POSTGRES, enabled && !!operationId);

  // When this specific operation updates, invalidate
  useSocketEvent(
    ServerEvent.POSTGRES_OPERATION,
    (data) => {
      if (data.operationId === operationId) {
        queryClient.invalidateQueries({ queryKey: ["postgresBackupProgress", operationId] });
      }
    },
    enabled && !!operationId,
  );

  useSocketEvent(
    ServerEvent.POSTGRES_OPERATION_COMPLETED,
    (data) => {
      if (data.operationId === operationId) {
        queryClient.invalidateQueries({ queryKey: ["postgresBackupProgress", operationId] });
      }
    },
    enabled && !!operationId,
  );

  const refetchInterval =
    options.refetchInterval ?? (connected ? false : POLL_INTERVAL_DISCONNECTED);

  return useQuery({
    queryKey: ["postgresBackupProgress", operationId],
    queryFn: () => fetchBackupProgress(operationId, correlationId),
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
            return typeof retry === "boolean" ? retry : failureCount < retry;
          },
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 10000),
    staleTime: 1000,
    gcTime: 2 * 60 * 1000,
  });
}

export interface UseRestoreProgressOptions {
  enabled?: boolean;
  refetchInterval?: number;
  retry?: number | boolean | ((failureCount: number, error: Error) => boolean);
}

/**
 * Hook to fetch progress for a specific restore operation.
 * Uses Socket.IO push events; falls back to polling when disconnected.
 */
export function useRestoreProgress(
  operationId: string,
  options: UseRestoreProgressOptions = {},
) {
  const {
    enabled = true,
    retry = 3,
  } = options;

  const queryClient = useQueryClient();
  const { connected } = useSocket();
  const correlationId = generateCorrelationId();

  // Subscribe to the postgres channel
  useSocketChannel(Channel.POSTGRES, enabled && !!operationId);

  // When this specific operation updates, invalidate
  useSocketEvent(
    ServerEvent.POSTGRES_OPERATION,
    (data) => {
      if (data.operationId === operationId) {
        queryClient.invalidateQueries({ queryKey: ["postgresRestoreProgress", operationId] });
      }
    },
    enabled && !!operationId,
  );

  useSocketEvent(
    ServerEvent.POSTGRES_OPERATION_COMPLETED,
    (data) => {
      if (data.operationId === operationId) {
        queryClient.invalidateQueries({ queryKey: ["postgresRestoreProgress", operationId] });
      }
    },
    enabled && !!operationId,
  );

  const refetchInterval =
    options.refetchInterval ?? (connected ? false : POLL_INTERVAL_DISCONNECTED);

  return useQuery({
    queryKey: ["postgresRestoreProgress", operationId],
    queryFn: () => fetchRestoreProgress(operationId, correlationId),
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
            return typeof retry === "boolean" ? retry : failureCount < retry;
          },
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 10000),
    staleTime: 1000,
    gcTime: 2 * 60 * 1000,
  });
}

export interface UseOperationHistoryOptions {
  enabled?: boolean;
  filters?: OperationHistoryFilter;
  refetchInterval?: number;
  retry?: number | boolean | ((failureCount: number, error: Error) => boolean);
}

/**
 * Hook to fetch operation history with filtering and pagination.
 * Invalidated via Socket.IO when operations complete.
 */
export function useOperationHistory(options: UseOperationHistoryOptions = {}) {
  const {
    enabled = true,
    filters = {},
    retry = 3,
  } = options;

  const { connected } = useSocket();
  const correlationId = generateCorrelationId();

  // History is already invalidated by useActiveOperations' POSTGRES_OPERATION_COMPLETED handler.
  // Just disable polling when socket is connected.
  const refetchInterval =
    options.refetchInterval ?? (connected ? false : 30000);

  return useQuery({
    queryKey: ["postgresOperationHistory", filters],
    queryFn: () => fetchOperationHistory(filters, correlationId),
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
    refetchOnWindowFocus: false, // Don't refetch on focus for history data
    refetchOnReconnect: true,
  });
}

// ====================
// Progress Tracking Utilities
// ====================

/**
 * Utility hook to manage operation history filters
 */
export function useOperationHistoryFilters() {
  const [filters, setFilters] = useState<OperationHistoryFilter>({
    operationType: "all",
    status: "all",
    limit: 20,
    offset: 0,
  });

  const updateFilter = useCallback(
    (key: keyof OperationHistoryFilter, value: unknown) => {
      setFilters((prev) => ({
        ...prev,
        [key]: value,
        offset: key !== "offset" ? 0 : (value as number), // Reset pagination when changing filters
      }));
    },
    [],
  );

  const resetFilters = useCallback(() => {
    setFilters({
      operationType: "all",
      status: "all",
      limit: 20,
      offset: 0,
    });
  }, []);

  return {
    filters,
    updateFilter,
    resetFilters,
  };
}

/**
 * Hook to track if there are any active operations and provide real-time updates
 */
export function useActiveOperationsStatus() {
  const { data: activeOpsResponse, isLoading, error } = useActiveOperations();
  const queryClient = useQueryClient();

  const activeOps = activeOpsResponse?.data;

  const hasActiveBackups = (activeOps?.backupOperations?.length || 0) > 0;
  const hasActiveRestores = (activeOps?.restoreOperations?.length || 0) > 0;
  const hasAnyActive = hasActiveBackups || hasActiveRestores;

  const activeBackupCount = activeOps?.backupOperations?.length || 0;
  const activeRestoreCount = activeOps?.restoreOperations?.length || 0;
  const totalActiveCount = activeBackupCount + activeRestoreCount;

  // Invalidate related queries when operations complete
  useEffect(() => {
    if (activeOps) {
      const completedOperations = [
        ...(activeOps.backupOperations || []).filter(
          (op) => op.status === "completed" || op.status === "failed",
        ),
        ...(activeOps.restoreOperations || []).filter(
          (op) => op.status === "completed" || op.status === "failed",
        ),
      ];

      if (completedOperations.length > 0) {
        // Invalidate operation history to show updated results
        queryClient.invalidateQueries({
          queryKey: ["postgresOperationHistory"],
        });

        // Invalidate backup operations for affected databases
        completedOperations.forEach((op) => {
          queryClient.invalidateQueries({
            queryKey: ["postgresBackupOperations", op.databaseId],
          });
          queryClient.invalidateQueries({
            queryKey: ["postgresRestoreOperations", op.databaseId],
          });
        });
      }
    }
  }, [activeOps, queryClient]);

  return {
    isLoading,
    error,
    hasActiveBackups,
    hasActiveRestores,
    hasAnyActive,
    activeBackupCount,
    activeRestoreCount,
    totalActiveCount,
    backupOperations: activeOps?.backupOperations || [],
    restoreOperations: activeOps?.restoreOperations || [],
  };
}
