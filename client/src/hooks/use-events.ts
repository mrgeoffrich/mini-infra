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
  ApiRoute,
  queryKeys,
} from "@mini-infra/types";
import { useSocket, useSocketChannel, useSocketEvent } from "./use-socket";
import { apiFetch, ApiRequestError } from "@/lib/api-client";

// ====================
// User Events API Functions
// ====================

async function fetchEvents(
  filters: UserEventFilter = {},
  page = 1,
  limit = 50,
  sortBy: keyof UserEventInfo = "startedAt",
  sortOrder: "asc" | "desc" = "desc",
): Promise<UserEventListResponse> {
  const url = new URL(ApiRoute.events.list(), window.location.origin);

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

  // Envelope preserved raw (not unwrapped) — `useEvents` reads
  // `data.data`/`data.pagination` off the full response.
  return apiFetch<UserEventListResponse>(url.toString(), {
    correlationIdPrefix: "user-event",
    unwrap: false,
  });
}

async function fetchEvent(id: string): Promise<UserEventResponse> {
  // Envelope preserved raw — `useEvent` reads `eventResponse.data`.
  return apiFetch<UserEventResponse>(ApiRoute.events.get(id), {
    correlationIdPrefix: "user-event",
    unwrap: false,
  });
}

async function fetchEventStatistics(): Promise<UserEventStatisticsResponse> {
  // Envelope preserved raw — `useEventStatistics` reads `.data` off the result.
  return apiFetch<UserEventStatisticsResponse>(ApiRoute.events.statistics(), {
    correlationIdPrefix: "user-event",
    unwrap: false,
  });
}

async function deleteEvent(id: string): Promise<DeleteUserEventResponse> {
  // Flat response shape ({ success, message } — no nested `data`), so this
  // stays raw rather than unwrapped.
  return apiFetch<DeleteUserEventResponse>(ApiRoute.events.get(id), {
    method: "DELETE",
    correlationIdPrefix: "user-event",
    unwrap: false,
  });
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

/**
 * Query key for the paginated/filtered events list. No dedicated `list()`
 * builder for events in the registry yet (see Phase 4 report) — derived from
 * the `all` root here so it still prefix-matches `queryKeys.events.all`.
 */
function eventsListKey(
  filters: UserEventFilter,
  page: number,
  limit: number,
  sortBy: keyof UserEventInfo,
  sortOrder: "asc" | "desc",
) {
  return [...queryKeys.events.all, filters, page, limit, sortBy, sortOrder] as const;
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

  // Subscribe to the events channel for push updates
  useSocketChannel(Channel.EVENTS, enabled);

  // When a new event is created, invalidate the events list
  useSocketEvent(
    ServerEvent.EVENT_CREATED,
    () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.events.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.events.statistics });
    },
    enabled,
  );

  // When an event is updated, invalidate the events list
  useSocketEvent(
    ServerEvent.EVENT_UPDATED,
    () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.events.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.events.statistics });
    },
    enabled,
  );

  // No polling when socket is connected
  const refetchInterval = options.refetchInterval ?? (connected ? false : 5000);

  return useQuery({
    queryKey: eventsListKey(filters, page, limit, sortBy, sortOrder),
    queryFn: () => fetchEvents(filters, page, limit, sortBy, sortOrder),
    enabled,
    refetchInterval,
    retry:
      typeof retry === "function"
        ? retry
        : (failureCount: number, error: Error) => {
            if (error instanceof ApiRequestError && error.isAuth) {
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

  // Subscribe to the events channel
  useSocketChannel(Channel.EVENTS, enabled && !!id);

  // When this event is updated, invalidate
  useSocketEvent(
    ServerEvent.EVENT_UPDATED,
    (data) => {
      if (data.id === id) {
        queryClient.invalidateQueries({ queryKey: queryKeys.events.detail(id) });
      }
    },
    enabled && !!id,
  );

  return useQuery({
    queryKey: queryKeys.events.detail(id),
    queryFn: () => fetchEvent(id),
    enabled: enabled && !!id,
    refetchInterval: connected
      ? false
      : (query: { state: { data?: { data?: { status?: string } } } }) => {
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
            if (error instanceof ApiRequestError && (error.isAuth || error.status === 404)) {
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

  // Statistics are invalidated by useEvents' EVENT_CREATED/EVENT_UPDATED handlers.
  // Just disable polling when socket is connected.
  const refetchInterval = options.refetchInterval ?? (connected ? false : 30000);

  return useQuery({
    queryKey: queryKeys.events.statistics,
    queryFn: fetchEventStatistics,
    enabled,
    refetchInterval,
    staleTime: 20000,
    gcTime: 5 * 60 * 1000,
  });
}

export function useDeleteEvent() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => deleteEvent(id),
    onSuccess: (_, id) => {
      queryClient.removeQueries({ queryKey: queryKeys.events.detail(id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.events.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.events.statistics });
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
