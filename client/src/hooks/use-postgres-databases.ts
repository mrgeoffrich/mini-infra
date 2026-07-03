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
  DiscoverDatabasesRequest,
  DatabaseConnectionTestResponse,
  DatabaseDiscoveryResponse,
  PostgresDatabaseFilter,
  PostgresDatabaseSortOptions,
  DatabaseHealthStatus,
  ApiRoute,
  queryKeys,
} from "@mini-infra/types";
import { apiFetch } from "@/lib/api-client";

// ====================
// PostgreSQL Database API Functions
// ====================

async function fetchPostgresDatabases(
  filters: PostgresDatabaseFilter = {},
  page = 1,
  limit = 20,
  sortBy: keyof PostgresDatabaseInfo = "name",
  sortOrder: "asc" | "desc" = "asc",
): Promise<PostgresDatabaseListResponse> {
  const url = new URL(ApiRoute.postgres.databases(), window.location.origin);

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

  return apiFetch<PostgresDatabaseListResponse>(url.toString(), {
    correlationIdPrefix: "postgres-db",
    unwrap: false,
  });
}

async function fetchPostgresDatabase(id: string): Promise<PostgresDatabaseResponse> {
  return apiFetch<PostgresDatabaseResponse>(ApiRoute.postgres.database(id), {
    correlationIdPrefix: "postgres-db",
    unwrap: false,
  });
}

async function createPostgresDatabase(
  request: CreatePostgresDatabaseRequest,
): Promise<PostgresDatabaseResponse> {
  return apiFetch<PostgresDatabaseResponse>(ApiRoute.postgres.databases(), {
    method: "POST",
    body: request,
    correlationIdPrefix: "postgres-db",
    unwrap: false,
  });
}

async function updatePostgresDatabase(
  id: string,
  request: UpdatePostgresDatabaseRequest,
): Promise<PostgresDatabaseResponse> {
  return apiFetch<PostgresDatabaseResponse>(ApiRoute.postgres.database(id), {
    method: "PUT",
    body: request,
    correlationIdPrefix: "postgres-db",
    unwrap: false,
  });
}

async function deletePostgresDatabase(
  id: string,
): Promise<PostgresDatabaseDeleteResponse> {
  return apiFetch<PostgresDatabaseDeleteResponse>(ApiRoute.postgres.database(id), {
    method: "DELETE",
    correlationIdPrefix: "postgres-db",
    unwrap: false,
  });
}

async function testDatabaseConnection(
  request: TestDatabaseConnectionRequest,
): Promise<DatabaseConnectionTestResponse> {
  return apiFetch<DatabaseConnectionTestResponse>(
    ApiRoute.postgres.testConnection(),
    { method: "POST", body: request, correlationIdPrefix: "postgres-db", unwrap: false },
  );
}

async function testExistingDatabaseConnection(
  id: string,
): Promise<DatabaseConnectionTestResponse> {
  return apiFetch<DatabaseConnectionTestResponse>(
    ApiRoute.postgres.databaseTest(id),
    { method: "POST", correlationIdPrefix: "postgres-db", unwrap: false },
  );
}

async function discoverDatabases(
  request: DiscoverDatabasesRequest,
): Promise<DatabaseDiscoveryResponse> {
  return apiFetch<DatabaseDiscoveryResponse>(ApiRoute.postgres.discoverDatabases(), {
    method: "POST",
    body: request,
    correlationIdPrefix: "postgres-db",
    unwrap: false,
  });
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

  return useQuery({
    queryKey: queryKeys.postgresDatabases.list(filters, page, limit, sortBy, sortOrder),
    queryFn: () =>
      fetchPostgresDatabases(
        filters,
        page,
        limit,
        sortBy,
        sortOrder,
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

  return useQuery({
    queryKey: queryKeys.postgresDatabases.detail(id),
    queryFn: () => fetchPostgresDatabase(id),
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

  return useMutation({
    mutationFn: (request: CreatePostgresDatabaseRequest) =>
      createPostgresDatabase(request),
    onSuccess: () => {
      // Invalidate and refetch databases list
      queryClient.invalidateQueries({ queryKey: queryKeys.postgresDatabases.all });
    },
  });
}

export function useUpdatePostgresDatabase() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      id,
      request,
    }: {
      id: string;
      request: UpdatePostgresDatabaseRequest;
    }) => updatePostgresDatabase(id, request),
    onSuccess: (_, { id }) => {
      // Invalidate and refetch databases list and specific database
      queryClient.invalidateQueries({ queryKey: queryKeys.postgresDatabases.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.postgresDatabases.detail(id) });
      // Also invalidate backup configs as database info might affect them
      queryClient.invalidateQueries({ queryKey: queryKeys.postgresBackupConfig.forDatabase(id) });
    },
  });
}

export function useDeletePostgresDatabase() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => deletePostgresDatabase(id),
    onSuccess: (_, id) => {
      // Invalidate and refetch databases list
      queryClient.invalidateQueries({ queryKey: queryKeys.postgresDatabases.all });
      // Remove specific database from cache
      queryClient.removeQueries({ queryKey: queryKeys.postgresDatabases.detail(id) });
      // Remove related data
      queryClient.removeQueries({ queryKey: queryKeys.postgresBackupConfig.forDatabase(id) });
      queryClient.removeQueries({ queryKey: queryKeys.postgresBackupOperations.forDatabase(id) });
      queryClient.removeQueries({
        queryKey: queryKeys.postgresRestoreOperations.forDatabase(id),
      });
    },
  });
}

export function useTestDatabaseConnection() {
  return useMutation({
    mutationFn: (request: TestDatabaseConnectionRequest) =>
      testDatabaseConnection(request),
  });
}

export function useTestExistingDatabaseConnection() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => testExistingDatabaseConnection(id),
    onSuccess: (_, id) => {
      // Invalidate database data to refresh health status
      queryClient.invalidateQueries({ queryKey: queryKeys.postgresDatabases.detail(id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.postgresDatabases.all });
    },
  });
}

export function useDiscoverDatabases() {
  return useMutation({
    mutationFn: (request: DiscoverDatabasesRequest) =>
      discoverDatabases(request),
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
