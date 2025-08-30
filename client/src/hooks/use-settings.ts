import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useCallback } from "react";
import {
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
} from "@mini-infra/types";

// Generate correlation ID for debugging
function generateCorrelationId(): string {
  return `settings-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// ====================
// System Settings API Functions
// ====================

async function fetchSystemSettings(
  filters: SettingsFilter = {},
  page = 1,
  limit = 50,
  correlationId: string,
): Promise<SettingsListResponse> {
  const url = new URL(`/api/settings`, window.location.origin);

  // Add query parameters
  url.searchParams.set("page", page.toString());
  url.searchParams.set("limit", limit.toString());
  if (filters.category) url.searchParams.set("category", filters.category);
  if (filters.isActive !== undefined)
    url.searchParams.set("isActive", filters.isActive.toString());
  if (filters.validationStatus)
    url.searchParams.set("validationStatus", filters.validationStatus);

  const response = await fetch(url.toString(), {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch system settings: ${response.statusText}`);
  }

  const data: SettingsListResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to fetch system settings");
  }

  return data;
}

async function fetchSystemSetting(
  id: string,
  correlationId: string,
): Promise<SettingResponse> {
  const response = await fetch(`/api/settings/${id}`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch system setting: ${response.statusText}`);
  }

  const data: SettingResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to fetch system setting");
  }

  return data;
}

async function createSystemSetting(
  setting: CreateSettingRequest,
  correlationId: string,
): Promise<SettingResponse> {
  const response = await fetch(`/api/settings`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
    body: JSON.stringify(setting),
  });

  if (!response.ok) {
    throw new Error(`Failed to create system setting: ${response.statusText}`);
  }

  const data: SettingResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to create system setting");
  }

  return data;
}

async function updateSystemSetting(
  id: string,
  setting: UpdateSettingRequest,
  correlationId: string,
): Promise<SettingResponse> {
  const response = await fetch(`/api/settings/${id}`, {
    method: "PUT",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
    body: JSON.stringify(setting),
  });

  if (!response.ok) {
    throw new Error(`Failed to update system setting: ${response.statusText}`);
  }

  const data: SettingResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to update system setting");
  }

  return data;
}

async function deleteSystemSetting(
  id: string,
  correlationId: string,
): Promise<SettingsDeleteResponse> {
  const response = await fetch(`/api/settings/${id}`, {
    method: "DELETE",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to delete system setting: ${response.statusText}`);
  }

  const data: SettingsDeleteResponse = await response.json();

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

  const correlationId = generateCorrelationId();

  return useQuery({
    queryKey: ["systemSettings", filters, page, limit],
    queryFn: () => fetchSystemSettings(filters, page, limit, correlationId),
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
  const correlationId = generateCorrelationId();

  return useQuery({
    queryKey: ["systemSetting", id],
    queryFn: () => fetchSystemSetting(id, correlationId),
    enabled: enabled && !!id,
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
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),
    staleTime: 5000,
    gcTime: 5 * 60 * 1000,
  });
}

// Mutation hooks for CRUD operations
export function useCreateSystemSetting() {
  const queryClient = useQueryClient();
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: (setting: CreateSettingRequest) =>
      createSystemSetting(setting, correlationId),
    onSuccess: () => {
      // Invalidate and refetch system settings
      queryClient.invalidateQueries({ queryKey: ["systemSettings"] });
    },
  });
}

export function useUpdateSystemSetting() {
  const queryClient = useQueryClient();
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: ({
      id,
      setting,
    }: {
      id: string;
      setting: UpdateSettingRequest;
    }) => updateSystemSetting(id, setting, correlationId),
    onSuccess: (_, variables) => {
      // Invalidate and refetch system settings
      queryClient.invalidateQueries({ queryKey: ["systemSettings"] });
      // Update the specific setting in cache
      queryClient.invalidateQueries({
        queryKey: ["systemSetting", variables.id],
      });
    },
  });
}

export function useDeleteSystemSetting() {
  const queryClient = useQueryClient();
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: (id: string) => deleteSystemSetting(id, correlationId),
    onSuccess: (_, id) => {
      // Invalidate and refetch system settings
      queryClient.invalidateQueries({ queryKey: ["systemSettings"] });
      // Remove the specific setting from cache
      queryClient.removeQueries({ queryKey: ["systemSetting", id] });
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
  correlationId?: string,
): Promise<ValidateServiceResponse> {
  const response = await fetch(`/api/settings/validate/${service}`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(correlationId && { "X-Correlation-ID": correlationId }),
    },
    body: JSON.stringify({ settings }),
  });

  if (!response.ok) {
    throw new Error(`Failed to validate ${service}: ${response.statusText}`);
  }

  const data: ValidateServiceResponse = await response.json();

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
  const correlationId = generateCorrelationId();

  return useQuery({
    queryKey: ["settingsValidation", service, settings],
    queryFn: () => validateService(service, settings, correlationId),
    enabled: enabled && !!service,
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
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: ({
      service,
      settings,
    }: {
      service: SettingsCategory;
      settings?: Record<string, string>;
    }) => validateService(service, settings, correlationId),
  });
}


// ====================
// Connectivity Status API Functions
// ====================

async function fetchConnectivityStatus(
  filters: ConnectivityStatusFilter = {},
  page = 1,
  limit = 50,
  correlationId: string,
): Promise<ConnectivityStatusListResponse> {
  const url = new URL(`/api/settings/connectivity`, window.location.origin);

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

  const response = await fetch(url.toString(), {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch connectivity status: ${response.statusText}`,
    );
  }

  const data: ConnectivityStatusListResponse = await response.json();

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
    refetchInterval = 30000, // 30 seconds for connectivity status
    retry = 3,
  } = options;

  const correlationId = generateCorrelationId();

  return useQuery({
    queryKey: ["connectivityStatus", filters, page, limit],
    queryFn: () => fetchConnectivityStatus(filters, page, limit, correlationId),
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
