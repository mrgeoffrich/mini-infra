import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  BackupConfigurationInfo,
  BackupConfigurationResponse,
  BackupConfigurationDeleteResponse,
  CreateBackupConfigurationRequest,
  UpdateBackupConfigurationRequest,
  QuickBackupSetupRequest,
  ApiRoute,
  queryKeys,
} from "@mini-infra/types";
import { apiFetch, ApiRequestError } from "@/lib/api-client";

// ====================
// PostgreSQL Backup Configuration API Functions
// ====================

/** Extracts a Zod-validation-details message from an ApiRequestError body, if present. */
function validationErrorMessage(error: ApiRequestError): string | undefined {
  const body = error.body as
    | { details?: Array<{ path?: (string | number)[]; message: string }> }
    | undefined;
  if (body?.details && Array.isArray(body.details)) {
    const validationErrors = body.details
      .map((detail) => `${detail.path?.join(".")}: ${detail.message}`)
      .join(", ");
    return `Validation failed: ${validationErrors}`;
  }
  return undefined;
}

async function fetchPostgresBackupConfig(
  databaseId: string,
): Promise<BackupConfigurationResponse> {
  try {
    return await apiFetch<BackupConfigurationResponse>(
      ApiRoute.postgres.backupConfigForDatabase(databaseId),
      { correlationIdPrefix: "postgres-backup-config", unwrap: false },
    );
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 404) {
      // No backup config found - return a null data response
      return {
        success: true,
        data: null as unknown as BackupConfigurationInfo,
        message: "No backup configuration found",
        timestamp: new Date().toISOString(),
      };
    }
    throw error;
  }
}

async function createPostgresBackupConfig(
  request: CreateBackupConfigurationRequest,
): Promise<BackupConfigurationResponse> {
  try {
    return await apiFetch<BackupConfigurationResponse>(
      ApiRoute.postgres.backupConfigs(),
      {
        method: "POST",
        body: request,
        correlationIdPrefix: "postgres-backup-config",
        unwrap: false,
      },
    );
  } catch (error) {
    if (error instanceof ApiRequestError) {
      throw new Error(validationErrorMessage(error) ?? error.message, { cause: error });
    }
    throw error;
  }
}

async function updatePostgresBackupConfig(
  id: string,
  request: UpdateBackupConfigurationRequest,
): Promise<BackupConfigurationResponse> {
  try {
    return await apiFetch<BackupConfigurationResponse>(
      ApiRoute.postgres.backupConfig(id),
      {
        method: "PUT",
        body: request,
        correlationIdPrefix: "postgres-backup-config",
        unwrap: false,
      },
    );
  } catch (error) {
    if (error instanceof ApiRequestError) {
      throw new Error(validationErrorMessage(error) ?? error.message, { cause: error });
    }
    throw error;
  }
}

async function deletePostgresBackupConfig(
  id: string,
): Promise<BackupConfigurationDeleteResponse> {
  return apiFetch<BackupConfigurationDeleteResponse>(
    ApiRoute.postgres.backupConfig(id),
    { method: "DELETE", correlationIdPrefix: "postgres-backup-config", unwrap: false },
  );
}

async function quickSetupPostgresBackup(
  request: QuickBackupSetupRequest,
): Promise<BackupConfigurationResponse> {
  // Unlike createPostgresBackupConfig/updatePostgresBackupConfig above, this
  // does NOT catch-and-flatten ApiRequestError into a generic Error — the
  // real error (with its `code`/`resource`/`action`) needs to reach the
  // global MutationCache.onError (client/src/lib/query-client.ts), which
  // renders it via getUserFacingError/toastApiError (client/src/lib/errors.ts).
  // That helper already reads Zod `details` for VALIDATION_FAILED, so the
  // validationErrorMessage behavior isn't lost — it just lives in one place
  // now instead of being duplicated per-hook.
  return apiFetch<BackupConfigurationResponse>(
    ApiRoute.postgres.backupConfigsQuickSetup(),
    {
      method: "POST",
      body: request,
      correlationIdPrefix: "postgres-backup-config",
      unwrap: false,
    },
  );
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

  return useQuery({
    queryKey: queryKeys.postgresBackupConfig.forDatabase(databaseId),
    queryFn: () => fetchPostgresBackupConfig(databaseId),
    enabled: enabled && !!databaseId,
    refetchInterval,
    retry:
      typeof retry === "function"
        ? retry
        : (failureCount: number, error: Error) => {
            if (error instanceof ApiRequestError) {
              // Don't retry on authentication errors
              if (error.isAuth) {
                return false;
              }
              // Don't retry on not found errors (404 is handled in the fetch function)
              if (error.status === 404) {
                return false;
              }
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

  return useMutation({
    mutationFn: (request: CreateBackupConfigurationRequest) =>
      createPostgresBackupConfig(request),
    onSuccess: (_, { databaseId }) => {
      // Invalidate and refetch backup configuration for this database
      queryClient.invalidateQueries({
        queryKey: queryKeys.postgresBackupConfig.forDatabase(databaseId),
      });
      // Also invalidate databases list as it might show backup configuration status
      queryClient.invalidateQueries({ queryKey: queryKeys.postgresDatabases.all });
    },
  });
}

export function useUpdatePostgresBackupConfig() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      id,
      request,
    }: {
      id: string;
      request: UpdateBackupConfigurationRequest;
    }) => updatePostgresBackupConfig(id, request),
    onSuccess: (response) => {
      const databaseId = response.data.databaseId;
      // Invalidate and refetch backup configuration for this database
      queryClient.invalidateQueries({
        queryKey: queryKeys.postgresBackupConfig.forDatabase(databaseId),
      });
      // Also invalidate databases list as it might show backup configuration status
      queryClient.invalidateQueries({ queryKey: queryKeys.postgresDatabases.all });
    },
  });
}

export function useDeletePostgresBackupConfig() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id }: { id: string; databaseId: string }) =>
      deletePostgresBackupConfig(id),
    onSuccess: (_, { databaseId }) => {
      // Invalidate and refetch backup configuration for this database
      queryClient.invalidateQueries({
        queryKey: queryKeys.postgresBackupConfig.forDatabase(databaseId),
      });
      // Also invalidate databases list as it might show backup configuration status
      queryClient.invalidateQueries({ queryKey: queryKeys.postgresDatabases.all });
      // Remove any scheduled backup operations that might be cached
      queryClient.invalidateQueries({
        queryKey: queryKeys.postgresBackupOperations.forDatabase(databaseId),
      });
    },
  });
}

export function useQuickSetupPostgresBackup() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (request: QuickBackupSetupRequest) =>
      quickSetupPostgresBackup(request),
    onSuccess: (response, request) => {
      const databaseId = response.data.databaseId;
      // Invalidate and refetch backup configuration for this database
      queryClient.invalidateQueries({
        queryKey: queryKeys.postgresBackupConfig.forDatabase(databaseId),
      });
      // Also invalidate databases list as it might show backup configuration status
      queryClient.invalidateQueries({ queryKey: queryKeys.postgresDatabases.all });
      // Refetch the managed-databases list for this server and the single
      // managed-database detail so the newly-configured backup shows up (both
      // surfaces render backup-configuration status).
      queryClient.invalidateQueries({
        queryKey: queryKeys.postgresServer.databasesForServer(request.serverId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.postgresServer.database(databaseId),
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
  QuickBackupSetupRequest,
};
