import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useCallback, useEffect, useRef } from "react";
import {
  ApiRoute,
  queryKeys,
  ConnectivityStatusInfo,
  ConnectivityStatusListResponse,
  ConnectivityStatusFilter,
  ConnectivityService,
  ConnectivityStatusType,
  SettingsCategory,
  ValidateServiceResponse,
  ValidationResult,
} from "@mini-infra/types";
import { apiFetch, ApiRequestError } from "@/lib/api-client";

function isAuthError(error: unknown): boolean {
  return error instanceof ApiRequestError && error.isAuth;
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
    { correlationIdPrefix: "validation", unwrap: false },
  );

  if (!data.success) {
    throw new Error(data.message || "Failed to fetch connectivity status");
  }

  return data;
}

async function validateService(
  service: SettingsCategory,
  settings?: Record<string, string>,
): Promise<ValidateServiceResponse> {
  const data = await apiFetch<ValidateServiceResponse>(
    ApiRoute.settings.validate(service),
    {
      method: "POST",
      body: { settings },
      correlationIdPrefix: "validation",
      unwrap: false,
    },
  );

  if (!data.success) {
    throw new Error(data.message || `Failed to validate ${service}`);
  }

  return data;
}

// ====================
// Connectivity Status Hook
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
    refetchInterval = 30000, // 30 seconds for real-time monitoring
    retry = 3,
  } = options;

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
// Settings Validator Hook with Debouncing
// ====================

export interface UseSettingsValidatorOptions {
  enabled?: boolean;
  debounceDelay?: number;
  retry?: number | boolean | ((failureCount: number, error: Error) => boolean);
}

export function useSettingsValidator(
  service: SettingsCategory,
  settings: Record<string, string> | undefined,
  options: UseSettingsValidatorOptions = {},
) {
  const { enabled = true, debounceDelay = 500, retry = 1 } = options;

  const [debouncedSettings, setDebouncedSettings] = useState(settings);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Debounce settings changes
  useEffect(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }

    timeoutRef.current = setTimeout(() => {
      setDebouncedSettings(settings);
    }, debounceDelay);

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [settings, debounceDelay]);

  return useQuery({
    queryKey: [...queryKeys.settings.validator(service), debouncedSettings],
    queryFn: () => validateService(service, debouncedSettings),
    enabled: enabled && !!service && !!debouncedSettings,
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

// ====================
// Manual Service Validation Hook
// ====================

export interface UseValidateServiceOptions {
  onSuccess?: (data: ValidateServiceResponse) => void;
  onError?: (error: Error) => void;
}

export function useValidateService(options: UseValidateServiceOptions = {}) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      service,
      settings,
    }: {
      service: SettingsCategory;
      settings?: Record<string, string>;
    }) => validateService(service, settings),
    onSuccess: (data, variables) => {
      // Invalidate connectivity status to get fresh data
      queryClient.invalidateQueries({ queryKey: queryKeys.connectivity.status });
      // Update validator cache with fresh result
      queryClient.setQueryData(
        [...queryKeys.settings.validator(variables.service), variables.settings],
        data,
      );
      // Call success callback if provided
      options.onSuccess?.(data);
    },
    onError: (error) => {
      // Call error callback if provided
      options.onError?.(error as Error);
    },
  });
}

// ====================
// Real-time Polling Hook for Specific Service
// ====================

export interface UseServiceConnectivityOptions {
  enabled?: boolean;
  pollingInterval?: number;
  retry?: number | boolean | ((failureCount: number, error: Error) => boolean);
}

export function useServiceConnectivity(
  service: ConnectivityService,
  options: UseServiceConnectivityOptions = {},
) {
  const {
    enabled = true,
    pollingInterval = 30000, // 30 seconds
    retry = 3,
  } = options;

  const filters: ConnectivityStatusFilter = { service };

  return useConnectivityStatus({
    enabled,
    filters,
    limit: 10, // Get recent status entries for this service
    refetchInterval: pollingInterval,
    retry,
  });
}

// ====================
// Optimistic Updates Hook
// ====================

export interface OptimisticValidationState {
  isValidating: boolean;
  lastValidation?: {
    service: SettingsCategory;
    settings: Record<string, string>;
    result: ValidationResult;
    timestamp: Date;
  };
}

