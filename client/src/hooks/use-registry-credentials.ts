import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiRoute, queryKeys } from "@mini-infra/types";
import type {
  RegistryCredential,
  CreateRegistryCredentialRequest,
  UpdateRegistryCredentialRequest,
  RegistryTestResult,
} from "@mini-infra/types";
import { apiFetch, ApiRequestError } from "@/lib/api-client";

// ====================
// API Response Types
// ====================

interface RegistryCredentialListResponse {
  success: boolean;
  data: RegistryCredential[];
  message?: string;
}

interface RegistryCredentialResponse {
  success: boolean;
  data: RegistryCredential;
  message?: string;
}

interface RegistryTestResponse {
  success: boolean;
  data: RegistryTestResult;
  message?: string;
}

interface DeleteResponse {
  success: boolean;
  message?: string;
}

// ====================
// API Functions
// ====================

async function fetchRegistryCredentials(
  includeInactive: boolean,
): Promise<RegistryCredentialListResponse> {
  const url = new URL(ApiRoute.registryCredentials.list(), window.location.origin);
  url.searchParams.set("includeInactive", includeInactive.toString());

  const data = await apiFetch<RegistryCredentialListResponse>(
    url.pathname + url.search,
    { correlationIdPrefix: "registry-credentials", unwrap: false },
  );

  if (!data.success) {
    throw new Error(data.message || "Failed to fetch registry credentials");
  }

  return data;
}

async function fetchRegistryCredential(
  id: string,
): Promise<RegistryCredentialResponse> {
  const data = await apiFetch<RegistryCredentialResponse>(
    ApiRoute.registryCredentials.get(id),
    { correlationIdPrefix: "registry-credentials", unwrap: false },
  );

  if (!data.success) {
    throw new Error(data.message || "Failed to fetch registry credential");
  }

  return data;
}

async function createRegistryCredential(
  credential: CreateRegistryCredentialRequest,
): Promise<RegistryCredentialResponse> {
  const data = await apiFetch<RegistryCredentialResponse>(
    ApiRoute.registryCredentials.list(),
    {
      method: "POST",
      body: credential,
      correlationIdPrefix: "registry-credentials",
      unwrap: false,
    },
  );

  if (!data.success) {
    throw new Error(data.message || "Failed to create registry credential");
  }

  return data;
}

async function updateRegistryCredential(
  id: string,
  credential: UpdateRegistryCredentialRequest,
): Promise<RegistryCredentialResponse> {
  const data = await apiFetch<RegistryCredentialResponse>(
    ApiRoute.registryCredentials.get(id),
    {
      method: "PUT",
      body: credential,
      correlationIdPrefix: "registry-credentials",
      unwrap: false,
    },
  );

  if (!data.success) {
    throw new Error(data.message || "Failed to update registry credential");
  }

  return data;
}

async function deleteRegistryCredential(id: string): Promise<DeleteResponse> {
  const data = await apiFetch<DeleteResponse>(
    ApiRoute.registryCredentials.get(id),
    {
      method: "DELETE",
      correlationIdPrefix: "registry-credentials",
      unwrap: false,
    },
  );

  if (!data.success) {
    throw new Error(data.message || "Failed to delete registry credential");
  }

  return data;
}

async function setDefaultCredential(id: string): Promise<DeleteResponse> {
  const data = await apiFetch<DeleteResponse>(
    ApiRoute.registryCredentials.setDefault(id),
    {
      method: "POST",
      correlationIdPrefix: "registry-credentials",
      unwrap: false,
    },
  );

  if (!data.success) {
    throw new Error(data.message || "Failed to set default credential");
  }

  return data;
}

async function testRegistryCredential(id: string): Promise<RegistryTestResponse> {
  const data = await apiFetch<RegistryTestResponse>(
    ApiRoute.registryCredentials.test(id),
    {
      method: "POST",
      correlationIdPrefix: "registry-credentials",
      unwrap: false,
    },
  );

  if (!data.success) {
    throw new Error(data.message || "Failed to test credential");
  }

  return data;
}

