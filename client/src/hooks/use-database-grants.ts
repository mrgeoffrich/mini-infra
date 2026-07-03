import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  DatabaseGrantListResponse,
  DatabaseGrantResponse,
  DatabaseGrantDeleteResponse,
  CreateDatabaseGrantRequest,
  UpdateDatabaseGrantRequest,
  ApiRoute,
  queryKeys,
} from "@mini-infra/types";
import { apiFetch } from "@/lib/api-client";

// ====================
// Database Grant API Functions
// ====================

async function fetchGrantsForDatabase(
  serverId: string,
  databaseId: string,
): Promise<DatabaseGrantListResponse> {
  return apiFetch<DatabaseGrantListResponse>(
    ApiRoute.postgresServer.databaseGrants(serverId, databaseId),
    { correlationIdPrefix: "database-grant", unwrap: false },
  );
}

async function fetchGrantsForUser(
  serverId: string,
  userId: string,
): Promise<DatabaseGrantListResponse> {
  return apiFetch<DatabaseGrantListResponse>(
    ApiRoute.postgresServer.userGrants(serverId, userId),
    { correlationIdPrefix: "database-grant", unwrap: false },
  );
}

async function fetchDatabaseGrant(
  grantId: string,
): Promise<DatabaseGrantResponse> {
  return apiFetch<DatabaseGrantResponse>(ApiRoute.postgresServer.grant(grantId), {
    correlationIdPrefix: "database-grant",
    unwrap: false,
  });
}

async function createDatabaseGrant(
  grant: CreateDatabaseGrantRequest,
): Promise<DatabaseGrantResponse> {
  return apiFetch<DatabaseGrantResponse>(ApiRoute.postgresServer.grants(), {
    method: "POST",
    body: grant,
    correlationIdPrefix: "database-grant",
    unwrap: false,
  });
}

async function updateDatabaseGrant(
  grantId: string,
  updates: UpdateDatabaseGrantRequest,
): Promise<DatabaseGrantResponse> {
  return apiFetch<DatabaseGrantResponse>(ApiRoute.postgresServer.grant(grantId), {
    method: "PUT",
    body: updates,
    correlationIdPrefix: "database-grant",
    unwrap: false,
  });
}

async function deleteDatabaseGrant(
  grantId: string,
): Promise<DatabaseGrantDeleteResponse> {
  return apiFetch<DatabaseGrantDeleteResponse>(ApiRoute.postgresServer.grant(grantId), {
    method: "DELETE",
    correlationIdPrefix: "database-grant",
    unwrap: false,
  });
}

// ====================
// React Query Hooks
// ====================

/**
 * Hook to fetch all grants for a specific database
 */
export function useGrantsForDatabase(
  serverId: string | undefined,
  databaseId: string | undefined,
) {
  return useQuery({
    queryKey: queryKeys.postgresServer.databaseGrants(databaseId ?? ""),
    queryFn: () => fetchGrantsForDatabase(serverId!, databaseId!),
    enabled: !!serverId && !!databaseId,
    staleTime: 30000, // Consider data fresh for 30 seconds
  });
}

/**
 * Hook to fetch all grants for a specific user
 */
export function useGrantsForUser(
  serverId: string | undefined,
  userId: string | undefined,
) {
  return useQuery({
    queryKey: queryKeys.postgresServer.userGrants(userId ?? ""),
    queryFn: () => fetchGrantsForUser(serverId!, userId!),
    enabled: !!serverId && !!userId,
    staleTime: 30000,
  });
}

/**
 * Hook to fetch a single database grant
 */
export function useDatabaseGrant(grantId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.postgresServer.grant(grantId ?? ""),
    queryFn: () => fetchDatabaseGrant(grantId!),
    enabled: !!grantId,
    staleTime: 30000,
  });
}

/**
 * Hook to create a new database grant
 */
export function useCreateDatabaseGrant(serverId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (grant: CreateDatabaseGrantRequest) =>
      createDatabaseGrant(grant),
    onSuccess: (data) => {
      // Invalidate grants list queries
      queryClient.invalidateQueries({
        queryKey: queryKeys.postgresServer.grants,
      });
      // Invalidate database to update grant count
      queryClient.invalidateQueries({
        queryKey: queryKeys.postgresServer.database(data.data.databaseId),
      });
      // Invalidate user to update grant count
      queryClient.invalidateQueries({
        queryKey: queryKeys.postgresServer.user(data.data.userId),
      });
      // Invalidate server databases and users to update counts
      queryClient.invalidateQueries({
        queryKey: queryKeys.postgresServer.databasesForServer(serverId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.postgresServer.usersForServer(serverId),
      });
    },
  });
}

/**
 * Hook to update a database grant
 */
export function useUpdateDatabaseGrant() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      grantId,
      updates,
    }: {
      grantId: string;
      updates: UpdateDatabaseGrantRequest;
    }) => updateDatabaseGrant(grantId, updates),
    onMutate: async ({ grantId, updates }) => {
      // Cancel outgoing refetches
      await queryClient.cancelQueries({ queryKey: queryKeys.postgresServer.grant(grantId) });

      // Snapshot previous value for rollback
      const previousGrant = queryClient.getQueryData<DatabaseGrantResponse>(
        queryKeys.postgresServer.grant(grantId),
      );

      // Optimistically update the grant
      if (previousGrant) {
        queryClient.setQueryData<DatabaseGrantResponse>(
          queryKeys.postgresServer.grant(grantId),
          {
            ...previousGrant,
            data: {
              ...previousGrant.data,
              ...updates,
            },
          },
        );
      }

      return { previousGrant };
    },
    onError: (_err, { grantId }, context) => {
      // Rollback on error
      if (context?.previousGrant) {
        queryClient.setQueryData(queryKeys.postgresServer.grant(grantId), context.previousGrant);
      }
    },
    onSuccess: (data) => {
      // Invalidate all related queries
      queryClient.invalidateQueries({
        queryKey: queryKeys.postgresServer.grants,
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.postgresServer.database(data.data.databaseId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.postgresServer.user(data.data.userId),
      });
    },
  });
}

/**
 * Hook to delete a database grant (revoke all permissions)
 */
export function useDeleteDatabaseGrant(serverId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (grantId: string) => deleteDatabaseGrant(grantId),
    onSuccess: () => {
      // Invalidate grants list queries
      queryClient.invalidateQueries({
        queryKey: queryKeys.postgresServer.grants,
      });
      // Invalidate server databases and users to update counts
      queryClient.invalidateQueries({
        queryKey: queryKeys.postgresServer.databasesForServer(serverId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.postgresServer.usersForServer(serverId),
      });
    },
  });
}
