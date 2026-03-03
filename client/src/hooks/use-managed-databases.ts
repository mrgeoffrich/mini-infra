import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ManagedDatabaseListResponse,
  ManagedDatabaseResponse,
  ManagedDatabaseDeleteResponse,
  CreateManagedDatabaseRequest,
  UpdateManagedDatabaseRequest,
  ChangeDatabaseOwnerRequest,
  SyncDatabasesResponse,
} from "@mini-infra/types";

// Generate correlation ID for debugging
function generateCorrelationId(): string {
  return `managed-database-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// ====================
// Managed Database API Functions
// ====================

async function fetchManagedDatabases(
  serverId: string,
  correlationId: string,
): Promise<ManagedDatabaseListResponse> {
  const response = await fetch(
    `/api/postgres-server/servers/${serverId}/databases`,
    {
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "X-Correlation-ID": correlationId,
      },
    },
  );

  if (!response.ok) {
    throw new Error(
      `Failed to fetch managed databases: ${response.statusText}`,
    );
  }

  const data: ManagedDatabaseListResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to fetch managed databases");
  }

  return data;
}

async function fetchManagedDatabase(
  serverId: string,
  databaseId: string,
  correlationId: string,
): Promise<ManagedDatabaseResponse> {
  const response = await fetch(
    `/api/postgres-server/servers/${serverId}/databases/${databaseId}`,
    {
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "X-Correlation-ID": correlationId,
      },
    },
  );

  if (!response.ok) {
    throw new Error(
      `Failed to fetch managed database: ${response.statusText}`,
    );
  }

  const data: ManagedDatabaseResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to fetch managed database");
  }

  return data;
}

async function createManagedDatabase(
  serverId: string,
  database: CreateManagedDatabaseRequest,
  correlationId: string,
): Promise<ManagedDatabaseResponse> {
  const response = await fetch(
    `/api/postgres-server/servers/${serverId}/databases`,
    {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "X-Correlation-ID": correlationId,
      },
      body: JSON.stringify(database),
    },
  );

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(errorData.message || "Failed to create database");
  }

  const data: ManagedDatabaseResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to create database");
  }

  return data;
}

async function updateManagedDatabase(
  serverId: string,
  databaseId: string,
  updates: UpdateManagedDatabaseRequest,
  correlationId: string,
): Promise<ManagedDatabaseResponse> {
  const response = await fetch(
    `/api/postgres-server/servers/${serverId}/databases/${databaseId}`,
    {
      method: "PUT",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "X-Correlation-ID": correlationId,
      },
      body: JSON.stringify(updates),
    },
  );

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(errorData.message || "Failed to update database");
  }

  const data: ManagedDatabaseResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to update database");
  }

  return data;
}

async function deleteManagedDatabase(
  serverId: string,
  databaseId: string,
  correlationId: string,
): Promise<ManagedDatabaseDeleteResponse> {
  const response = await fetch(
    `/api/postgres-server/servers/${serverId}/databases/${databaseId}`,
    {
      method: "DELETE",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "X-Correlation-ID": correlationId,
      },
    },
  );

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(errorData.message || "Failed to delete database");
  }

  const data: ManagedDatabaseDeleteResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to delete database");
  }

  return data;
}

async function changeDatabaseOwner(
  serverId: string,
  databaseId: string,
  ownerData: ChangeDatabaseOwnerRequest,
  correlationId: string,
): Promise<ManagedDatabaseResponse> {
  const response = await fetch(
    `/api/postgres-server/servers/${serverId}/databases/${databaseId}/owner`,
    {
      method: "PUT",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "X-Correlation-ID": correlationId,
      },
      body: JSON.stringify(ownerData),
    },
  );

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(errorData.message || "Failed to change database owner");
  }

  const data: ManagedDatabaseResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to change database owner");
  }

  return data;
}

async function syncDatabases(
  serverId: string,
  correlationId: string,
): Promise<SyncDatabasesResponse> {
  const response = await fetch(
    `/api/postgres-server/servers/${serverId}/databases/sync`,
    {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "X-Correlation-ID": correlationId,
      },
    },
  );

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(errorData.message || "Failed to sync databases");
  }

  const data: SyncDatabasesResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to sync databases");
  }

  return data;
}

// ====================
// React Query Hooks
// ====================

/**
 * Hook to fetch all managed databases for a server
 */
export function useManagedDatabases(serverId: string | undefined) {
  return useQuery({
    queryKey: ["postgres-servers", serverId, "databases"],
    queryFn: () => fetchManagedDatabases(serverId!, generateCorrelationId()),
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
    queryKey: ["postgres-databases", databaseId],
    queryFn: () =>
      fetchManagedDatabase(serverId!, databaseId!, generateCorrelationId()),
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
      createManagedDatabase(serverId, database, generateCorrelationId()),
    onSuccess: () => {
      // Invalidate databases list to refetch
      queryClient.invalidateQueries({
        queryKey: ["postgres-servers", serverId, "databases"],
      });
      // Also invalidate the server to update counts
      queryClient.invalidateQueries({
        queryKey: ["postgres-servers", serverId],
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
        generateCorrelationId(),
      ),
    onSuccess: (data) => {
      // Invalidate both the list and the individual database
      queryClient.invalidateQueries({
        queryKey: ["postgres-servers", serverId, "databases"],
      });
      queryClient.invalidateQueries({
        queryKey: ["postgres-databases", data.data.id],
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
      deleteManagedDatabase(serverId, databaseId, generateCorrelationId()),
    onSuccess: () => {
      // Invalidate databases list to refetch
      queryClient.invalidateQueries({
        queryKey: ["postgres-servers", serverId, "databases"],
      });
      // Also invalidate the server to update counts
      queryClient.invalidateQueries({
        queryKey: ["postgres-servers", serverId],
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
        generateCorrelationId(),
      ),
    onSuccess: (data) => {
      // Invalidate both the list and the individual database
      queryClient.invalidateQueries({
        queryKey: ["postgres-servers", serverId, "databases"],
      });
      queryClient.invalidateQueries({
        queryKey: ["postgres-databases", data.data.id],
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
    mutationFn: () => syncDatabases(serverId, generateCorrelationId()),
    onSuccess: () => {
      // Invalidate databases list to refetch
      queryClient.invalidateQueries({
        queryKey: ["postgres-servers", serverId, "databases"],
      });
      // Also invalidate the server to update counts
      queryClient.invalidateQueries({
        queryKey: ["postgres-servers", serverId],
      });
    },
  });
}
