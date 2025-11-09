import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  DatabaseGrantListResponse,
  DatabaseGrantResponse,
  DatabaseGrantDeleteResponse,
  CreateDatabaseGrantRequest,
  UpdateDatabaseGrantRequest,
} from "@mini-infra/types";

// Generate correlation ID for debugging
function generateCorrelationId(): string {
  return `database-grant-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// ====================
// Database Grant API Functions
// ====================

async function fetchGrantsForDatabase(
  serverId: string,
  databaseId: string,
  correlationId: string,
): Promise<DatabaseGrantListResponse> {
  const response = await fetch(
    `/api/postgres-server/servers/${serverId}/databases/${databaseId}/grants`,
    {
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "X-Correlation-ID": correlationId,
      },
    },
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch database grants: ${response.statusText}`);
  }

  const data: DatabaseGrantListResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to fetch database grants");
  }

  return data;
}

async function fetchGrantsForUser(
  serverId: string,
  userId: string,
  correlationId: string,
): Promise<DatabaseGrantListResponse> {
  const response = await fetch(
    `/api/postgres-server/servers/${serverId}/users/${userId}/grants`,
    {
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "X-Correlation-ID": correlationId,
      },
    },
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch user grants: ${response.statusText}`);
  }

  const data: DatabaseGrantListResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to fetch user grants");
  }

  return data;
}

async function fetchDatabaseGrant(
  grantId: string,
  correlationId: string,
): Promise<DatabaseGrantResponse> {
  const response = await fetch(`/api/postgres-server/grants/${grantId}`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch database grant: ${response.statusText}`);
  }

  const data: DatabaseGrantResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to fetch database grant");
  }

  return data;
}

async function createDatabaseGrant(
  grant: CreateDatabaseGrantRequest,
  correlationId: string,
): Promise<DatabaseGrantResponse> {
  const response = await fetch(`/api/postgres-server/grants`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
    body: JSON.stringify(grant),
  });

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(errorData.message || "Failed to create grant");
  }

  const data: DatabaseGrantResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to create grant");
  }

  return data;
}

async function updateDatabaseGrant(
  grantId: string,
  updates: UpdateDatabaseGrantRequest,
  correlationId: string,
): Promise<DatabaseGrantResponse> {
  const response = await fetch(`/api/postgres-server/grants/${grantId}`, {
    method: "PUT",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
    body: JSON.stringify(updates),
  });

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(errorData.message || "Failed to update grant");
  }

  const data: DatabaseGrantResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to update grant");
  }

  return data;
}

async function deleteDatabaseGrant(
  grantId: string,
  correlationId: string,
): Promise<DatabaseGrantDeleteResponse> {
  const response = await fetch(`/api/postgres-server/grants/${grantId}`, {
    method: "DELETE",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(errorData.message || "Failed to delete grant");
  }

  const data: DatabaseGrantDeleteResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to delete grant");
  }

  return data;
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
    queryKey: ["postgres-databases", databaseId, "grants"],
    queryFn: () =>
      fetchGrantsForDatabase(serverId!, databaseId!, generateCorrelationId()),
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
    queryKey: ["postgres-users", userId, "grants"],
    queryFn: () =>
      fetchGrantsForUser(serverId!, userId!, generateCorrelationId()),
    enabled: !!serverId && !!userId,
    staleTime: 30000,
  });
}

/**
 * Hook to fetch a single database grant
 */
export function useDatabaseGrant(grantId: string | undefined) {
  return useQuery({
    queryKey: ["postgres-grants", grantId],
    queryFn: () => fetchDatabaseGrant(grantId!, generateCorrelationId()),
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
      createDatabaseGrant(grant, generateCorrelationId()),
    onSuccess: (data) => {
      // Invalidate grants list queries
      queryClient.invalidateQueries({
        queryKey: ["postgres-grants"],
      });
      // Invalidate database to update grant count
      queryClient.invalidateQueries({
        queryKey: ["postgres-databases", data.data.databaseId],
      });
      // Invalidate user to update grant count
      queryClient.invalidateQueries({
        queryKey: ["postgres-users", data.data.userId],
      });
      // Invalidate server databases and users to update counts
      queryClient.invalidateQueries({
        queryKey: ["postgres-servers", serverId, "databases"],
      });
      queryClient.invalidateQueries({
        queryKey: ["postgres-servers", serverId, "users"],
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
    }) => updateDatabaseGrant(grantId, updates, generateCorrelationId()),
    onMutate: async ({ grantId, updates }) => {
      // Cancel outgoing refetches
      await queryClient.cancelQueries({ queryKey: ["postgres-grants", grantId] });

      // Snapshot previous value for rollback
      const previousGrant = queryClient.getQueryData<DatabaseGrantResponse>([
        "postgres-grants",
        grantId,
      ]);

      // Optimistically update the grant
      if (previousGrant) {
        queryClient.setQueryData<DatabaseGrantResponse>(["postgres-grants", grantId], {
          ...previousGrant,
          data: {
            ...previousGrant.data,
            ...updates,
          },
        });
      }

      return { previousGrant };
    },
    onError: (_err, { grantId }, context) => {
      // Rollback on error
      if (context?.previousGrant) {
        queryClient.setQueryData(["postgres-grants", grantId], context.previousGrant);
      }
    },
    onSuccess: (data) => {
      // Invalidate all related queries
      queryClient.invalidateQueries({
        queryKey: ["postgres-grants"],
      });
      queryClient.invalidateQueries({
        queryKey: ["postgres-databases", data.data.databaseId],
      });
      queryClient.invalidateQueries({
        queryKey: ["postgres-users", data.data.userId],
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
    mutationFn: (grantId: string) =>
      deleteDatabaseGrant(grantId, generateCorrelationId()),
    onSuccess: () => {
      // Invalidate grants list queries
      queryClient.invalidateQueries({
        queryKey: ["postgres-grants"],
      });
      // Invalidate server databases and users to update counts
      queryClient.invalidateQueries({
        queryKey: ["postgres-servers", serverId, "databases"],
      });
      queryClient.invalidateQueries({
        queryKey: ["postgres-servers", serverId, "users"],
      });
    },
  });
}