export function useOptimisticValidation() {
  const [state, setState] = useState<OptimisticValidationState>({
    isValidating: false,
  });
  const queryClient = useQueryClient();

  const startValidation = useCallback(
    (service: SettingsCategory, settings: Record<string, string>) => {
      setState((prev) => ({
        ...prev,
        isValidating: true,
      }));

      // Optimistically update the cache with pending status
      const optimisticResult: ValidateServiceResponse = {
        success: true,
        data: {
          service,
          isValid: false, // Assume invalid until validated
          responseTimeMs: 0,
          validatedAt: new Date().toISOString(),
        },
        message: "Validating...",
        timestamp: new Date().toISOString(),
      };

      queryClient.setQueryData(
        [...queryKeys.settings.validator(service), settings],
        optimisticResult,
      );
    },
    [queryClient],
  );

  const finishValidation = useCallback(
    (
      service: SettingsCategory,
      settings: Record<string, string>,
      result: ValidationResult,
    ) => {
      setState({
        isValidating: false,
        lastValidation: {
          service,
          settings,
          result,
          timestamp: new Date(),
        },
      });
    },
    [],
  );

  return {
    state,
    startValidation,
    finishValidation,
  };
}

// ====================
// Error Recovery Hook
// ====================

export interface UseValidationRecoveryOptions {
  maxRetries?: number;
  retryDelay?: number;
  onMaxRetriesExceeded?: (service: SettingsCategory, error: Error) => void;
}

export function useValidationRecovery(
  options: UseValidationRecoveryOptions = {},
) {
  const { maxRetries = 3, retryDelay = 1000, onMaxRetriesExceeded } = options;

  const [retryCount, setRetryCount] = useState<Record<string, number>>({});
  const [isRecovering, setIsRecovering] = useState<Record<string, boolean>>({});
  const timeoutsRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const retryValidationRef = useRef<
    (
      service: SettingsCategory,
      settings: Record<string, string>,
      validationFn: () => Promise<void>,
      error: Error,
    ) => boolean
  >(() => false);

  const retryValidation = useCallback(
    (
      service: SettingsCategory,
      settings: Record<string, string>,
      validationFn: () => Promise<void>,
      error: Error,
    ) => {
      const key = `${service}-${JSON.stringify(settings)}`;
      const currentRetries = retryCount[key] || 0;

      if (currentRetries >= maxRetries) {
        onMaxRetriesExceeded?.(service, error);
        return false;
      }

      setIsRecovering((prev) => ({ ...prev, [key]: true }));
      setRetryCount((prev) => ({ ...prev, [key]: currentRetries + 1 }));

      // Clear existing timeout
      if (timeoutsRef.current[key]) {
        clearTimeout(timeoutsRef.current[key]);
      }

      // Exponential backoff
      const delay = retryDelay * Math.pow(2, currentRetries);

      timeoutsRef.current[key] = setTimeout(async () => {
        try {
          await validationFn();
          // Reset retry count on success
          setRetryCount((prev) => ({ ...prev, [key]: 0 }));
        } catch (retryError) {
          // Recursive retry if still under max retries — go through ref so
          // the callback identity is stable and lint stays happy.
          retryValidationRef.current(
            service,
            settings,
            validationFn,
            retryError as Error,
          );
        } finally {
          setIsRecovering((prev) => ({ ...prev, [key]: false }));
        }
      }, delay);

      return true;
    },
    [retryCount, maxRetries, retryDelay, onMaxRetriesExceeded],
  );

  useEffect(() => {
    retryValidationRef.current = retryValidation;
  }, [retryValidation]);

  const resetRetries = useCallback((service?: SettingsCategory) => {
    if (service) {
      setRetryCount((prev) => {
        const newCount = { ...prev };
        Object.keys(newCount).forEach((key) => {
          if (key.startsWith(service)) {
            delete newCount[key];
          }
        });
        return newCount;
      });
      setIsRecovering((prev) => {
        const newState = { ...prev };
        Object.keys(newState).forEach((key) => {
          if (key.startsWith(service)) {
            delete newState[key];
          }
        });
        return newState;
      });
    } else {
      setRetryCount({});
      setIsRecovering({});
    }
  }, []);

  // Cleanup timeouts on unmount
  useEffect(() => {
    const timeouts = timeoutsRef.current;
    return () => {
      Object.values(timeouts).forEach(clearTimeout);
    };
  }, []);

  return {
    retryValidation,
    resetRetries,
    retryCount,
    isRecovering,
  };
}