async function testRegistryConnection(params: {
  registryUrl: string;
  username: string;
  password: string;
  testImage?: string;
}): Promise<RegistryTestResponse> {
  const data = await apiFetch<RegistryTestResponse>(
    ApiRoute.registryCredentials.testConnection(),
    {
      method: "POST",
      body: params,
      correlationIdPrefix: "registry-credentials",
      unwrap: false,
    },
  );

  if (!data.success) {
    throw new Error(data.message || "Failed to test connection");
  }

  return data;
}

// ====================
// React Query Hooks
// ====================

function isAuthError(error: unknown): boolean {
  return error instanceof ApiRequestError && error.isAuth;
}

export interface UseRegistryCredentialsOptions {
  enabled?: boolean;
  includeInactive?: boolean;
  refetchInterval?: number;
  retry?: number | boolean | ((failureCount: number, error: Error) => boolean);
}

export function useRegistryCredentials(
  options: UseRegistryCredentialsOptions = {}
) {
  const {
    enabled = true,
    includeInactive = false,
    refetchInterval,
    retry = 3,
  } = options;

  return useQuery({
    queryKey: [...queryKeys.registryCredentials.all, includeInactive],
    queryFn: () => fetchRegistryCredentials(includeInactive),
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
    staleTime: 5000, // Data is fresh for 5 seconds
    gcTime: 5 * 60 * 1000, // Keep in cache for 5 minutes
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

export interface UseRegistryCredentialOptions {
  enabled?: boolean;
  retry?: number | boolean | ((failureCount: number, error: Error) => boolean);
}

export function useRegistryCredential(
  id: string,
  options: UseRegistryCredentialOptions = {}
) {
  const { enabled = true, retry = 3 } = options;

  return useQuery({
    queryKey: [...queryKeys.registryCredentials.all, id],
    queryFn: () => fetchRegistryCredential(id),
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
export function useCreateRegistryCredential() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (credential: CreateRegistryCredentialRequest) =>
      createRegistryCredential(credential),
    onSuccess: () => {
      // Invalidate and refetch registry credentials
      queryClient.invalidateQueries({ queryKey: queryKeys.registryCredentials.all });
    },
  });
}

export function useUpdateRegistryCredential() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      id,
      credential,
    }: {
      id: string;
      credential: UpdateRegistryCredentialRequest;
    }) => updateRegistryCredential(id, credential),
    onSuccess: (_, variables) => {
      // Invalidate and refetch registry credentials
      queryClient.invalidateQueries({ queryKey: queryKeys.registryCredentials.all });
      // Update the specific credential in cache
      queryClient.invalidateQueries({
        queryKey: [...queryKeys.registryCredentials.all, variables.id],
      });
    },
  });
}

export function useDeleteRegistryCredential() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => deleteRegistryCredential(id),
    onSuccess: (_, id) => {
      // Invalidate and refetch registry credentials
      queryClient.invalidateQueries({ queryKey: queryKeys.registryCredentials.all });
      // Remove the specific credential from cache
      queryClient.removeQueries({ queryKey: [...queryKeys.registryCredentials.all, id] });
    },
  });
}

export function useSetDefaultCredential() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => setDefaultCredential(id),
    onSuccess: () => {
      // Invalidate and refetch registry credentials
      queryClient.invalidateQueries({ queryKey: queryKeys.registryCredentials.all });
    },
  });
}

export function useTestRegistryCredential() {
  return useMutation({
    mutationFn: (id: string) => testRegistryCredential(id),
  });
}

export function useTestRegistryConnection() {
  return useMutation({
    mutationFn: (params: {
      registryUrl: string;
      username: string;
      password: string;
      testImage?: string;
    }) => testRegistryConnection(params),
  });
}
