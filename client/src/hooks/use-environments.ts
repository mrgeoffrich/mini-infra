import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useCallback } from "react";
import {
  Environment,
  EnvironmentType,
  CreateEnvironmentRequest,
  UpdateEnvironmentRequest,
  AddServiceToEnvironmentRequest,
  EnvironmentStatusResponse,
  EnvironmentOperationResult,
  AvailableServicesResponse,
  ServiceTypeMetadata,
  ListEnvironmentsResponse,
  ServiceStatus,
  EnvironmentNetwork,
  EnvironmentVolume,
  CreateNetworkRequest,
  UpdateNetworkRequest,
  NetworksResponse,
  CreateVolumeRequest,
  UpdateVolumeRequest,
  VolumesResponse,
} from "@mini-infra/types";

// Generate correlation ID for debugging
function generateCorrelationId(): string {
  return `environments-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// ====================
// Environment API Functions
// ====================

async function fetchEnvironments(
  filters: {
    type?: EnvironmentType;
    status?: ServiceStatus;
    page?: number;
    limit?: number;
  } = {},
  correlationId: string,
): Promise<ListEnvironmentsResponse> {
  const url = new URL(`/api/environments`, window.location.origin);

  // Add query parameters
  if (filters.type) url.searchParams.set("type", filters.type);
  if (filters.status) url.searchParams.set("status", filters.status);
  if (filters.page) url.searchParams.set("page", filters.page.toString());
  if (filters.limit) url.searchParams.set("limit", filters.limit.toString());

  const response = await fetch(url.toString(), {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch environments: ${response.statusText}`);
  }

  return await response.json();
}

async function fetchEnvironment(
  id: string,
  correlationId: string,
): Promise<Environment> {
  const response = await fetch(`/api/environments/${id}`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch environment: ${response.statusText}`);
  }

  return await response.json();
}

async function createEnvironment(
  request: CreateEnvironmentRequest,
  correlationId: string,
): Promise<Environment> {
  const response = await fetch(`/api/environments`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(`Failed to create environment: ${response.statusText}`);
  }

  return await response.json();
}

async function updateEnvironment(
  id: string,
  request: UpdateEnvironmentRequest,
  correlationId: string,
): Promise<Environment> {
  const response = await fetch(`/api/environments/${id}`, {
    method: "PUT",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(`Failed to update environment: ${response.statusText}`);
  }

  return await response.json();
}

async function deleteEnvironment(
  options: { id: string; deleteVolumes?: boolean; deleteNetworks?: boolean },
  correlationId: string,
): Promise<void> {
  const { id, deleteVolumes = false, deleteNetworks = false } = options;
  const url = new URL(`/api/environments/${id}`, window.location.origin);

  // Add query parameters for deletion options
  if (deleteVolumes) url.searchParams.set("deleteVolumes", "true");
  if (deleteNetworks) url.searchParams.set("deleteNetworks", "true");

  const response = await fetch(url.toString(), {
    method: "DELETE",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to delete environment: ${response.statusText}`);
  }
}

async function fetchEnvironmentStatus(
  id: string,
  correlationId: string,
): Promise<EnvironmentStatusResponse> {
  const response = await fetch(`/api/environments/${id}/status`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch environment status: ${response.statusText}`);
  }

  return await response.json();
}

async function startEnvironment(
  id: string,
  correlationId: string,
): Promise<EnvironmentOperationResult> {
  const response = await fetch(`/api/environments/${id}/start`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to start environment: ${response.statusText}`);
  }

  return await response.json();
}

async function stopEnvironment(
  id: string,
  correlationId: string,
): Promise<EnvironmentOperationResult> {
  const response = await fetch(`/api/environments/${id}/stop`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to stop environment: ${response.statusText}`);
  }

  return await response.json();
}

async function addServiceToEnvironment(
  environmentId: string,
  request: AddServiceToEnvironmentRequest,
  correlationId: string,
): Promise<Environment> {
  const response = await fetch(`/api/environments/${environmentId}/services`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(`Failed to add service to environment: ${response.statusText}`);
  }

  return await response.json();
}

async function fetchAvailableServices(
  correlationId: string,
): Promise<AvailableServicesResponse> {
  const response = await fetch(`/api/environments/services/available`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch available services: ${response.statusText}`);
  }

  return await response.json();
}

