import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  EligibleContainersResponse,
  CreateManualFrontendRequest,
  UpdateManualFrontendRequest,
  ManualFrontendResponse,
  DeleteManualFrontendResponse,
  TlsCertificate,
} from "@mini-infra/types";

// Generate correlation ID for debugging
function generateCorrelationId(): string {
  return `manual-haproxy-frontend-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// ====================
// Manual HAProxy Frontend API Functions
// ====================

async function fetchEligibleContainers(
  environmentId: string,
  correlationId: string,
): Promise<EligibleContainersResponse> {
  const response = await fetch(
    `/api/haproxy/manual-frontends/containers?environmentId=${environmentId}`,
    {
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "X-Correlation-ID": correlationId,
      },
    },
  );

  if (!response.ok) {
    throw new Error(
      `Failed to fetch eligible containers: ${response.statusText}`,
    );
  }

  const data: EligibleContainersResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to fetch eligible containers");
  }

  return data;
}

async function createManualFrontend(
  request: CreateManualFrontendRequest,
  correlationId: string,
): Promise<ManualFrontendResponse> {
  const response = await fetch(`/api/haproxy/manual-frontends`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(errorData.message || "Failed to create manual frontend");
  }

  const data: ManualFrontendResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to create manual frontend");
  }

  return data;
}

async function updateManualFrontend(
  frontendName: string,
  request: UpdateManualFrontendRequest,
  correlationId: string,
): Promise<ManualFrontendResponse> {
  const response = await fetch(
    `/api/haproxy/manual-frontends/${frontendName}`,
    {
      method: "PUT",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "X-Correlation-ID": correlationId,
      },
      body: JSON.stringify(request),
    },
  );

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(errorData.message || "Failed to update manual frontend");
  }

  const data: ManualFrontendResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to update manual frontend");
  }

  return data;
}

async function deleteManualFrontend(
  frontendName: string,
  correlationId: string,
): Promise<DeleteManualFrontendResponse> {
  const response = await fetch(`/api/haproxy/manual-frontends/${frontendName}`, {
    method: "DELETE",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(
      errorData.message || `Failed to delete manual frontend: ${response.statusText}`,
    );
  }

  return await response.json();
}

async function fetchTLSCertificates(
  environmentId: string,
  correlationId: string,
): Promise<TlsCertificate[]> {
  const response = await fetch(
    `/api/tls/certificates?environmentId=${environmentId}&status=ACTIVE`,
    {
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "X-Correlation-ID": correlationId,
      },
    },
  );

  if (!response.ok) {
    throw new Error(
      `Failed to fetch TLS certificates: ${response.statusText}`,
    );
  }

  const data = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to fetch TLS certificates");
  }

  return data.data || [];
}

// ====================
// Manual HAProxy Frontend Hooks
// ====================

export interface UseManualFrontendOptions {
  enabled?: boolean;
  refetchInterval?: number;
  retry?: number | boolean | ((failureCount: number, error: Error) => boolean);
}

/**
 * Hook to get eligible containers for an environment
 */
export function useEligibleContainers(
  environmentId: string | null,
  options: UseManualFrontendOptions = {},
) {
  const { enabled = true, refetchInterval, retry = 3 } = options;
  const correlationId = generateCorrelationId();

  return useQuery({
    queryKey: ["eligible-containers", environmentId],
    queryFn: () => fetchEligibleContainers(environmentId!, correlationId),
    enabled: enabled && !!environmentId,
    refetchInterval,
    retry:
      typeof retry === "function"
        ? retry
        : (failureCount: number, error: Error) => {
            if (
              error.message.includes("401") ||
              error.message.includes("Unauthorized") ||
              error.message.includes("404")
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

/**
 * Hook to create a manual frontend
 */
export function useCreateManualFrontend() {
  const queryClient = useQueryClient();
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: (request: CreateManualFrontendRequest) =>
      createManualFrontend(request, correlationId),
    onSuccess: (data) => {
      // Invalidate all frontends list
      queryClient.invalidateQueries({ queryKey: ["haproxy-frontends"] });
      toast.success("Frontend created", {
        description: data.message || "Manual frontend created successfully",
      });
    },
    onError: (error: Error) => {
      toast.error("Failed to create frontend", {
        description: error.message || "Failed to create manual frontend",
      });
    },
  });
}

/**
 * Hook to update a manual frontend
 */
export function useUpdateManualFrontend() {
  const queryClient = useQueryClient();
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: ({
      frontendName,
      request,
    }: {
      frontendName: string;
      request: UpdateManualFrontendRequest;
    }) => updateManualFrontend(frontendName, request, correlationId),
    onSuccess: (data, { frontendName }) => {
      // Invalidate frontend details
      queryClient.invalidateQueries({
        queryKey: ["haproxy-frontend", frontendName],
      });
      // Invalidate all frontends list
      queryClient.invalidateQueries({ queryKey: ["haproxy-frontends"] });
      toast.success("Frontend updated", {
        description: data.message || "Manual frontend updated successfully",
      });
    },
    onError: (error: Error) => {
      toast.error("Failed to update frontend", {
        description: error.message || "Failed to update manual frontend",
      });
    },
  });
}

/**
 * Hook to delete a manual HAProxy frontend
 * Invalidates the frontends list query on success
 */
export function useDeleteManualFrontend() {
  const queryClient = useQueryClient();
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: (frontendName: string) =>
      deleteManualFrontend(frontendName, correlationId),
    onSuccess: (_, frontendName) => {
      // Invalidate frontends list to refresh the data
      queryClient.invalidateQueries({ queryKey: ["haproxy-frontends"] });

      // Show success toast
      toast.success("Frontend deleted", {
        description: `Manual frontend "${frontendName}" has been deleted successfully.`,
      });
    },
    onError: (error: Error, frontendName) => {
      // Show error toast
      toast.error("Failed to delete frontend", {
        description: error.message || `Could not delete manual frontend "${frontendName}".`,
      });
    },
  });
}

/**
 * Hook to get TLS certificates for an environment
 */
export function useTLSCertificates(
  environmentId: string | null,
  options: UseManualFrontendOptions = {},
) {
  const { enabled = true, retry = 3 } = options;
  const correlationId = generateCorrelationId();

  return useQuery({
    queryKey: ["tls-certificates", environmentId],
    queryFn: () => fetchTLSCertificates(environmentId!, correlationId),
    enabled: enabled && !!environmentId,
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
    staleTime: 60000, // Data is fresh for 1 minute
    gcTime: 10 * 60 * 1000, // Keep in cache for 10 minutes
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

/**
 * Hook to validate hostname availability (client-side check)
 */
interface ValidateHostnameFrontend {
  frontendName: string;
  hostname: string;
  environmentId: string | null;
}

interface ValidateHostnameCache {
  data?: { frontends?: ValidateHostnameFrontend[] };
}

export function useValidateHostname(hostname: string, environmentId: string) {
  const { data: frontendsData } = useQuery<ValidateHostnameCache>({
    queryKey: ["haproxy-frontends"],
  });

  if (!hostname || !frontendsData?.data?.frontends) {
    return { available: true, conflictingFrontend: undefined };
  }

  const conflictingFrontend = frontendsData?.data?.frontends?.find(
    (f) =>
      f.hostname === hostname && f.environmentId === environmentId,
  );

  return {
    available: !conflictingFrontend,
    conflictingFrontend: conflictingFrontend?.frontendName,
  };
}

// ====================
// Type Exports
// ====================

export type {
  EligibleContainersResponse,
  CreateManualFrontendRequest,
  UpdateManualFrontendRequest,
  ManualFrontendResponse,
  DeleteManualFrontendResponse,
};
