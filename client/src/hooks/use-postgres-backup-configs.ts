import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  BackupConfigurationInfo,
  BackupConfigurationResponse,
  BackupConfigurationDeleteResponse,
  CreateBackupConfigurationRequest,
  UpdateBackupConfigurationRequest,
} from "@mini-infra/types";

// Generate correlation ID for debugging
function generateCorrelationId(): string {
  return `postgres-backup-config-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// ====================
// PostgreSQL Backup Configuration API Functions
// ====================

async function fetchPostgresBackupConfig(
  databaseId: string,
  correlationId: string,
): Promise<BackupConfigurationResponse> {
  const response = await fetch(`/api/postgres/backup-configs/${databaseId}`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    if (response.status === 404) {
      // No backup config found - return a null data response
      return {
        success: true,
        data: null as unknown as BackupConfigurationInfo,
        message: "No backup configuration found",
        timestamp: new Date().toISOString(),
      };
    }
    throw new Error(
      `Failed to fetch backup configuration: ${response.statusText}`,
    );
  }

  const data: BackupConfigurationResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to fetch backup configuration");
  }

  return data;
}

async function createPostgresBackupConfig(
  request: CreateBackupConfigurationRequest,
  correlationId: string,
): Promise<BackupConfigurationResponse> {
  const response = await fetch(`/api/postgres/backup-configs`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    let errorMessage = `Failed to create backup configuration: ${response.statusText}`;
    
    try {
      const errorData = await response.json();
      if (errorData.message) {
        errorMessage = errorData.message;
      } else if (errorData.details && Array.isArray(errorData.details)) {
        // Handle Zod validation errors
        const validationErrors = errorData.details.map((detail: any) => 
          `${detail.path?.join('.')}: ${detail.message}`
        ).join(', ');
        errorMessage = `Validation failed: ${validationErrors}`;
      }
    } catch {
      // If JSON parsing fails, keep the original error message
    }
    
    throw new Error(errorMessage);
  }

  const data: BackupConfigurationResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to create backup configuration");
  }

  return data;
}

async function updatePostgresBackupConfig(
  id: string,
  request: UpdateBackupConfigurationRequest,
  correlationId: string,
): Promise<BackupConfigurationResponse> {
  const response = await fetch(`/api/postgres/backup-configs/${id}`, {
    method: "PUT",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    let errorMessage = `Failed to update backup configuration: ${response.statusText}`;
    
    try {
      const errorData = await response.json();
      if (errorData.message) {
        errorMessage = errorData.message;
      } else if (errorData.details && Array.isArray(errorData.details)) {
        // Handle Zod validation errors
        const validationErrors = errorData.details.map((detail: any) => 
          `${detail.path?.join('.')}: ${detail.message}`
        ).join(', ');
        errorMessage = `Validation failed: ${validationErrors}`;
      }
    } catch {
      // If JSON parsing fails, keep the original error message
    }
    
    throw new Error(errorMessage);
  }

  const data: BackupConfigurationResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to update backup configuration");
  }

  return data;
}

async function deletePostgresBackupConfig(
  id: string,
  correlationId: string,
): Promise<BackupConfigurationDeleteResponse> {
  const response = await fetch(`/api/postgres/backup-configs/${id}`, {
    method: "DELETE",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    let errorMessage = `Failed to delete backup configuration: ${response.statusText}`;
    
    try {
      const errorData = await response.json();
      if (errorData.message) {
        errorMessage = errorData.message;
      }
    } catch {
      // If JSON parsing fails, keep the original error message
    }
    
    throw new Error(errorMessage);
  }

  const data: BackupConfigurationDeleteResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to delete backup configuration");
  }

  return data;
}

// ====================
// PostgreSQL Backup Configuration Hooks
// ====================

export interface UsePostgresBackupConfigOptions {
  enabled?: boolean;
  refetchInterval?: number;
  retry?: number | boolean | ((failureCount: number, error: Error) => boolean);
}

export function usePostgresBackupConfig(
  databaseId: string,
  options: UsePostgresBackupConfigOptions = {},
) {
  const { enabled = true, refetchInterval, retry = 3 } = options;

  const correlationId = generateCorrelationId();

  return useQuery({
    queryKey: ["postgresBackupConfig", databaseId],
    queryFn: () => fetchPostgresBackupConfig(databaseId, correlationId),
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
            // Don't retry on not found errors (404 is handled in the fetch function)
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
    staleTime: 10000, // Data is fresh for 10 seconds
    gcTime: 5 * 60 * 1000, // Keep in cache for 5 minutes
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

// Mutation hooks for backup configuration operations
export function useCreatePostgresBackupConfig() {
  const queryClient = useQueryClient();
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: (request: CreateBackupConfigurationRequest) =>
      createPostgresBackupConfig(request, correlationId),
    onSuccess: (_, { databaseId }) => {
      // Invalidate and refetch backup configuration for this database
      queryClient.invalidateQueries({
        queryKey: ["postgresBackupConfig", databaseId],
      });
      // Also invalidate databases list as it might show backup configuration status
      queryClient.invalidateQueries({ queryKey: ["postgresDatabases"] });
    },
  });
}

export function useUpdatePostgresBackupConfig() {
  const queryClient = useQueryClient();
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: ({
      id,
      request,
    }: {
      id: string;
      request: UpdateBackupConfigurationRequest;
    }) => updatePostgresBackupConfig(id, request, correlationId),
    onSuccess: (response) => {
      const databaseId = response.data.databaseId;
      // Invalidate and refetch backup configuration for this database
      queryClient.invalidateQueries({
        queryKey: ["postgresBackupConfig", databaseId],
      });
      // Also invalidate databases list as it might show backup configuration status
      queryClient.invalidateQueries({ queryKey: ["postgresDatabases"] });
    },
  });
}

export function useDeletePostgresBackupConfig() {
  const queryClient = useQueryClient();
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: ({ id }: { id: string; databaseId: string }) =>
      deletePostgresBackupConfig(id, correlationId),
    onSuccess: (_, { databaseId }) => {
      // Invalidate and refetch backup configuration for this database
      queryClient.invalidateQueries({
        queryKey: ["postgresBackupConfig", databaseId],
      });
      // Also invalidate databases list as it might show backup configuration status
      queryClient.invalidateQueries({ queryKey: ["postgresDatabases"] });
      // Remove any scheduled backup operations that might be cached
      queryClient.invalidateQueries({
        queryKey: ["postgresBackupOperations", databaseId],
      });
    },
  });
}

// ====================
// Type Exports
// ====================

export type {
  BackupConfigurationInfo,
  BackupConfigurationResponse,
  BackupConfigurationDeleteResponse,
  CreateBackupConfigurationRequest,
  UpdateBackupConfigurationRequest,
};
