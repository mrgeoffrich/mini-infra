import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useCallback } from "react";
import {
  ApiRoute,
  queryKeys,
  SystemSettingsInfo,
  SettingsListResponse,
  SettingResponse,
  SettingsDeleteResponse,
  CreateSettingRequest,
  UpdateSettingRequest,
  SettingsFilter,
  SettingsCategory,
  ValidationStatus,
  ConnectivityStatusInfo,
  ConnectivityStatusListResponse,
  ConnectivityStatusFilter,
  ConnectivityService,
  ConnectivityStatusType,
  ValidateServiceResponse,
  Channel,
  ServerEvent,
} from "@mini-infra/types";
import { useSocket, useSocketChannel, useSocketEvent } from "./use-socket";
import { apiFetch, ApiRequestError } from "@/lib/api-client";

function isAuthError(error: unknown): boolean {
  return error instanceof ApiRequestError && error.isAuth;
}

// ====================
// System Settings API Functions
// ====================

async function fetchSystemSettings(
  filters: SettingsFilter = {},
  page = 1,
  limit = 50,
): Promise<SettingsListResponse> {
  const url = new URL(ApiRoute.settings.list(), window.location.origin);

  // Add query parameters
  url.searchParams.set("page", page.toString());
  url.searchParams.set("limit", limit.toString());
  if (filters.category) url.searchParams.set("category", filters.category);
  if (filters.key) url.searchParams.set("key", filters.key);
  if (filters.isActive !== undefined)
    url.searchParams.set("isActive", filters.isActive.toString());
  if (filters.validationStatus)
    url.searchParams.set("validationStatus", filters.validationStatus);

  // Enveloped endpoint, but callers read the full `{ success, data }` shape
  // (matches `SettingsListResponse`, which also carries `pagination` as a
  // sibling of `data`) — preserve that contract with `unwrap: false`.
  const data = await apiFetch<SettingsListResponse>(url.pathname + url.search, {
    correlationIdPrefix: "settings",
    unwrap: false,
  });

  if (!data.success) {
    throw new Error(data.message || "Failed to fetch system settings");
  }

  return data;
}

async function fetchSystemSetting(id: string): Promise<SettingResponse> {
  const data = await apiFetch<SettingResponse>(ApiRoute.settings.get(id), {
    correlationIdPrefix: "settings",
    unwrap: false,
  });

  if (!data.success) {
    throw new Error(data.message || "Failed to fetch system setting");
  }

  return data;
}

async function createSystemSetting(
  setting: CreateSettingRequest,
): Promise<SettingResponse> {
  const data = await apiFetch<SettingResponse>(ApiRoute.settings.list(), {
    method: "POST",
    body: setting,
    correlationIdPrefix: "settings",
    unwrap: false,
  });

  if (!data.success) {
    throw new Error(data.message || "Failed to create system setting");
  }

  return data;
}

async function updateSystemSetting(
  id: string,
  setting: UpdateSettingRequest,
): Promise<SettingResponse> {
  const data = await apiFetch<SettingResponse>(ApiRoute.settings.get(id), {
    method: "PUT",
    body: setting,
    correlationIdPrefix: "settings",
    unwrap: false,
  });

  if (!data.success) {
    throw new Error(data.message || "Failed to update system setting");
  }

  return data;
}

async function deleteSystemSetting(id: string): Promise<SettingsDeleteResponse> {
  const data = await apiFetch<SettingsDeleteResponse>(ApiRoute.settings.get(id), {
    method: "DELETE",
    correlationIdPrefix: "settings",
    unwrap: false,
  });

  if (!data.success) {
    throw new Error(data.message || "Failed to delete system setting");
  }

  return data;
}

// ====================
// System Settings Hooks
// ====================

export interface UseSystemSettingsOptions {
  enabled?: boolean;
  filters?: SettingsFilter;
  page?: number;
  limit?: number;
  refetchInterval?: number;
  retry?: number | boolean | ((failureCount: number, error: Error) => boolean);
}

