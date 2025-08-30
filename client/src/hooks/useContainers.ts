import { useQuery } from "@tanstack/react-query";
import { useState, useCallback } from "react";
import {
  ContainerInfo,
  ContainerListResponse,
  ContainerListApiResponse,
  ContainerFilters,
  ContainerQueryParams,
} from "@mini-infra/types";

const POLL_INTERVAL = 5000; // 5 seconds as specified in requirements

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
    refetchInterval = POLL_INTERVAL,
    retry = 3,
  } = options;

  const correlationId = generateCorrelationId();

  return useQuery({
    queryKey: ["containers", queryParams],
    queryFn: () => fetchContainers(queryParams, correlationId),
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

// Hook for managing container filter state
export function useContainerFilters(initialFilters: ContainerFilters = {}) {
  const [filters, setFilters] = useState<ContainerFilters>(initialFilters);
  const [sortBy, setSortBy] = useState<string>("name");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("asc");
  const [page, setPage] = useState<number>(1);
  const [limit, setLimit] = useState<number>(50);

  const updateFilter = useCallback(
    (key: keyof ContainerFilters, value: string | undefined) => {
      setFilters((prev) => ({
        ...prev,
        [key]: value || undefined,
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
    setFilters(initialFilters);
    setSortBy("name");
    setSortOrder("asc");
    setPage(1);
  }, [initialFilters]);

  const queryParams: ContainerQueryParams = {
    ...filters,
    sortBy,
    sortOrder,
    page,
    limit,
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