// ====================
// Combined Validation Hook
// ====================

export interface UseAdvancedSettingsValidationOptions {
  enabled?: boolean;
  debounceDelay?: number;
  pollingInterval?: number;
  maxRetries?: number;
  onValidationSuccess?: (
    service: SettingsCategory,
    result: ValidationResult,
  ) => void;
  onValidationError?: (service: SettingsCategory, error: Error) => void;
  onMaxRetriesExceeded?: (service: SettingsCategory, error: Error) => void;
}

export function useAdvancedSettingsValidation(
  service: SettingsCategory,
  settings: Record<string, string> | undefined,
  options: UseAdvancedSettingsValidationOptions = {},
) {
  const {
    enabled = true,
    debounceDelay = 500,
    pollingInterval = 30000,
    maxRetries = 3,
    onValidationSuccess,
    onValidationError,
    onMaxRetriesExceeded,
  } = options;

  // Individual hooks
  const validator = useSettingsValidator(service, settings, {
    enabled,
    debounceDelay,
    retry: false, // Handle retries manually
  });

  const connectivity = useServiceConnectivity(service as ConnectivityService, {
    enabled,
    pollingInterval,
  });

  const validateService = useValidateService({
    onSuccess: (data) => {
      if (data.data.isValid) {
        onValidationSuccess?.(service, {
          isValid: true,
          message: data.message,
          responseTimeMs: data.data.responseTimeMs,
          metadata: data.data.metadata,
        });
      }
    },
    onError: (error) => {
      onValidationError?.(service, error);
    },
  });

  const recovery = useValidationRecovery({
    maxRetries,
    onMaxRetriesExceeded,
  });

  const optimistic = useOptimisticValidation();

  // Manual validation with retry logic. Uses a ref to break the recursive
  // reference so the compiler doesn't see the callback reading itself before
  // it's declared.
  const validateWithRetryRef = useRef<
    | ((
        serviceToValidate: SettingsCategory,
        settingsToValidate: Record<string, string>,
      ) => Promise<void>)
    | null
  >(null);

  const validateWithRetry = useCallback(
    async (
      serviceToValidate: SettingsCategory,
      settingsToValidate: Record<string, string>,
    ) => {
      optimistic.startValidation(serviceToValidate, settingsToValidate);

      try {
        const result = await validateService.mutateAsync({
          service: serviceToValidate,
          settings: settingsToValidate,
        });

        optimistic.finishValidation(serviceToValidate, settingsToValidate, {
          isValid: result.data.isValid,
          message: result.message,
          responseTimeMs: result.data.responseTimeMs,
          metadata: result.data.metadata,
        });

        recovery.resetRetries(serviceToValidate);
      } catch (error) {
        const shouldRetry = recovery.retryValidation(
          serviceToValidate,
          settingsToValidate,
          () =>
            validateWithRetryRef.current?.(
              serviceToValidate,
              settingsToValidate,
            ) ?? Promise.resolve(),
          error as Error,
        );

        if (!shouldRetry) {
          optimistic.finishValidation(serviceToValidate, settingsToValidate, {
            isValid: false,
            message: (error as Error).message,
          });
        }
      }
    },
    [validateService, optimistic, recovery],
  );

  // Keep the ref pointing at the latest implementation for recursive calls.
  useEffect(() => {
    validateWithRetryRef.current = validateWithRetry;
  }, [validateWithRetry]);

  return {
    // Validation state
    validation: validator,
    connectivity,
    isValidating: optimistic.state.isValidating || validateService.isPending,
    lastValidation: optimistic.state.lastValidation,

    // Actions
    validateManually: () => {
      if (settings) {
        validateWithRetry(service, settings);
      }
    },
    resetRetries: () => recovery.resetRetries(service),

    // Recovery state
    retryCount: recovery.retryCount,
    isRecovering: recovery.isRecovering,

    // Error state
    error: validator.error || validateService.error,
    hasError: validator.isError || validateService.isError,
  };
}

// ====================
// Type Exports
// ====================

export type {
  ConnectivityStatusInfo,
  ConnectivityStatusListResponse,
  ConnectivityStatusFilter,
  ConnectivityService,
  ConnectivityStatusType,
  ValidateServiceResponse,
  ValidationResult,
};
