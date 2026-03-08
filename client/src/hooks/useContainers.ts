import { useQuery, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { useState, useCallback, useEffect } from "react";
import {
  ContainerInfo,
  ContainerListResponse,
  ContainerListApiResponse,
  ContainerFilters,
  ContainerQueryParams,
  Channel,
  ServerEvent,
} from "@mini-infra/types";
import { useSocket, useSocketChannel, useSocketEvent } from "./use-socket";

const POLL_INTERVAL_CONNECTED = 30000; // 30s fallback when socket is connected
const POLL_INTERVAL_DISCONNECTED = 5000; // 5s when socket is not connected

// Generate correlation ID for debugging
function generateCorrelationId(): string {
  return `containers-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

async function fetchContainers(
  queryParams: ContainerQueryParams = {},
  correlationId: string,
): Promise<ContainerListResponse> {
  const url = new URL(`/api/containers`, window.location.origin);

  // Add query parameters
  if (queryParams.page !== undefined)
    url.searchParams.set("page", queryParams.page.toString());
  if (queryParams.limit !== undefined)
    url.searchParams.set("limit", queryParams.limit.toString());
  if (queryParams.sortBy) url.searchParams.set("sortBy", queryParams.sortBy);
  if (queryParams.sortOrder)
    url.searchParams.set("sortOrder", queryParams.sortOrder);
  if (queryParams.status) url.searchParams.set("status", queryParams.status);
  if (queryParams.name) url.searchParams.set("name", queryParams.name);
  if (queryParams.image) url.searchParams.set("image", queryParams.image);
  if (queryParams.deploymentId) url.searchParams.set("deploymentId", queryParams.deploymentId);
  if (queryParams.deploymentManaged !== undefined) url.searchParams.set("deploymentManaged", queryParams.deploymentManaged.toString());

  const response = await fetch(url.toString(), {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    // Handle specific HTTP status codes
    if (response.status === 503) {
      try {
        const errorData = await response.json();
        throw new Error(errorData.message || "Docker service is not available");
      } catch {
        throw new Error(
          "Docker service is not available. Please try again later.",
        );
      }
    }

    if (response.status === 504) {
      try {
        const errorData = await response.json();
        throw new Error(errorData.message || "Docker API request timed out");
      } catch {
        throw new Error("Docker API request timed out. Please try again.");
      }
    }

    throw new Error(`Failed to fetch containers: ${response.statusText}`);
  }

  const data: ContainerListApiResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to fetch containers");
  }

  return data.data;
}

export interface UseContainersOptions {
  enabled?: boolean;
  queryParams?: ContainerQueryParams;
  refetchInterval?: number;
  retry?: number | boolean | ((failureCount: number, error: Error) => boolean);
}

export function useContainers(options: UseContainersOptions = {}) {
  const {
    enabled = true,
    queryParams = {},
    retry = 3,
  } = options;

  const queryClient = useQueryClient();
  const { connected } = useSocket();

  // Use slower polling when socket is connected (it's just a fallback),
  // faster polling when disconnected. Allow explicit override via options.
  const refetchInterval =
    options.refetchInterval ??
    (connected ? POLL_INTERVAL_CONNECTED : POLL_INTERVAL_DISCONNECTED);

  // Subscribe to the containers channel for push updates
  useSocketChannel(Channel.CONTAINERS, enabled);

  // When server pushes a full container list update, invalidate all container queries
  // so TanStack Query refetches with proper server-side filtering/sorting
  useSocketEvent(
    ServerEvent.CONTAINERS_LIST,
    () => {
      queryClient.invalidateQueries({ queryKey: ["containers"] });
    },
    enabled,
  );

  // Optimistically update a single container's status in the cache
  useSocketEvent(
    ServerEvent.CONTAINER_STATUS,
    (data) => {
      queryClient.setQueriesData<ContainerListResponse>(
        { queryKey: ["containers"] },
        (old) => {
          if (!old) return old;
          return {
            ...old,
            containers: old.containers.map((c) =>
              c.id === data.id ? { ...c, status: data.status } : c,
            ),
          };
        },
      );
    },
    enabled,
  );

  // Remove a container from cache when it's deleted
  useSocketEvent(
    ServerEvent.CONTAINER_REMOVED,
    (data) => {
      queryClient.setQueriesData<ContainerListResponse>(
        { queryKey: ["containers"] },
        (old) => {
          if (!old) return old;
          const filtered = old.containers.filter((c) => c.id !== data.id);
          return {
            ...old,
            containers: filtered,
            totalCount: filtered.length,
          };
        },
      );
    },
    enabled,
  );

  const correlationId = generateCorrelationId();

  return useQuery({
    queryKey: ["containers", queryParams],
    queryFn: () => fetchContainers(queryParams, correlationId),
    enabled,
    refetchInterval,
    placeholderData: keepPreviousData,
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

            // Don't retry immediately on Docker service unavailable
            // Let the polling interval handle reconnection attempts
            if (
              error.message.includes("Docker service is not available") ||
              error.message.includes("Service Unavailable")
            ) {
              return false;
            }

            // Retry up to the specified number of times for other errors
            return typeof retry === "boolean" ? retry : failureCount < retry;
          },
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000), // Exponential backoff with max 30s
    staleTime: 2000, // Data is fresh for 2 seconds
    gcTime: 5 * 60 * 1000, // Keep in cache for 5 minutes
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

// LocalStorage key for persisting container filters
const CONTAINER_FILTERS_STORAGE_KEY = "mini-infra:container-filters";

// Helper to load filters from localStorage
function loadFiltersFromStorage(): {
  filters: ContainerFilters;
  sortBy: string;
  sortOrder: "asc" | "desc";
  limit: number;
} | null {
  try {
    const stored = localStorage.getItem(CONTAINER_FILTERS_STORAGE_KEY);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch (error) {
    console.error("Failed to load container filters from storage:", error);
  }
  return null;
}

// Helper to save filters to localStorage
function saveFiltersToStorage(
  filters: ContainerFilters,
  sortBy: string,
  sortOrder: "asc" | "desc",
  limit: number,
) {
  try {
    localStorage.setItem(
      CONTAINER_FILTERS_STORAGE_KEY,
      JSON.stringify({ filters, sortBy, sortOrder, limit }),
    );
  } catch (error) {
    console.error("Failed to save container filters to storage:", error);
  }
}

// Hook for managing container filter state
export function useContainerFilters(initialFilters: ContainerFilters = { status: 'running' }) {
  // Load from localStorage or use defaults
  const stored = loadFiltersFromStorage();

  const [filters, setFilters] = useState<ContainerFilters>(
    stored?.filters ?? initialFilters
  );
  const [sortBy, setSortBy] = useState<string>(stored?.sortBy ?? "name");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">(
    stored?.sortOrder ?? "asc"
  );
  const [page, setPage] = useState<number>(1);
  const [limit, setLimit] = useState<number>(stored?.limit ?? 50);

  // Save filters to localStorage whenever they change
  useEffect(() => {
    saveFiltersToStorage(filters, sortBy, sortOrder, limit);
  }, [filters, sortBy, sortOrder, limit]);

  const updateFilter = useCallback(
    (key: keyof ContainerFilters, value: string | boolean | undefined) => {
      setFilters((prev) => ({
        ...prev,
        [key]: value === "" ? undefined : value,
      }));
      // Reset to first page when filters change
      setPage(1);
    },
    [],
  );

  const updateSort = useCallback(
    (field: string, order?: "asc" | "desc") => {
      setSortBy(field);
      setSortOrder(
        order || (sortBy === field && sortOrder === "asc" ? "desc" : "asc"),
      );
      // Reset to first page when sort changes
      setPage(1);
    },
    [sortBy, sortOrder],
  );

  const resetFilters = useCallback(() => {
    setFilters({ status: 'running' });
    setSortBy("name");
    setSortOrder("asc");
    setPage(1);
  }, []);

  const queryParams: ContainerQueryParams = {
    ...filters,
    sortBy,
    sortOrder,
    page,
    limit,
    deploymentId: filters.deploymentId,
    deploymentManaged: filters.deploymentManaged,
    filters,
  };

  return {
    // Current filter state
    filters,
    sortBy,
    sortOrder,
    page,
    limit,

    // Update functions
    updateFilter,
    updateSort,
    setPage,
    setLimit,
    resetFilters,

    // Query parameters for useContainers
    queryParams,
  };
}

// Type exports for convenience
export type {
  ContainerInfo,
  ContainerListResponse,
  ContainerFilters,
  ContainerQueryParams,
};