export function useSystemSettings(options: UseSystemSettingsOptions = {}) {
  const {
    enabled = true,
    filters = {},
    page = 1,
    limit = 50,
    refetchInterval,
    retry = 3,
  } = options;

  return useQuery({
    queryKey: [...queryKeys.settings.systemSettings, filters, page, limit],
    queryFn: () => fetchSystemSettings(filters, page, limit),
    enabled,
    refetchInterval,
    retry:
      typeof retry === "function"
        ? retry
        : (failureCount: number, error: Error) => {
            // Don't retry on authentication errors
            if (isAuthError(error)) {
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

export interface UseSystemSettingOptions {
  enabled?: boolean;
  retry?: number | boolean | ((failureCount: number, error: Error) => boolean);
}

export function useSystemSetting(
  id: string,
  options: UseSystemSettingOptions = {},
) {
  const { enabled = true, retry = 3 } = options;

  return useQuery({
    queryKey: queryKeys.settings.systemSetting(id),
    queryFn: () => fetchSystemSetting(id),
    enabled: enabled && !!id,
    retry:
      typeof retry === "function"
        ? retry
        : (failureCount: number, error: Error) => {
            // Don't retry on authentication errors
            if (isAuthError(error)) {
              return false;
            }
            // Retry up to the specified number of times for other errors
            return typeof retry === "boolean" ? retry : failureCount < retry;
          },
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),
    staleTime: 5000,
    gcTime: 5 * 60 * 1000,
  });
}

// Mutation hooks for CRUD operations
export function useCreateSystemSetting() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (setting: CreateSettingRequest) =>
      createSystemSetting(setting),
    onSuccess: () => {
      // Invalidate and refetch system settings
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.systemSettings });
    },
  });
}

export function useUpdateSystemSetting() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      id,
      setting,
    }: {
      id: string;
      setting: UpdateSettingRequest;
    }) => updateSystemSetting(id, setting),
    onSuccess: (_, variables) => {
      // Invalidate and refetch system settings
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.systemSettings });
      // Update the specific setting in cache
      queryClient.invalidateQueries({
        queryKey: queryKeys.settings.systemSetting(variables.id),
      });
    },
  });
}

export function useDeleteSystemSetting() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => deleteSystemSetting(id),
    onSuccess: (_, id) => {
      // Invalidate and refetch system settings
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.systemSettings });
      // Remove the specific setting from cache
      queryClient.removeQueries({ queryKey: queryKeys.settings.systemSetting(id) });
    },
  });
}

// ====================
// Settings Filter Hook
// ====================

export interface SettingsFiltersState {
  category?: SettingsCategory;
  isActive?: boolean;
  validationStatus?: ValidationStatus;
  page: number;
  limit: number;
}

