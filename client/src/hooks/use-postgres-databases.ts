import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useCallback } from "react";
import {
  PostgresDatabaseInfo,
  PostgresDatabaseListResponse,
  PostgresDatabaseResponse,
  PostgresDatabaseDeleteResponse,
  CreatePostgresDatabaseRequest,
  UpdatePostgresDatabaseRequest,
  TestDatabaseConnectionRequest,
  DatabaseConnectionTestResponse,
  PostgresDatabaseFilter,
  PostgresDatabaseSortOptions,
  DatabaseHealthStatus,
} from "@mini-infra/types";

// Generate correlation ID for debugging
function generateCorrelationId(): string {
  return `postgres-db-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// ====================
// PostgreSQL Database API Functions
// ====================

async function fetchPostgresDatabases(
  filters: PostgresDatabaseFilter = {},
  page = 1,
  limit = 20,
  sortBy: keyof PostgresDatabaseInfo = "name",
  sortOrder: "asc" | "desc" = "asc",
  correlationId: string,
): Promise<PostgresDatabaseListResponse> {
  const url = new URL(`/api/postgres/databases`, window.location.origin);

  // Add query parameters
  url.searchParams.set("page", page.toString());
  url.searchParams.set("limit", limit.toString());
  url.searchParams.set("sortBy", sortBy);
  url.searchParams.set("sortOrder", sortOrder);
  if (filters.name) url.searchParams.set("name", filters.name);
  if (filters.host) url.searchParams.set("host", filters.host);
  if (filters.healthStatus)
    url.searchParams.set("healthStatus", filters.healthStatus);
  if (filters.tags && filters.tags.length > 0) {
    url.searchParams.set("tags", filters.tags.join(","));
  }

  const response = await fetch(url.toString(), {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch PostgreSQL databases: ${response.statusText}`,
    );
  }

  const data: PostgresDatabaseListResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to fetch PostgreSQL databases");
  }

  return data;
}

async function fetchPostgresDatabase(
  id: string,
  correlationId: string,
): Promise<PostgresDatabaseResponse> {
  const response = await fetch(`/api/postgres/databases/${id}`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch PostgreSQL database: ${response.statusText}`,
    );
  }

  const data: PostgresDatabaseResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to fetch PostgreSQL database");
  }

  return data;
}

async function createPostgresDatabase(
  request: CreatePostgresDatabaseRequest,
  correlationId: string,
): Promise<PostgresDatabaseResponse> {
  const response = await fetch(`/api/postgres/databases`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to create PostgreSQL database: ${response.statusText}`,
    );
  }

  const data: PostgresDatabaseResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to create PostgreSQL database");
  }

  return data;
}

async function updatePostgresDatabase(
  id: string,
  request: UpdatePostgresDatabaseRequest,
  correlationId: string,
): Promise<PostgresDatabaseResponse> {
  const response = await fetch(`/api/postgres/databases/${id}`, {
    method: "PUT",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to update PostgreSQL database: ${response.statusText}`,
    );
  }

  const data: PostgresDatabaseResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to update PostgreSQL database");
  }

  return data;
}

async function deletePostgresDatabase(
  id: string,
  correlationId: string,
): Promise<PostgresDatabaseDeleteResponse> {
  const response = await fetch(`/api/postgres/databases/${id}`, {
    method: "DELETE",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to delete PostgreSQL database: ${response.statusText}`,
    );
  }

  const data: PostgresDatabaseDeleteResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to delete PostgreSQL database");
  }

  return data;
}

async function testDatabaseConnection(
  request: TestDatabaseConnectionRequest,
  correlationId: string,
): Promise<DatabaseConnectionTestResponse> {
  const response = await fetch(`/api/postgres/databases/test-connection`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to test database connection: ${response.statusText}`,
    );
  }

  const data: DatabaseConnectionTestResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to test database connection");
  }

  return data;
}

async function testExistingDatabaseConnection(
  id: string,
  correlationId: string,
): Promise<DatabaseConnectionTestResponse> {
  const response = await fetch(`/api/postgres/databases/${id}/test`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to test existing database connection: ${response.statusText}`,
    );
  }

  const data: DatabaseConnectionTestResponse = await response.json();

  if (!data.success) {
    throw new Error(
      data.message || "Failed to test existing database connection",
    );
  }

  return data;
}

// ====================
// PostgreSQL Database Hooks
// ====================

export interface UsePostgresDatabasesOptions {
  enabled?: boolean;
  refetchInterval?: number;
  retry?: number | boolean | ((failureCount: number, error: Error) => boolean);
  filters?: PostgresDatabaseFilter;
  page?: number;
  limit?: number;
  sortBy?: keyof PostgresDatabaseInfo;
  sortOrder?: "asc" | "desc";
}