async function fetchServiceTypeMetadata(
  serviceType: string,
  correlationId: string,
): Promise<ServiceTypeMetadata> {
  const response = await fetch(`/api/environments/services/available/${serviceType}`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch service type metadata: ${response.statusText}`);
  }

  return await response.json();
}

// ====================
// Network API Functions
// ====================

async function fetchEnvironmentNetworks(
  environmentId: string,
  correlationId: string,
): Promise<NetworksResponse> {
  const response = await fetch(`/api/environments/${environmentId}/networks`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch environment networks: ${response.statusText}`);
  }

  return await response.json();
}

async function createEnvironmentNetwork(
  environmentId: string,
  request: CreateNetworkRequest,
  correlationId: string,
): Promise<EnvironmentNetwork> {
  const response = await fetch(`/api/environments/${environmentId}/networks`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(`Failed to create network: ${response.statusText}`);
  }

  return await response.json();
}

async function updateEnvironmentNetwork(
  environmentId: string,
  networkId: string,
  request: UpdateNetworkRequest,
  correlationId: string,
): Promise<EnvironmentNetwork> {
  const response = await fetch(`/api/environments/${environmentId}/networks/${networkId}`, {
    method: "PUT",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(`Failed to update network: ${response.statusText}`);
  }

  return await response.json();
}

async function deleteEnvironmentNetwork(
  environmentId: string,
  networkId: string,
  correlationId: string,
): Promise<void> {
  const response = await fetch(`/api/environments/${environmentId}/networks/${networkId}`, {
    method: "DELETE",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to delete network: ${response.statusText}`);
  }
}

// ====================
// Volume API Functions
// ====================

async function fetchEnvironmentVolumes(
  environmentId: string,
  correlationId: string,
): Promise<VolumesResponse> {
  const response = await fetch(`/api/environments/${environmentId}/volumes`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch environment volumes: ${response.statusText}`);
  }

  return await response.json();
}

async function createEnvironmentVolume(
  environmentId: string,
  request: CreateVolumeRequest,
  correlationId: string,
): Promise<EnvironmentVolume> {
  const response = await fetch(`/api/environments/${environmentId}/volumes`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(`Failed to create volume: ${response.statusText}`);
  }

  return await response.json();
}

async function updateEnvironmentVolume(
  environmentId: string,
  volumeId: string,
  request: UpdateVolumeRequest,
  correlationId: string,
): Promise<EnvironmentVolume> {
  const response = await fetch(`/api/environments/${environmentId}/volumes/${volumeId}`, {
    method: "PUT",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(`Failed to update volume: ${response.statusText}`);
  }

  return await response.json();
}

async function deleteEnvironmentVolume(
  environmentId: string,
  volumeId: string,
  correlationId: string,
): Promise<void> {
  const response = await fetch(`/api/environments/${environmentId}/volumes/${volumeId}`, {
    method: "DELETE",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to delete volume: ${response.statusText}`);
  }
}

// ====================
// Environment Hooks
// ====================

export interface UseEnvironmentsOptions {
  enabled?: boolean;
  refetchInterval?: number;
  retry?: number | boolean | ((failureCount: number, error: Error) => boolean);
  filters?: {
    type?: EnvironmentType;
    status?: ServiceStatus;
    page?: number;
    limit?: number;
  };
}

export function useEnvironments(options: UseEnvironmentsOptions = {}) {
  const {
    enabled = true,
    refetchInterval,
    retry = 3,
    filters = {},
  } = options;

  const correlationId = generateCorrelationId();

  return useQuery({
    queryKey: ["environments", filters],
    queryFn: () => fetchEnvironments(filters, correlationId),
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
            return typeof retry === "boolean" ? retry : failureCount < retry;
          },
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),
    staleTime: 10000, // Data is fresh for 10 seconds
    gcTime: 5 * 60 * 1000, // Keep in cache for 5 minutes
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

export interface UseEnvironmentOptions {
  enabled?: boolean;
  refetchInterval?: number;
  retry?: number | boolean | ((failureCount: number, error: Error) => boolean);
}

export function useEnvironment(
  id: string,
  options: UseEnvironmentOptions = {},
) {
  const { enabled = true, refetchInterval, retry = 3 } = options;

  const correlationId = generateCorrelationId();

  return useQuery({
    queryKey: ["environment", id],
    queryFn: () => fetchEnvironment(id, correlationId),
    enabled: enabled && !!id,
    refetchInterval,
    retry:
      typeof retry === "function"
        ? retry
        : (failureCount: number, error: Error) => {
            if (
              error.message.includes("401") ||
              error.message.includes("Unauthorized") ||
              error.message.includes("404") ||
              error.message.includes("Not found")
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

export function useEnvironmentStatus(
  id: string,
  options: UseEnvironmentOptions = {},
) {
  const { enabled = true, refetchInterval = 5000, retry = 3 } = options;

  const correlationId = generateCorrelationId();

  return useQuery({
    queryKey: ["environmentStatus", id],
    queryFn: () => fetchEnvironmentStatus(id, correlationId),
    enabled: enabled && !!id,
    refetchInterval,
    retry:
      typeof retry === "function"
        ? retry
        : (failureCount: number, error: Error) => {
            if (
              error.message.includes("401") ||
              error.message.includes("Unauthorized") ||
              error.message.includes("404") ||
              error.message.includes("Not found")
            ) {
              return false;
            }
            return typeof retry === "boolean" ? retry : failureCount < retry;
          },
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),
    staleTime: 2000, // Status data is fresh for 2 seconds
    gcTime: 2 * 60 * 1000, // Keep in cache for 2 minutes
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

export function useAvailableServices(options: UseEnvironmentOptions = {}) {
  const { enabled = true, retry = 3 } = options;

  const correlationId = generateCorrelationId();

  return useQuery({
    queryKey: ["availableServices"],
    queryFn: () => fetchAvailableServices(correlationId),
    enabled,
    retry:
      typeof retry === "function"
        ? retry
        : (failureCount: number, error: Error) => {
            if (
              error.message.includes("401") ||
              error.message.includes("Unauthorized")
            ) {
              return false;
            }
            return typeof retry === "boolean" ? retry : failureCount < retry;
          },
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),
    staleTime: 60000, // Service types are stable for 1 minute
    gcTime: 10 * 60 * 1000, // Keep in cache for 10 minutes
  });
}

export function useServiceTypeMetadata(
  serviceType: string,
  options: UseEnvironmentOptions = {},
) {
  const { enabled = true, retry = 3 } = options;

  const correlationId = generateCorrelationId();

  return useQuery({
    queryKey: ["serviceTypeMetadata", serviceType],
    queryFn: () => fetchServiceTypeMetadata(serviceType, correlationId),
    enabled: enabled && !!serviceType,
    retry:
      typeof retry === "function"
        ? retry
        : (failureCount: number, error: Error) => {
            if (
              error.message.includes("401") ||
              error.message.includes("Unauthorized") ||
              error.message.includes("404") ||
              error.message.includes("Not found")
            ) {
              return false;
            }
            return typeof retry === "boolean" ? retry : failureCount < retry;
          },
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),
    staleTime: 300000, // Service metadata is stable for 5 minutes
    gcTime: 10 * 60 * 1000, // Keep in cache for 10 minutes
  });
}

// Mutation hooks
export function useCreateEnvironment() {
  const queryClient = useQueryClient();
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: (request: CreateEnvironmentRequest) =>
      createEnvironment(request, correlationId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["environments"] });
    },
  });
}

export function useUpdateEnvironment() {
  const queryClient = useQueryClient();
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: ({
      id,
      request,
    }: {
      id: string;
      request: UpdateEnvironmentRequest;
    }) => updateEnvironment(id, request, correlationId),
    onSuccess: (_, { id }) => {
      queryClient.invalidateQueries({ queryKey: ["environments"] });
      queryClient.invalidateQueries({ queryKey: ["environment", id] });
      queryClient.invalidateQueries({ queryKey: ["environmentStatus", id] });
    },
  });
}

export function useDeleteEnvironment() {
  const queryClient = useQueryClient();
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: (options: { id: string; deleteVolumes?: boolean; deleteNetworks?: boolean }) =>
      deleteEnvironment(options, correlationId),
    onSuccess: (_, options) => {
      queryClient.invalidateQueries({ queryKey: ["environments"] });
      queryClient.removeQueries({ queryKey: ["environment", options.id] });
      queryClient.removeQueries({ queryKey: ["environmentStatus", options.id] });
    },
  });
}

export function useStartEnvironment() {
  const queryClient = useQueryClient();
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: (id: string) => startEnvironment(id, correlationId),
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: ["environments"] });
      queryClient.invalidateQueries({ queryKey: ["environment", id] });
      queryClient.invalidateQueries({ queryKey: ["environmentStatus", id] });
    },
  });
}

export function useStopEnvironment() {
  const queryClient = useQueryClient();
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: (id: string) => stopEnvironment(id, correlationId),
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: ["environments"] });
      queryClient.invalidateQueries({ queryKey: ["environment", id] });
      queryClient.invalidateQueries({ queryKey: ["environmentStatus", id] });
    },
  });
}

export function useAddServiceToEnvironment() {
  const queryClient = useQueryClient();
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: ({
      environmentId,
      request,
    }: {
      environmentId: string;
      request: AddServiceToEnvironmentRequest;
    }) => addServiceToEnvironment(environmentId, request, correlationId),
    onSuccess: (_, { environmentId }) => {
      queryClient.invalidateQueries({ queryKey: ["environments"] });
      queryClient.invalidateQueries({ queryKey: ["environment", environmentId] });
      queryClient.invalidateQueries({ queryKey: ["environmentStatus", environmentId] });
    },
  });
}

// ====================
// Network Hooks
// ====================

export function useEnvironmentNetworks(
  environmentId: string,
  options: UseEnvironmentOptions = {},
) {
  const { enabled = true, refetchInterval, retry = 3 } = options;
  const correlationId = generateCorrelationId();

  return useQuery({
    queryKey: ["environmentNetworks", environmentId],
    queryFn: () => fetchEnvironmentNetworks(environmentId, correlationId),
    enabled: enabled && !!environmentId,
    refetchInterval,
    retry:
      typeof retry === "function"
        ? retry
        : (failureCount: number, error: Error) => {
            if (
              error.message.includes("401") ||
              error.message.includes("Unauthorized") ||
              error.message.includes("404") ||
              error.message.includes("Not found")
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

export function useCreateEnvironmentNetwork() {
  const queryClient = useQueryClient();
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: ({
      environmentId,
      request,
    }: {
      environmentId: string;
      request: CreateNetworkRequest;
    }) => createEnvironmentNetwork(environmentId, request, correlationId),
    onSuccess: (_, { environmentId }) => {
      queryClient.invalidateQueries({ queryKey: ["environments"] });
      queryClient.invalidateQueries({ queryKey: ["environment", environmentId] });
      queryClient.invalidateQueries({ queryKey: ["environmentNetworks", environmentId] });
      queryClient.invalidateQueries({ queryKey: ["environmentStatus", environmentId] });
    },
  });
}

export function useUpdateEnvironmentNetwork() {
  const queryClient = useQueryClient();
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: ({
      environmentId,
      networkId,
      request,
    }: {
      environmentId: string;
      networkId: string;
      request: UpdateNetworkRequest;
    }) => updateEnvironmentNetwork(environmentId, networkId, request, correlationId),
    onSuccess: (_, { environmentId }) => {
      queryClient.invalidateQueries({ queryKey: ["environments"] });
      queryClient.invalidateQueries({ queryKey: ["environment", environmentId] });
      queryClient.invalidateQueries({ queryKey: ["environmentNetworks", environmentId] });
      queryClient.invalidateQueries({ queryKey: ["environmentStatus", environmentId] });
    },
  });
}

export function useDeleteEnvironmentNetwork() {
  const queryClient = useQueryClient();
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: ({
      environmentId,
      networkId,
    }: {
      environmentId: string;
      networkId: string;
    }) => deleteEnvironmentNetwork(environmentId, networkId, correlationId),
    onSuccess: (_, { environmentId }) => {
      queryClient.invalidateQueries({ queryKey: ["environments"] });
      queryClient.invalidateQueries({ queryKey: ["environment", environmentId] });
      queryClient.invalidateQueries({ queryKey: ["environmentNetworks", environmentId] });
      queryClient.invalidateQueries({ queryKey: ["environmentStatus", environmentId] });
    },
  });
}

// ====================
// Volume Hooks
// ====================

export function useEnvironmentVolumes(
  environmentId: string,
  options: UseEnvironmentOptions = {},
) {
  const { enabled = true, refetchInterval, retry = 3 } = options;
  const correlationId = generateCorrelationId();

  return useQuery({
    queryKey: ["environmentVolumes", environmentId],
    queryFn: () => fetchEnvironmentVolumes(environmentId, correlationId),
    enabled: enabled && !!environmentId,
    refetchInterval,
    retry:
      typeof retry === "function"
        ? retry
        : (failureCount: number, error: Error) => {
            if (
              error.message.includes("401") ||
              error.message.includes("Unauthorized") ||
              error.message.includes("404") ||
              error.message.includes("Not found")
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

export function useCreateEnvironmentVolume() {
  const queryClient = useQueryClient();
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: ({
      environmentId,
      request,
    }: {
      environmentId: string;
      request: CreateVolumeRequest;
    }) => createEnvironmentVolume(environmentId, request, correlationId),
    onSuccess: (_, { environmentId }) => {
      queryClient.invalidateQueries({ queryKey: ["environments"] });
      queryClient.invalidateQueries({ queryKey: ["environment", environmentId] });
      queryClient.invalidateQueries({ queryKey: ["environmentVolumes", environmentId] });
      queryClient.invalidateQueries({ queryKey: ["environmentStatus", environmentId] });
    },
  });
}

export function useUpdateEnvironmentVolume() {
  const queryClient = useQueryClient();
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: ({
      environmentId,
      volumeId,
      request,
    }: {
      environmentId: string;
      volumeId: string;
      request: UpdateVolumeRequest;
    }) => updateEnvironmentVolume(environmentId, volumeId, request, correlationId),
    onSuccess: (_, { environmentId }) => {
      queryClient.invalidateQueries({ queryKey: ["environments"] });
      queryClient.invalidateQueries({ queryKey: ["environment", environmentId] });
      queryClient.invalidateQueries({ queryKey: ["environmentVolumes", environmentId] });
      queryClient.invalidateQueries({ queryKey: ["environmentStatus", environmentId] });
    },
  });
}

export function useDeleteEnvironmentVolume() {
  const queryClient = useQueryClient();
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: ({
      environmentId,
      volumeId,
    }: {
      environmentId: string;
      volumeId: string;
    }) => deleteEnvironmentVolume(environmentId, volumeId, correlationId),
    onSuccess: (_, { environmentId }) => {
      queryClient.invalidateQueries({ queryKey: ["environments"] });
      queryClient.invalidateQueries({ queryKey: ["environment", environmentId] });
      queryClient.invalidateQueries({ queryKey: ["environmentVolumes", environmentId] });
      queryClient.invalidateQueries({ queryKey: ["environmentStatus", environmentId] });
    },
  });
}

// ====================
// Environment Filter Hook
// ====================

export interface EnvironmentFiltersState {
  type?: EnvironmentType;
  status?: ServiceStatus;
  page: number;
  limit: number;
}

export function useEnvironmentFilters(
  initialFilters: Partial<EnvironmentFiltersState> = {},
) {
  const [filters, setFilters] = useState<EnvironmentFiltersState>({
    page: 1,
    limit: 20,
    ...initialFilters,
  });

  const updateFilter = useCallback(
    <K extends keyof EnvironmentFiltersState>(
      key: K,
      value: EnvironmentFiltersState[K],
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
  Environment,
  EnvironmentType,
  CreateEnvironmentRequest,
  UpdateEnvironmentRequest,
  AddServiceToEnvironmentRequest,
  EnvironmentStatusResponse,
  EnvironmentOperationResult,
  AvailableServicesResponse,
  ServiceTypeMetadata,
  EnvironmentNetwork,
  EnvironmentVolume,
  CreateNetworkRequest,
  UpdateNetworkRequest,
  NetworksResponse,
  CreateVolumeRequest,
  UpdateVolumeRequest,
  VolumesResponse,
};