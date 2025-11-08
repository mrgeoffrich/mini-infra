import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  RegistryCredential,
  CreateRegistryCredentialRequest,
  UpdateRegistryCredentialRequest,
  RegistryTestResult,
} from "@mini-infra/types";

// Generate correlation ID for debugging
function generateCorrelationId(): string {
  return `registry-credentials-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

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
  correlationId: string,
): Promise<RegistryCredentialListResponse> {
  const url = new URL(`/api/registry-credentials`, window.location.origin);
  url.searchParams.set("includeInactive", includeInactive.toString());

  const response = await fetch(url.toString(), {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch registry credentials: ${response.statusText}`);
  }

  const data: RegistryCredentialListResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to fetch registry credentials");
  }

  return data;
}

async function fetchRegistryCredential(
  id: string,
  correlationId: string,
): Promise<RegistryCredentialResponse> {
  const response = await fetch(`/api/registry-credentials/${id}`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch registry credential: ${response.statusText}`);
  }

  const data: RegistryCredentialResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to fetch registry credential");
  }

  return data;
}

async function createRegistryCredential(
  credential: CreateRegistryCredentialRequest,
  correlationId: string,
): Promise<RegistryCredentialResponse> {
  const response = await fetch(`/api/registry-credentials`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
    body: JSON.stringify(credential),
  });

  if (!response.ok) {
    throw new Error(`Failed to create registry credential: ${response.statusText}`);
  }

  const data: RegistryCredentialResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to create registry credential");
  }

  return data;
}

async function updateRegistryCredential(
  id: string,
  credential: UpdateRegistryCredentialRequest,
  correlationId: string,
): Promise<RegistryCredentialResponse> {
  const response = await fetch(`/api/registry-credentials/${id}`, {
    method: "PUT",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
    body: JSON.stringify(credential),
  });

  if (!response.ok) {
    throw new Error(`Failed to update registry credential: ${response.statusText}`);
  }

  const data: RegistryCredentialResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to update registry credential");
  }

  return data;
}

async function deleteRegistryCredential(
  id: string,
  correlationId: string,
): Promise<DeleteResponse> {
  const response = await fetch(`/api/registry-credentials/${id}`, {
    method: "DELETE",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to delete registry credential: ${response.statusText}`);
  }

  const data: DeleteResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to delete registry credential");
  }

  return data;
}

async function setDefaultCredential(
  id: string,
  correlationId: string,
): Promise<DeleteResponse> {
  const response = await fetch(`/api/registry-credentials/${id}/set-default`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to set default credential: ${response.statusText}`);
  }

  const data: DeleteResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to set default credential");
  }

  return data;
}

async function testRegistryCredential(
  id: string,
  correlationId: string,
): Promise<RegistryTestResponse> {
  const response = await fetch(`/api/registry-credentials/${id}/test`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to test credential: ${response.statusText}`);
  }

  const data: RegistryTestResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to test credential");
  }

  return data;
}

async function testRegistryConnection(
  params: {
    registryUrl: string;
    username: string;
    password: string;
    testImage?: string;
  },
  correlationId: string,
): Promise<RegistryTestResponse> {
  const response = await fetch(`/api/registry-credentials/test-connection`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
    body: JSON.stringify(params),
  });

  if (!response.ok) {
    throw new Error(`Failed to test connection: ${response.statusText}`);
  }

  const data: RegistryTestResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to test connection");
  }

  return data;
}

// ====================
// React Query Hooks
// ====================

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

  const correlationId = generateCorrelationId();

  return useQuery({
    queryKey: ["registry-credentials", includeInactive],
    queryFn: () => fetchRegistryCredentials(includeInactive, correlationId),
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
  const correlationId = generateCorrelationId();

  return useQuery({
    queryKey: ["registry-credentials", id],
    queryFn: () => fetchRegistryCredential(id, correlationId),
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
export function useCreateRegistryCredential() {
  const queryClient = useQueryClient();
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: (credential: CreateRegistryCredentialRequest) =>
      createRegistryCredential(credential, correlationId),
    onSuccess: () => {
      // Invalidate and refetch registry credentials
      queryClient.invalidateQueries({ queryKey: ["registry-credentials"] });
    },
  });
}

export function useUpdateRegistryCredential() {
  const queryClient = useQueryClient();
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: ({
      id,
      credential,
    }: {
      id: string;
      credential: UpdateRegistryCredentialRequest;
    }) => updateRegistryCredential(id, credential, correlationId),
    onSuccess: (_, variables) => {
      // Invalidate and refetch registry credentials
      queryClient.invalidateQueries({ queryKey: ["registry-credentials"] });
      // Update the specific credential in cache
      queryClient.invalidateQueries({
        queryKey: ["registry-credentials", variables.id],
      });
    },
  });
}

export function useDeleteRegistryCredential() {
  const queryClient = useQueryClient();
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: (id: string) => deleteRegistryCredential(id, correlationId),
    onSuccess: (_, id) => {
      // Invalidate and refetch registry credentials
      queryClient.invalidateQueries({ queryKey: ["registry-credentials"] });
      // Remove the specific credential from cache
      queryClient.removeQueries({ queryKey: ["registry-credentials", id] });
    },
  });
}

export function useSetDefaultCredential() {
  const queryClient = useQueryClient();
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: (id: string) => setDefaultCredential(id, correlationId),
    onSuccess: () => {
      // Invalidate and refetch registry credentials
      queryClient.invalidateQueries({ queryKey: ["registry-credentials"] });
    },
  });
}

export function useTestRegistryCredential() {
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: (id: string) => testRegistryCredential(id, correlationId),
  });
}

export function useTestRegistryConnection() {
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: (params: {
      registryUrl: string;
      username: string;
      password: string;
      testImage?: string;
    }) => testRegistryConnection(params, correlationId),
  });
}