export function usePostgresDatabases(
  options: UsePostgresDatabasesOptions = {},
) {
  const {
    enabled = true,
    refetchInterval,
    retry = 3,
    filters = {},
    page = 1,
    limit = 20,
    sortBy = "name",
    sortOrder = "asc",
  } = options;

  const correlationId = generateCorrelationId();

  return useQuery({
    queryKey: ["postgresDatabases", filters, page, limit, sortBy, sortOrder],
    queryFn: () =>
      fetchPostgresDatabases(
        filters,
        page,
        limit,
        sortBy,
        sortOrder,
        correlationId,
      ),
    enabled,
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

export interface UsePostgresDatabaseOptions {
  enabled?: boolean;
  refetchInterval?: number;
  retry?: number | boolean | ((failureCount: number, error: Error) => boolean);
}

export function usePostgresDatabase(
  id: string,
  options: UsePostgresDatabaseOptions = {},
) {
  const { enabled = true, refetchInterval, retry = 3 } = options;

  const correlationId = generateCorrelationId();

  return useQuery({
    queryKey: ["postgresDatabase", id],
    queryFn: () => fetchPostgresDatabase(id, correlationId),
    enabled: enabled && !!id,
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
            // Don't retry on not found errors
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
    staleTime: 5000, // Data is fresh for 5 seconds
    gcTime: 5 * 60 * 1000, // Keep in cache for 5 minutes
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

// Mutation hooks for database operations
export function useCreatePostgresDatabase() {
  const queryClient = useQueryClient();
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: (request: CreatePostgresDatabaseRequest) =>
      createPostgresDatabase(request, correlationId),
    onSuccess: () => {
      // Invalidate and refetch databases list
      queryClient.invalidateQueries({ queryKey: ["postgresDatabases"] });
    },
  });
}

export function useUpdatePostgresDatabase() {
  const queryClient = useQueryClient();
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: ({
      id,
      request,
    }: {
      id: string;
      request: UpdatePostgresDatabaseRequest;
    }) => updatePostgresDatabase(id, request, correlationId),
    onSuccess: (_, { id }) => {
      // Invalidate and refetch databases list and specific database
      queryClient.invalidateQueries({ queryKey: ["postgresDatabases"] });
      queryClient.invalidateQueries({ queryKey: ["postgresDatabase", id] });
      // Also invalidate backup configs as database info might affect them
      queryClient.invalidateQueries({ queryKey: ["postgresBackupConfig", id] });
    },
  });
}

export function useDeletePostgresDatabase() {
  const queryClient = useQueryClient();
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: (id: string) => deletePostgresDatabase(id, correlationId),
    onSuccess: (_, id) => {
      // Invalidate and refetch databases list
      queryClient.invalidateQueries({ queryKey: ["postgresDatabases"] });
      // Remove specific database from cache
      queryClient.removeQueries({ queryKey: ["postgresDatabase", id] });
      // Remove related data
      queryClient.removeQueries({ queryKey: ["postgresBackupConfig", id] });
      queryClient.removeQueries({ queryKey: ["postgresBackupOperations", id] });
      queryClient.removeQueries({
        queryKey: ["postgresRestoreOperations", id],
      });
    },
  });
}

export function useTestDatabaseConnection() {
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: (request: TestDatabaseConnectionRequest) =>
      testDatabaseConnection(request, correlationId),
  });
}

export function useTestExistingDatabaseConnection() {
  const queryClient = useQueryClient();
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: (id: string) =>
      testExistingDatabaseConnection(id, correlationId),
    onSuccess: (_, id) => {
      // Invalidate database data to refresh health status
      queryClient.invalidateQueries({ queryKey: ["postgresDatabase", id] });
      queryClient.invalidateQueries({ queryKey: ["postgresDatabases"] });
    },
  });
}

// ====================
// Database Filter Hook
// ====================

export interface PostgresDatabaseFiltersState {
  name?: string;
  host?: string;
  healthStatus?: DatabaseHealthStatus;
  tags?: string[];
  sortBy: keyof PostgresDatabaseInfo;
  sortOrder: "asc" | "desc";
  page: number;
  limit: number;
}

export function usePostgresDatabaseFilters(
  initialFilters: Partial<PostgresDatabaseFiltersState> = {},
) {
  const [filters, setFilters] = useState<PostgresDatabaseFiltersState>({
    sortBy: "name",
    sortOrder: "asc",
    page: 1,
    limit: 20,
    ...initialFilters,
  });

  const updateFilter = useCallback(
    <K extends keyof PostgresDatabaseFiltersState>(
      key: K,
      value: PostgresDatabaseFiltersState[K],
    ) => {
      setFilters((prev) => ({
        ...prev,
        [key]: value,
        // Reset to first page when filters change (except when updating page itself)
        page: key === "page" ? (value as number) : 1,
      }));
    },
    [],
  );

  const resetFilters = useCallback(() => {
    setFilters({
      sortBy: "name",
      sortOrder: "asc",
      page: 1,
      limit: 20,
      ...initialFilters,
    });
  }, [initialFilters]);

  return {
    filters,
    updateFilter,
    resetFilters,
  };
}

// ====================
// Type Exports
// ====================

export type {
  PostgresDatabaseInfo,
  PostgresDatabaseListResponse,
  PostgresDatabaseResponse,
  PostgresDatabaseDeleteResponse,
  CreatePostgresDatabaseRequest,
  UpdatePostgresDatabaseRequest,
  TestDatabaseConnectionRequest,
  DatabaseConnectionTestResponse,
  PostgresDatabaseFilter,
  PostgresDatabaseSortOptions,
  DatabaseHealthStatus,
};