export function useSettingsFilters(
  initialFilters: Partial<SettingsFiltersState> = {},
) {
  const [filters, setFilters] = useState<SettingsFiltersState>({
    page: 1,
    limit: 50,
    ...initialFilters,
  });

  const updateFilter = useCallback(
    <K extends keyof SettingsFiltersState>(
      key: K,
      value: SettingsFiltersState[K],
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

// ====================
// Settings Validation API Functions
// ====================

async function validateService(
  service: SettingsCategory,
  settings?: Record<string, string>,
): Promise<ValidateServiceResponse> {
  const data = await apiFetch<ValidateServiceResponse>(
    ApiRoute.settings.validate(service),
    {
      method: "POST",
      body: { settings },
      correlationIdPrefix: "settings",
      unwrap: false,
    },
  );

  if (!data.success) {
    throw new Error(data.message || `Failed to validate ${service}`);
  }

  return data;
}

// ====================
// Settings Validation Hooks
// ====================

export interface UseSettingsValidationOptions {
  enabled?: boolean;
  retry?: number | boolean | ((failureCount: number, error: Error) => boolean);
}

export function useSettingsValidation(
  service: SettingsCategory,
  settings?: Record<string, string>,
  options: UseSettingsValidationOptions = {},
) {
  const { enabled = true, retry = 1 } = options;

  return useQuery({
    queryKey: [...queryKeys.settings.validation, service, settings],
    queryFn: () => validateService(service, settings),
    enabled: enabled && !!service,
    retry:
      typeof retry === "function"
        ? retry
        : (failureCount: number, error: Error) => {
            // Don't retry on authentication errors
            if (isAuthError(error)) {
              return false;
            }
            // Limited retries for validation as it might be expensive
            return typeof retry === "boolean" ? retry : failureCount < retry;
          },
    retryDelay: (attemptIndex) => Math.min(2000 * 2 ** attemptIndex, 10000), // Longer delays for validation
    staleTime: 30000, // Validation results are fresh for 30 seconds
    gcTime: 2 * 60 * 1000, // Keep in cache for 2 minutes
    refetchOnWindowFocus: false, // Don't auto-revalidate on focus as it might be expensive
    refetchOnReconnect: true,
  });
}

export function useValidateService() {
  return useMutation({
    mutationFn: ({
      service,
      settings,
    }: {
      service: SettingsCategory;
      settings?: Record<string, string>;
    }) => validateService(service, settings),
  });
}

// ====================
// Connectivity Status API Functions
// ====================

async function fetchConnectivityStatus(
  filters: ConnectivityStatusFilter = {},
  page = 1,
  limit = 50,
): Promise<ConnectivityStatusListResponse> {
  const url = new URL(ApiRoute.settings.connectivity(), window.location.origin);

  // Add query parameters
  url.searchParams.set("page", page.toString());
  url.searchParams.set("limit", limit.toString());
  if (filters.service) url.searchParams.set("service", filters.service);
  if (filters.status) url.searchParams.set("status", filters.status);
  if (filters.checkInitiatedBy)
    url.searchParams.set("checkInitiatedBy", filters.checkInitiatedBy);
  if (filters.startDate)
    url.searchParams.set("startDate", filters.startDate.toISOString());
  if (filters.endDate)
    url.searchParams.set("endDate", filters.endDate.toISOString());

  // Enveloped endpoint, but callers read the full `{ success, data }` shape
  // (matches `ConnectivityStatusListResponse`, which also carries pagination
  // fields as siblings of `data`) — preserve that contract with `unwrap: false`.
  const data = await apiFetch<ConnectivityStatusListResponse>(
    url.pathname + url.search,
    { correlationIdPrefix: "settings", unwrap: false },
  );

  if (!data.success) {
    throw new Error(data.message || "Failed to fetch connectivity status");
  }

  return data;
}

// ====================
// Connectivity Status Hooks
// ====================

export interface UseConnectivityStatusOptions {
  enabled?: boolean;
  filters?: ConnectivityStatusFilter;
  page?: number;
  limit?: number;
  refetchInterval?: number;
  retry?: number | boolean | ((failureCount: number, error: Error) => boolean);
}

export function useConnectivityStatus(
  options: UseConnectivityStatusOptions = {},
) {
  const {
    enabled = true,
    filters = {},
    page = 1,
    limit = 50,
    refetchInterval: customRefetchInterval,
    retry = 3,
  } = options;

  const queryClient = useQueryClient();
  const { connected } = useSocket();

  // No polling when socket is connected (real-time updates via socket events);
  // fall back to 30s polling when disconnected
  const refetchInterval = customRefetchInterval ?? (connected ? false : 30000);

  // Subscribe to connectivity channel for real-time updates
  useSocketChannel(Channel.CONNECTIVITY, enabled);

  // Invalidate query when server pushes new connectivity data
  useSocketEvent(
    ServerEvent.CONNECTIVITY_ALL,
    () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.connectivity.status });
    },
    enabled,
  );

  return useQuery({
    queryKey: [...queryKeys.connectivity.status, filters, page, limit],
    queryFn: () => fetchConnectivityStatus(filters, page, limit),
    enabled,
    refetchInterval,
    retry:
      typeof retry === "function"
        ? retry
        : (failureCount: number, error: Error) => {
            // Don't retry on authentication errors
            if (isAuthError(error)) {
              return false;
            }
            // Retry up to the specified number of times for other errors
            return typeof retry === "boolean" ? retry : failureCount < retry;
          },
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),
    staleTime: 10000, // Data is fresh for 10 seconds
    gcTime: 5 * 60 * 1000, // Keep in cache for 5 minutes
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

// ====================
// Connectivity Filter Hook
// ====================

export interface ConnectivityFiltersState {
  service?: ConnectivityService;
  status?: ConnectivityStatusType;
  checkInitiatedBy?: string;
  startDate?: Date;
  endDate?: Date;
  page: number;
  limit: number;
}

export function useConnectivityFilters(
  initialFilters: Partial<ConnectivityFiltersState> = {},
) {
  const [filters, setFilters] = useState<ConnectivityFiltersState>({
    page: 1,
    limit: 50,
    ...initialFilters,
  });

  const updateFilter = useCallback(
    <K extends keyof ConnectivityFiltersState>(
      key: K,
      value: ConnectivityFiltersState[K],
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

// ====================
// Type Exports
// ====================

export type {
  SystemSettingsInfo,
  SettingsListResponse,
  SettingResponse,
  SettingsDeleteResponse,
  CreateSettingRequest,
  UpdateSettingRequest,
  SettingsFilter,
  SettingsCategory,
  ValidationStatus,
  ConnectivityStatusInfo,
  ConnectivityStatusListResponse,
  ConnectivityStatusFilter,
  ConnectivityService,
  ConnectivityStatusType,
  ValidateServiceResponse,
};
