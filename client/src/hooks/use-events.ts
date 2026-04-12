import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useCallback } from "react";
import {
  UserEventInfo,
  UserEventListResponse,
  UserEventResponse,
  UserEventFilter,
  DeleteUserEventResponse,
  UserEventStatisticsResponse,
  Channel,
  ServerEvent,
} from "@mini-infra/types";
import { useSocket, useSocketChannel, useSocketEvent } from "./use-socket";

// Generate correlation ID for debugging
function generateCorrelationId(): string {
  return `user-event-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// ====================
// User Events API Functions
// ====================

async function fetchEvents(
  filters: UserEventFilter = {},
  page = 1,
  limit = 50,
  sortBy: keyof UserEventInfo = "startedAt",
  sortOrder: "asc" | "desc" = "desc",
  correlationId: string,
): Promise<UserEventListResponse> {
  const url = new URL(`/api/events`, window.location.origin);

  // Add pagination
  url.searchParams.set("limit", limit.toString());
  url.searchParams.set("offset", ((page - 1) * limit).toString());
  url.searchParams.set("sortBy", sortBy);
  url.searchParams.set("sortOrder", sortOrder);

  // Add filters
  if (filters.eventType) {
    const types = Array.isArray(filters.eventType) ? filters.eventType : [filters.eventType];
    types.forEach(type => url.searchParams.append("eventType", type));
  }
  if (filters.eventCategory) {
    const categories = Array.isArray(filters.eventCategory) ? filters.eventCategory : [filters.eventCategory];
    categories.forEach(category => url.searchParams.append("eventCategory", category));
  }
  if (filters.status) {
    const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
    statuses.forEach(status => url.searchParams.append("status", status));
  }
  if (filters.userId) url.searchParams.set("userId", filters.userId);
  if (filters.resourceType) {
    const types = Array.isArray(filters.resourceType) ? filters.resourceType : [filters.resourceType];
    types.forEach(type => url.searchParams.append("resourceType", type));
  }
  if (filters.resourceId) url.searchParams.set("resourceId", filters.resourceId);
  if (filters.startDate) {
    const date = typeof filters.startDate === 'string' ? filters.startDate : filters.startDate.toISOString();
    url.searchParams.set("startDate", date);
  }
  if (filters.endDate) {
    const date = typeof filters.endDate === 'string' ? filters.endDate : filters.endDate.toISOString();
    url.searchParams.set("endDate", date);
  }
  if (filters.search) url.searchParams.set("search", filters.search);

  const response = await fetch(url.toString(), {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch events: ${response.statusText}`);
  }

  const data: UserEventListResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to fetch events");
  }

  return data;
}

async function fetchEvent(
  id: string,
  correlationId: string,
): Promise<UserEventResponse> {
  const response = await fetch(`/api/events/${id}`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch event: ${response.statusText}`);
  }

  const data: UserEventResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to fetch event");
  }

  return data;
}

async function fetchEventStatistics(
  correlationId: string,
): Promise<UserEventStatisticsResponse> {
  const response = await fetch(`/api/events/statistics`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch event statistics: ${response.statusText}`);
  }

  const data: UserEventStatisticsResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to fetch event statistics");
  }

  return data;
}

