import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ManagedDatabaseListResponse,
  ManagedDatabaseResponse,
  ManagedDatabaseDeleteResponse,
  CreateManagedDatabaseRequest,
  UpdateManagedDatabaseRequest,
  ChangeDatabaseOwnerRequest,
  SyncDatabasesResponse,
  ApiRoute,
  queryKeys,
} from "@mini-infra/types";
import { apiFetch } from "@/lib/api-client";

// ====================
// Managed Database API Functions
// ====================

async function fetchManagedDatabases(
  serverId: string,
): Promise<ManagedDatabaseListResponse> {
  return apiFetch<ManagedDatabaseListResponse>(
    ApiRoute.postgresServer.databases(serverId),
    { correlationIdPrefix: "managed-database", unwrap: false },
  );
}

async function fetchManagedDatabase(
  serverId: string,
  databaseId: string,
): Promise<ManagedDatabaseResponse> {
  return apiFetch<ManagedDatabaseResponse>(
    ApiRoute.postgresServer.database(serverId, databaseId),
    { correlationIdPrefix: "managed-database", unwrap: false },
  );
}

async function createManagedDatabase(
  serverId: string,
  database: CreateManagedDatabaseRequest,
): Promise<ManagedDatabaseResponse> {
  return apiFetch<ManagedDatabaseResponse>(
    ApiRoute.postgresServer.databases(serverId),
    {
      method: "POST",
      body: database,
      correlationIdPrefix: "managed-database",
      unwrap: false,
    },
  );
}

async function updateManagedDatabase(
  serverId: string,
  databaseId: string,
  updates: UpdateManagedDatabaseRequest,
): Promise<ManagedDatabaseResponse> {
  return apiFetch<ManagedDatabaseResponse>(
    ApiRoute.postgresServer.database(serverId, databaseId),
    {
      method: "PUT",
      body: updates,
      correlationIdPrefix: "managed-database",
      unwrap: false,
    },
  );
}

async function deleteManagedDatabase(
  serverId: string,
  databaseId: string,
): Promise<ManagedDatabaseDeleteResponse> {
  return apiFetch<ManagedDatabaseDeleteResponse>(
    ApiRoute.postgresServer.database(serverId, databaseId),
    { method: "DELETE", correlationIdPrefix: "managed-database", unwrap: false },
  );
}

async function changeDatabaseOwner(
  serverId: string,
  databaseId: string,
  ownerData: ChangeDatabaseOwnerRequest,
): Promise<ManagedDatabaseResponse> {
  return apiFetch<ManagedDatabaseResponse>(
    ApiRoute.postgresServer.databaseOwner(serverId, databaseId),
    {
      method: "PUT",
      body: ownerData,
      correlationIdPrefix: "managed-database",
      unwrap: false,
    },
  );
}

async function syncDatabases(serverId: string): Promise<SyncDatabasesResponse> {
  return apiFetch<SyncDatabasesResponse>(
    ApiRoute.postgresServer.databasesSync(serverId),
    { method: "POST", correlationIdPrefix: "managed-database", unwrap: false },
  );
}

// ====================
// React Query Hooks
// ====================

/**
 * Hook to fetch all managed databases for a server
 */
export function useManagedDatabases(serverId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.postgresServer.databasesForServer(serverId ?? ""),
    queryFn: () => fetchManagedDatabases(serverId!),
    enabled: !!serverId,
    staleTime: 30000, // Consider data fresh for 30 seconds
  });
}

/**
 * Hook to fetch a single managed database
 */
export function useManagedDatabase(
  serverId: string | undefined,
  databaseId: string | undefined,
) {
  return useQuery({
    queryKey: queryKeys.postgresServer.database(databaseId ?? ""),
    queryFn: () =>
      fetchManagedDatabase(serverId!, databaseId!),
    enabled: !!serverId && !!databaseId,
    staleTime: 30000,
  });
}

/**
 * Hook to create a new managed database
 */
export function useCreateManagedDatabase(serverId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (database: CreateManagedDatabaseRequest) =>
      createManagedDatabase(serverId, database),
    onSuccess: () => {
      // Invalidate databases list to refetch
      queryClient.invalidateQueries({
        queryKey: queryKeys.postgresServer.databasesForServer(serverId),
      });
      // Also invalidate the server to update counts
      queryClient.invalidateQueries({
        queryKey: queryKeys.postgresServer.detail(serverId),
      });
    },
  });
}

/**
 * Hook to update a managed database
 */
export function useUpdateManagedDatabase(serverId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      databaseId,
      updates,
    }: {
      databaseId: string;
      updates: UpdateManagedDatabaseRequest;
    }) =>
      updateManagedDatabase(
        serverId,
        databaseId,
        updates,
      ),
    onSuccess: (data) => {
      // Invalidate both the list and the individual database
      queryClient.invalidateQueries({
        queryKey: queryKeys.postgresServer.databasesForServer(serverId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.postgresServer.database(data.data.id),
      });
    },
  });
}

/**
 * Hook to delete a managed database
 */
export function useDeleteManagedDatabase(serverId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (databaseId: string) =>
      deleteManagedDatabase(serverId, databaseId),
    onSuccess: () => {
      // Invalidate databases list to refetch
      queryClient.invalidateQueries({
        queryKey: queryKeys.postgresServer.databasesForServer(serverId),
      });
      // Also invalidate the server to update counts
      queryClient.invalidateQueries({
        queryKey: queryKeys.postgresServer.detail(serverId),
      });
    },
  });
}

/**
 * Hook to change database owner
 */
export function useChangeDatabaseOwner(serverId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      databaseId,
      ownerData,
    }: {
      databaseId: string;
      ownerData: ChangeDatabaseOwnerRequest;
    }) =>
      changeDatabaseOwner(
        serverId,
        databaseId,
        ownerData,
      ),
    onSuccess: (data) => {
      // Invalidate both the list and the individual database
      queryClient.invalidateQueries({
        queryKey: queryKeys.postgresServer.databasesForServer(serverId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.postgresServer.database(data.data.id),
      });
    },
  });
}

/**
 * Hook to sync databases from the server
 */
export function useSyncDatabases(serverId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => syncDatabases(serverId),
    onSuccess: () => {
      // Invalidate databases list to refetch
      queryClient.invalidateQueries({
        queryKey: queryKeys.postgresServer.databasesForServer(serverId),
      });
      // Also invalidate the server to update counts
      queryClient.invalidateQueries({
        queryKey: queryKeys.postgresServer.detail(serverId),
      });
    },
  });
}
