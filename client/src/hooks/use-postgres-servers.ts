import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  PostgresServerListResponse,
  PostgresServerResponse,
  PostgresServerCreateResponse,
  PostgresServerDeleteResponse,
  PostgresServerSyncResponse,
  CreatePostgresServerRequest,
  UpdatePostgresServerRequest,
  TestServerConnectionRequest,
  ServerConnectionTestResponse,
  ApiRoute,
  queryKeys,
} from "@mini-infra/types";
import { apiFetch, ApiRequestError } from "@/lib/api-client";

// ====================
// PostgreSQL Server API Functions
// ====================

async function fetchPostgresServers(): Promise<PostgresServerListResponse> {
  return apiFetch<PostgresServerListResponse>(ApiRoute.postgresServer.servers(), {
    correlationIdPrefix: "postgres-server",
    unwrap: false,
  });
}

async function fetchPostgresServer(id: string): Promise<PostgresServerResponse> {
  return apiFetch<PostgresServerResponse>(ApiRoute.postgresServer.server(id), {
    correlationIdPrefix: "postgres-server",
    unwrap: false,
  });
}

async function createPostgresServer(
  server: CreatePostgresServerRequest,
): Promise<PostgresServerCreateResponse> {
  return apiFetch<PostgresServerCreateResponse>(ApiRoute.postgresServer.servers(), {
    method: "POST",
    body: server,
    correlationIdPrefix: "postgres-server",
    unwrap: false,
  });
}

async function updatePostgresServer(
  id: string,
  updates: UpdatePostgresServerRequest,
): Promise<PostgresServerResponse> {
  return apiFetch<PostgresServerResponse>(ApiRoute.postgresServer.server(id), {
    method: "PUT",
    body: updates,
    correlationIdPrefix: "postgres-server",
    unwrap: false,
  });
}

async function deletePostgresServer(
  id: string,
): Promise<PostgresServerDeleteResponse> {
  return apiFetch<PostgresServerDeleteResponse>(ApiRoute.postgresServer.server(id), {
    method: "DELETE",
    correlationIdPrefix: "postgres-server",
    unwrap: false,
  });
}

async function syncPostgresServer(
  id: string,
): Promise<PostgresServerSyncResponse> {
  return apiFetch<PostgresServerSyncResponse>(
    ApiRoute.postgresServer.serverSync(id),
    { method: "POST", correlationIdPrefix: "postgres-server", unwrap: false },
  );
}

/**
 * Test connection can return `success: false` without throwing (both as a
 * 200 response and — preserved here — when the request itself fails at the
 * HTTP level, e.g. validation or auth errors), so callers always get a
 * `ServerConnectionTestResponse` result object rather than a thrown error.
 */
async function testServerConnection(
  request: TestServerConnectionRequest,
): Promise<ServerConnectionTestResponse> {
  try {
    return await apiFetch<ServerConnectionTestResponse>(
      ApiRoute.postgresServer.testConnection(),
      {
        method: "POST",
        body: request,
        correlationIdPrefix: "postgres-server",
        unwrap: false,
      },
    );
  } catch (error) {
    if (error instanceof ApiRequestError) {
      return { success: false, message: error.message, error: error.code };
    }
    throw error;
  }
}

async function testExistingServerConnection(
  id: string,
): Promise<ServerConnectionTestResponse> {
  try {
    return await apiFetch<ServerConnectionTestResponse>(
      ApiRoute.postgresServer.serverTest(id),
      { method: "POST", correlationIdPrefix: "postgres-server", unwrap: false },
    );
  } catch (error) {
    if (error instanceof ApiRequestError) {
      return { success: false, message: error.message, error: error.code };
    }
    throw error;
  }
}

// ====================
// React Query Hooks
// ====================

/**
 * Hook to fetch all PostgreSQL servers
 */
export function usePostgresServers() {
  return useQuery({
    queryKey: queryKeys.postgresServer.all,
    queryFn: () => fetchPostgresServers(),
    staleTime: 30000, // Consider data fresh for 30 seconds
  });
}

/**
 * Hook to fetch a single PostgreSQL server by ID
 */
export function usePostgresServer(id: string | undefined) {
  return useQuery({
    queryKey: queryKeys.postgresServer.detail(id ?? ""),
    queryFn: () => fetchPostgresServer(id!),
    enabled: !!id,
    staleTime: 30000,
  });
}

/**
 * Hook to create a new PostgreSQL server
 */
export function useCreatePostgresServer() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (server: CreatePostgresServerRequest) =>
      createPostgresServer(server),
    onSuccess: () => {
      // Invalidate servers list to refetch
      queryClient.invalidateQueries({ queryKey: queryKeys.postgresServer.all });
    },
  });
}

/**
 * Hook to update a PostgreSQL server
 */
export function useUpdatePostgresServer() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      id,
      updates,
    }: {
      id: string;
      updates: UpdatePostgresServerRequest;
    }) => updatePostgresServer(id, updates),
    onSuccess: (data) => {
      // Invalidate both the list and the individual server
      queryClient.invalidateQueries({ queryKey: queryKeys.postgresServer.all });
      queryClient.invalidateQueries({
        queryKey: queryKeys.postgresServer.detail(data.data.id),
      });
    },
  });
}

/**
 * Hook to delete a PostgreSQL server
 */
export function useDeletePostgresServer() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => deletePostgresServer(id),
    onSuccess: () => {
      // Invalidate servers list to refetch
      queryClient.invalidateQueries({ queryKey: queryKeys.postgresServer.all });
    },
  });
}

/**
 * Hook to sync a server's databases and users from the live PostgreSQL instance
 */
export function useSyncPostgresServer() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => syncPostgresServer(id),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.postgresServer.detail(id) });
      queryClient.invalidateQueries({
        queryKey: queryKeys.postgresServer.databasesForServer(id),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.postgresServer.usersForServer(id),
      });
    },
  });
}

/**
 * Hook to test a server connection (before creating)
 */
export function useTestServerConnection() {
  return useMutation({
    mutationFn: (request: TestServerConnectionRequest) =>
      testServerConnection(request),
  });
}

/**
 * Hook to test an existing server's connection
 */
export function useTestExistingServerConnection() {
  return useMutation({
    mutationFn: (id: string) =>
      testExistingServerConnection(id),
  });
}
