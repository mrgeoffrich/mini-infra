import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ManagedDatabaseUserListResponse,
  ManagedDatabaseUserResponse,
  ManagedDatabaseUserDeleteResponse,
  CreateManagedDatabaseUserRequest,
  UpdateManagedDatabaseUserRequest,
  ChangeUserPasswordRequest,
  SyncUsersResponse,
  ApiRoute,
  queryKeys,
} from "@mini-infra/types";
import { apiFetch } from "@/lib/api-client";

// ====================
// Managed Database User API Functions
// ====================

async function fetchManagedDatabaseUsers(
  serverId: string,
): Promise<ManagedDatabaseUserListResponse> {
  return apiFetch<ManagedDatabaseUserListResponse>(
    ApiRoute.postgresServer.users(serverId),
    { correlationIdPrefix: "managed-database-user", unwrap: false },
  );
}

async function fetchManagedDatabaseUser(
  serverId: string,
  userId: string,
): Promise<ManagedDatabaseUserResponse> {
  return apiFetch<ManagedDatabaseUserResponse>(
    ApiRoute.postgresServer.user(serverId, userId),
    { correlationIdPrefix: "managed-database-user", unwrap: false },
  );
}

async function createManagedDatabaseUser(
  serverId: string,
  user: CreateManagedDatabaseUserRequest,
): Promise<ManagedDatabaseUserResponse> {
  return apiFetch<ManagedDatabaseUserResponse>(
    ApiRoute.postgresServer.users(serverId),
    {
      method: "POST",
      body: user,
      correlationIdPrefix: "managed-database-user",
      unwrap: false,
    },
  );
}

async function updateManagedDatabaseUser(
  serverId: string,
  userId: string,
  updates: UpdateManagedDatabaseUserRequest,
): Promise<ManagedDatabaseUserResponse> {
  return apiFetch<ManagedDatabaseUserResponse>(
    ApiRoute.postgresServer.user(serverId, userId),
    {
      method: "PUT",
      body: updates,
      correlationIdPrefix: "managed-database-user",
      unwrap: false,
    },
  );
}

async function changeUserPassword(
  serverId: string,
  userId: string,
  request: ChangeUserPasswordRequest,
): Promise<ManagedDatabaseUserResponse> {
  // The server route (server/src/routes/postgres-server/users.ts) is
  // registered as `router.post("/:userId/password", ...)` and the registry
  // documents `ApiRoute.postgresServer.userPassword` as POST — so this must
  // use POST, not PUT (a PUT hit no registered route and 404'd).
  return apiFetch<ManagedDatabaseUserResponse>(
    ApiRoute.postgresServer.userPassword(serverId, userId),
    {
      method: "POST",
      body: request,
      correlationIdPrefix: "managed-database-user",
      unwrap: false,
    },
  );
}

async function deleteManagedDatabaseUser(
  serverId: string,
  userId: string,
): Promise<ManagedDatabaseUserDeleteResponse> {
  return apiFetch<ManagedDatabaseUserDeleteResponse>(
    ApiRoute.postgresServer.user(serverId, userId),
    { method: "DELETE", correlationIdPrefix: "managed-database-user", unwrap: false },
  );
}

async function syncUsers(serverId: string): Promise<SyncUsersResponse> {
  return apiFetch<SyncUsersResponse>(ApiRoute.postgresServer.usersSync(serverId), {
    method: "POST",
    correlationIdPrefix: "managed-database-user",
    unwrap: false,
  });
}

// ====================
// React Query Hooks
// ====================

/**
 * Hook to fetch all managed database users for a server
 */
export function useManagedDatabaseUsers(serverId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.postgresServer.usersForServer(serverId ?? ""),
    queryFn: () => fetchManagedDatabaseUsers(serverId!),
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
    queryKey: queryKeys.postgresServer.user(userId ?? ""),
    queryFn: () => fetchManagedDatabaseUser(serverId!, userId!),
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
      createManagedDatabaseUser(serverId, user),
    onSuccess: () => {
      // Invalidate users list to refetch
      queryClient.invalidateQueries({
        queryKey: queryKeys.postgresServer.usersForServer(serverId),
      });
      // Also invalidate the server to update counts
      queryClient.invalidateQueries({
        queryKey: queryKeys.postgresServer.detail(serverId),
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
      ),
    onSuccess: (data) => {
      // Invalidate both the list and the individual user
      queryClient.invalidateQueries({
        queryKey: queryKeys.postgresServer.usersForServer(serverId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.postgresServer.user(data.data.id),
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
      ),
    onSuccess: (data) => {
      // Invalidate the individual user
      queryClient.invalidateQueries({
        queryKey: queryKeys.postgresServer.user(data.data.id),
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
      deleteManagedDatabaseUser(serverId, userId),
    onSuccess: () => {
      // Invalidate users list to refetch
      queryClient.invalidateQueries({
        queryKey: queryKeys.postgresServer.usersForServer(serverId),
      });
      // Also invalidate the server to update counts
      queryClient.invalidateQueries({
        queryKey: queryKeys.postgresServer.detail(serverId),
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
    mutationFn: () => syncUsers(serverId),
    onSuccess: () => {
      // Invalidate users list to refetch
      queryClient.invalidateQueries({
        queryKey: queryKeys.postgresServer.usersForServer(serverId),
      });
      // Also invalidate the server to update counts
      queryClient.invalidateQueries({
        queryKey: queryKeys.postgresServer.detail(serverId),
      });
    },
  });
}
