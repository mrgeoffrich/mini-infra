import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  PostgresServerListResponse,
  PostgresServerResponse,
  PostgresServerCreateResponse,
  PostgresServerDeleteResponse,
  CreatePostgresServerRequest,
  UpdatePostgresServerRequest,
  TestServerConnectionRequest,
  ServerConnectionTestResponse,
} from "@mini-infra/types";

// Generate correlation ID for debugging
function generateCorrelationId(): string {
  return `postgres-server-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// ====================
// PostgreSQL Server API Functions
// ====================

async function fetchPostgresServers(
  correlationId: string,
): Promise<PostgresServerListResponse> {
  const response = await fetch(`/api/postgres-server/servers`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch PostgreSQL servers: ${response.statusText}`,
    );
  }

  const data: PostgresServerListResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to fetch PostgreSQL servers");
  }

  return data;
}

async function fetchPostgresServer(
  id: string,
  correlationId: string,
): Promise<PostgresServerResponse> {
  const response = await fetch(`/api/postgres-server/servers/${id}`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch PostgreSQL server: ${response.statusText}`,
    );
  }

  const data: PostgresServerResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to fetch PostgreSQL server");
  }

  return data;
}

async function createPostgresServer(
  server: CreatePostgresServerRequest,
  correlationId: string,
): Promise<PostgresServerCreateResponse> {
  const response = await fetch(`/api/postgres-server/servers`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
    body: JSON.stringify(server),
  });

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(errorData.message || "Failed to create PostgreSQL server");
  }

  const data: PostgresServerCreateResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to create PostgreSQL server");
  }

  return data;
}

async function updatePostgresServer(
  id: string,
  updates: UpdatePostgresServerRequest,
  correlationId: string,
): Promise<PostgresServerResponse> {
  const response = await fetch(`/api/postgres-server/servers/${id}`, {
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
    throw new Error(errorData.message || "Failed to update PostgreSQL server");
  }

  const data: PostgresServerResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to update PostgreSQL server");
  }

  return data;
}

async function deletePostgresServer(
  id: string,
  correlationId: string,
): Promise<PostgresServerDeleteResponse> {
  const response = await fetch(`/api/postgres-server/servers/${id}`, {
    method: "DELETE",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(errorData.message || "Failed to delete PostgreSQL server");
  }

  const data: PostgresServerDeleteResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to delete PostgreSQL server");
  }

  return data;
}

async function testServerConnection(
  request: TestServerConnectionRequest,
  correlationId: string,
): Promise<ServerConnectionTestResponse> {
  const response = await fetch(`/api/postgres-server/servers/test-connection`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
    body: JSON.stringify(request),
  });

  const data: ServerConnectionTestResponse = await response.json();

  // Test connection can return success: false without throwing
  return data;
}

async function testExistingServerConnection(
  id: string,
  correlationId: string,
): Promise<ServerConnectionTestResponse> {
  const response = await fetch(`/api/postgres-server/servers/${id}/test`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  const data: ServerConnectionTestResponse = await response.json();

  // Test connection can return success: false without throwing
  return data;
}

// ====================
// React Query Hooks
// ====================

/**
 * Hook to fetch all PostgreSQL servers
 */
export function usePostgresServers() {
  return useQuery({
    queryKey: ["postgres-servers"],
    queryFn: () => fetchPostgresServers(generateCorrelationId()),
    staleTime: 30000, // Consider data fresh for 30 seconds
  });
}

/**
 * Hook to fetch a single PostgreSQL server by ID
 */
export function usePostgresServer(id: string | undefined) {
  return useQuery({
    queryKey: ["postgres-servers", id],
    queryFn: () => fetchPostgresServer(id!, generateCorrelationId()),
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
      createPostgresServer(server, generateCorrelationId()),
    onSuccess: () => {
      // Invalidate servers list to refetch
      queryClient.invalidateQueries({ queryKey: ["postgres-servers"] });
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
    }) => updatePostgresServer(id, updates, generateCorrelationId()),
    onSuccess: (data) => {
      // Invalidate both the list and the individual server
      queryClient.invalidateQueries({ queryKey: ["postgres-servers"] });
      queryClient.invalidateQueries({
        queryKey: ["postgres-servers", data.data.id],
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
    mutationFn: (id: string) =>
      deletePostgresServer(id, generateCorrelationId()),
    onSuccess: () => {
      // Invalidate servers list to refetch
      queryClient.invalidateQueries({ queryKey: ["postgres-servers"] });
    },
  });
}

/**
 * Hook to test a server connection (before creating)
 */
export function useTestServerConnection() {
  return useMutation({
    mutationFn: (request: TestServerConnectionRequest) =>
      testServerConnection(request, generateCorrelationId()),
  });
}

/**
 * Hook to test an existing server's connection
 */
export function useTestExistingServerConnection() {
  return useMutation({
    mutationFn: (id: string) =>
      testExistingServerConnection(id, generateCorrelationId()),
  });
}