async function deleteEvent(
  id: string,
  correlationId: string,
): Promise<DeleteUserEventResponse> {
  const response = await fetch(`/api/events/${id}`, {
    method: "DELETE",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to delete event: ${response.statusText}`);
  }

  const data: DeleteUserEventResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to delete event");
  }

  return data;
}

// ====================
// User Events Hooks
// ====================

export interface UseEventsOptions {
  enabled?: boolean;
  refetchInterval?: number;
  retry?: number | boolean | ((failureCount: number, error: Error) => boolean);
  filters?: UserEventFilter;
  page?: number;
  limit?: number;
  sortBy?: keyof UserEventInfo;
  sortOrder?: "asc" | "desc";
}

export function useEvents(options: UseEventsOptions = {}) {
  const {
    enabled = true,
    retry = 3,
    filters = {},
    page = 1,
    limit = 50,
    sortBy = "startedAt",
    sortOrder = "desc",
  } = options;

  const queryClient = useQueryClient();
  const { connected } = useSocket();
  const correlationId = generateCorrelationId();

  // Subscribe to the events channel for push updates
  useSocketChannel(Channel.EVENTS, enabled);

  // When a new event is created, invalidate the events list
  useSocketEvent(
    ServerEvent.EVENT_CREATED,
    () => {
      queryClient.invalidateQueries({ queryKey: ["events"] });
      queryClient.invalidateQueries({ queryKey: ["eventStatistics"] });
    },
    enabled,
  );

  // When an event is updated, invalidate the events list
  useSocketEvent(
    ServerEvent.EVENT_UPDATED,
    () => {
      queryClient.invalidateQueries({ queryKey: ["events"] });
      queryClient.invalidateQueries({ queryKey: ["eventStatistics"] });
    },
    enabled,
  );

  // No polling when socket is connected
  const refetchInterval = options.refetchInterval ?? (connected ? false : 5000);

  return useQuery({
    queryKey: ["events", filters, page, limit, sortBy, sortOrder],
    queryFn: () =>
      fetchEvents(filters, page, limit, sortBy, sortOrder, correlationId),
    enabled,
    refetchInterval,
    retry:
      typeof retry === "function"
        ? retry
        : (failureCount: number, error: Error) => {
            if (
              (error instanceof Error ? error.message : String(error)).includes("401") ||
              (error instanceof Error ? error.message : String(error)).includes("Unauthorized")
            ) {
              return false;
            }
            return typeof retry === "boolean" ? retry : failureCount < retry;
          },
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),
    staleTime: 10000,
    gcTime: 5 * 60 * 1000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

export interface UseEventOptions {
  enabled?: boolean;
  refetchInterval?: number;
  retry?: number | boolean | ((failureCount: number, error: Error) => boolean);
}

export function useEvent(id: string, options: UseEventOptions = {}) {
  const { enabled = true, refetchInterval, retry = 3 } = options;

  const queryClient = useQueryClient();
  const { connected } = useSocket();
  const correlationId = generateCorrelationId();

  // Subscribe to the events channel
  useSocketChannel(Channel.EVENTS, enabled && !!id);

  // When this event is updated, invalidate
  useSocketEvent(
    ServerEvent.EVENT_UPDATED,
    (data) => {
      if (data.id === id) {
        queryClient.invalidateQueries({ queryKey: ["event", id] });
      }
    },
    enabled && !!id,
  );

  return useQuery({
    queryKey: ["event", id],
    queryFn: () => fetchEvent(id, correlationId),
    enabled: enabled && !!id,
    refetchInterval: connected
      ? false
      : (query: any) => {
          const event = query.state.data?.data;
          if (event?.status === "running" || event?.status === "pending") {
            return refetchInterval || 5000;
          }
          return refetchInterval || false;
        },
    retry:
      typeof retry === "function"
        ? retry
        : (failureCount: number, error: Error) => {
            if (
              (error instanceof Error ? error.message : String(error)).includes("401") ||
              (error instanceof Error ? error.message : String(error)).includes("Unauthorized")
            ) {
              return false;
            }
            if (
              (error instanceof Error ? error.message : String(error)).includes("404") ||
              (error instanceof Error ? error.message : String(error)).includes("Not found")
            ) {
              return false;
            }
            return typeof retry === "boolean" ? retry : failureCount < retry;
          },
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),
    staleTime: 5000,
    gcTime: 5 * 60 * 1000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

export function useEventStatistics(options: { enabled?: boolean; refetchInterval?: number } = {}) {
  const { enabled = true } = options;
  const { connected } = useSocket();

  const correlationId = generateCorrelationId();

  // Statistics are invalidated by useEvents' EVENT_CREATED/EVENT_UPDATED handlers.
  // Just disable polling when socket is connected.
  const refetchInterval = options.refetchInterval ?? (connected ? false : 30000);

  return useQuery({
    queryKey: ["eventStatistics"],
    queryFn: () => fetchEventStatistics(correlationId),
    enabled,
    refetchInterval,
    staleTime: 20000,
    gcTime: 5 * 60 * 1000,
  });
}

export function useDeleteEvent() {
  const queryClient = useQueryClient();
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: (id: string) => deleteEvent(id, correlationId),
    onSuccess: (_, id) => {
      queryClient.removeQueries({ queryKey: ["event", id] });
      queryClient.invalidateQueries({ queryKey: ["events"] });
      queryClient.invalidateQueries({ queryKey: ["eventStatistics"] });
    },
  });
}

// ====================
// Event Filter Hook
// ====================

export interface EventFiltersState {
  eventType?: string[];
  eventCategory?: string[];
  status?: string[];
  search?: string;
  startDate?: string;
  endDate?: string;
  sortBy: keyof UserEventInfo;
  sortOrder: "asc" | "desc";
  page: number;
  limit: number;
}

export function useEventFilters(
  initialFilters: Partial<EventFiltersState> = {},
) {
  const [filters, setFilters] = useState<EventFiltersState>({
    sortBy: "startedAt",
    sortOrder: "desc",
    page: 1,
    limit: 50,
    ...initialFilters,
  });

  const updateFilter = useCallback(
    <K extends keyof EventFiltersState>(
      key: K,
      value: EventFiltersState[K],
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
      sortBy: "startedAt",
      sortOrder: "desc",
      page: 1,
      limit: 50,
      ...initialFilters,
    });
  }, [initialFilters]);

  return {
    filters,
    updateFilter,
    resetFilters,
  };
}
