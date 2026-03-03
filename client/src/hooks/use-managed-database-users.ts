import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ManagedDatabaseUserListResponse,
  ManagedDatabaseUserResponse,
  ManagedDatabaseUserDeleteResponse,
  CreateManagedDatabaseUserRequest,
  UpdateManagedDatabaseUserRequest,
  ChangeUserPasswordRequest,
  SyncUsersResponse,
} from "@mini-infra/types";

// Generate correlation ID for debugging
function generateCorrelationId(): string {
  return `managed-database-user-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// ====================
// Managed Database User API Functions
// ====================

async function fetchManagedDatabaseUsers(
  serverId: string,
  correlationId: string,
): Promise<ManagedDatabaseUserListResponse> {
  const response = await fetch(
    `/api/postgres-server/servers/${serverId}/users`,
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
      `Failed to fetch managed database users: ${response.statusText}`,
    );
  }

  const data: ManagedDatabaseUserListResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to fetch managed database users");
  }

  return data;
}

async function fetchManagedDatabaseUser(
  serverId: string,
  userId: string,
  correlationId: string,
): Promise<ManagedDatabaseUserResponse> {
  const response = await fetch(
    `/api/postgres-server/servers/${serverId}/users/${userId}`,
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
      `Failed to fetch managed database user: ${response.statusText}`,
    );
  }

  const data: ManagedDatabaseUserResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to fetch managed database user");
  }

  return data;
}

async function createManagedDatabaseUser(
  serverId: string,
  user: CreateManagedDatabaseUserRequest,
  correlationId: string,
): Promise<ManagedDatabaseUserResponse> {
  const response = await fetch(
    `/api/postgres-server/servers/${serverId}/users`,
    {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "X-Correlation-ID": correlationId,
      },
      body: JSON.stringify(user),
    },
  );

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(errorData.message || "Failed to create user");
  }

  const data: ManagedDatabaseUserResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to create user");
  }

  return data;
}

async function updateManagedDatabaseUser(
  serverId: string,
  userId: string,
  updates: UpdateManagedDatabaseUserRequest,
  correlationId: string,
): Promise<ManagedDatabaseUserResponse> {
  const response = await fetch(
    `/api/postgres-server/servers/${serverId}/users/${userId}`,
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
    throw new Error(errorData.message || "Failed to update user");
  }

  const data: ManagedDatabaseUserResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to update user");
  }

  return data;
}

async function changeUserPassword(
  serverId: string,
  userId: string,
  request: ChangeUserPasswordRequest,
  correlationId: string,
): Promise<ManagedDatabaseUserResponse> {
  const response = await fetch(
    `/api/postgres-server/servers/${serverId}/users/${userId}/password`,
    {
      method: "PUT",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "X-Correlation-ID": correlationId,
      },
      body: JSON.stringify(request),
    },
  );

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(errorData.message || "Failed to change password");
  }

  const data: ManagedDatabaseUserResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to change password");
  }

  return data;
}

async function deleteManagedDatabaseUser(
  serverId: string,
  userId: string,
  correlationId: string,
): Promise<ManagedDatabaseUserDeleteResponse> {
  const response = await fetch(
    `/api/postgres-server/servers/${serverId}/users/${userId}`,
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
    throw new Error(errorData.message || "Failed to delete user");
  }

  const data: ManagedDatabaseUserDeleteResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to delete user");
  }

  return data;
}

async function syncUsers(
  serverId: string,
  correlationId: string,
): Promise<SyncUsersResponse> {
  const response = await fetch(
    `/api/postgres-server/servers/${serverId}/users/sync`,
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
    throw new Error(errorData.message || "Failed to sync users");
  }

  const data: SyncUsersResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to sync users");
  }

  return data;
}

// ====================
// React Query Hooks
// ====================

/**
 * Hook to fetch all managed database users for a server
 */
export function useManagedDatabaseUsers(serverId: string | undefined) {
  return useQuery({
    queryKey: ["postgres-servers", serverId, "users"],
    queryFn: () =>
      fetchManagedDatabaseUsers(serverId!, generateCorrelationId()),
    enabled: !!serverId,
    staleTime: 30000, // Consider data fresh for 30 seconds
  });
}

/**
 * Hook to fetch a single managed database user
 */
export function useManagedDatabaseUser(
  serverId: string | undefined,
  userId: string | undefined,
) {
  return useQuery({
    queryKey: ["postgres-users", userId],
    queryFn: () =>
      fetchManagedDatabaseUser(serverId!, userId!, generateCorrelationId()),
    enabled: !!serverId && !!userId,
    staleTime: 30000,
  });
}

/**
 * Hook to create a new managed database user
 */
export function useCreateManagedDatabaseUser(serverId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (user: CreateManagedDatabaseUserRequest) =>
      createManagedDatabaseUser(serverId, user, generateCorrelationId()),
    onSuccess: () => {
      // Invalidate users list to refetch
      queryClient.invalidateQueries({
        queryKey: ["postgres-servers", serverId, "users"],
      });
      // Also invalidate the server to update counts
      queryClient.invalidateQueries({
        queryKey: ["postgres-servers", serverId],
      });
    },
  });
}

/**
 * Hook to update a managed database user
 */
export function useUpdateManagedDatabaseUser(serverId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      userId,
      updates,
    }: {
      userId: string;
      updates: UpdateManagedDatabaseUserRequest;
    }) =>
      updateManagedDatabaseUser(
        serverId,
        userId,
        updates,
        generateCorrelationId(),
      ),
    onSuccess: (data) => {
      // Invalidate both the list and the individual user
      queryClient.invalidateQueries({
        queryKey: ["postgres-servers", serverId, "users"],
      });
      queryClient.invalidateQueries({
        queryKey: ["postgres-users", data.data.id],
      });
    },
  });
}

/**
 * Hook to change a user's password
 */
export function useChangeUserPassword(serverId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      userId,
      password,
    }: {
      userId: string;
      password: string;
    }) =>
      changeUserPassword(
        serverId,
        userId,
        { password },
        generateCorrelationId(),
      ),
    onSuccess: (data) => {
      // Invalidate the individual user
      queryClient.invalidateQueries({
        queryKey: ["postgres-users", data.data.id],
      });
    },
  });
}

/**
 * Hook to delete a managed database user
 */
export function useDeleteManagedDatabaseUser(serverId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (userId: string) =>
      deleteManagedDatabaseUser(serverId, userId, generateCorrelationId()),
    onSuccess: () => {
      // Invalidate users list to refetch
      queryClient.invalidateQueries({
        queryKey: ["postgres-servers", serverId, "users"],
      });
      // Also invalidate the server to update counts
      queryClient.invalidateQueries({
        queryKey: ["postgres-servers", serverId],
      });
    },
  });
}

/**
 * Hook to sync users from the server
 */
export function useSyncUsers(serverId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => syncUsers(serverId, generateCorrelationId()),
    onSuccess: () => {
      // Invalidate users list to refetch
      queryClient.invalidateQueries({
        queryKey: ["postgres-servers", serverId, "users"],
      });
      // Also invalidate the server to update counts
      queryClient.invalidateQueries({
        queryKey: ["postgres-servers", serverId],
      });
    },
  });
}
