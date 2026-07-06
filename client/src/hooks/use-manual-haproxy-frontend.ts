import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  EligibleContainersResponse,
  CreateManualFrontendRequest,
  UpdateManualFrontendRequest,
  ManualFrontendResponse,
  DeleteManualFrontendResponse,
  TlsCertificate,
  ApiRoute,
  queryKeys,
} from "@mini-infra/types";
import { apiFetch, ApiRequestError } from "@/lib/api-client";

// ====================
// Manual HAProxy Frontend API Functions
// ====================
//
// The eligible-containers / create / update / delete endpoints are enveloped
// (`{success, data, message?}`), but the existing hook consumers (including
// several files outside this migration batch) read the *whole* envelope off
// the mutation/query result (e.g. `data.message`, `data.data.containers`).
// To avoid rippling type/shape changes into files outside this batch's
// scope, those functions keep returning the full envelope via
// `{ unwrap: false }`. `fetchTLSCertificates` already unwrapped to the inner
// `TlsCertificate[]` in the pre-migration code, so it uses `apiFetch`'s
// default unwrap behavior.

async function fetchEligibleContainers(
  environmentId: string,
): Promise<EligibleContainersResponse> {
  const url = new URL(ApiRoute.haproxy.manualFrontendContainers(), window.location.origin);
  url.searchParams.set("environmentId", environmentId);

  const data = await apiFetch<EligibleContainersResponse>(url.toString(), {
    correlationIdPrefix: "manual-haproxy-frontend",
    unwrap: false,
  });

  if (!data.success) {
    throw new Error(data.message || "Failed to fetch eligible containers");
  }

  return data;
}

async function createManualFrontend(
  request: CreateManualFrontendRequest,
): Promise<ManualFrontendResponse> {
  const data = await apiFetch<ManualFrontendResponse>(ApiRoute.haproxy.manualFrontends(), {
    method: "POST",
    body: request,
    correlationIdPrefix: "manual-haproxy-frontend",
    unwrap: false,
  });

  if (!data.success) {
    throw new Error(data.message || "Failed to create manual frontend");
  }

  return data;
}

async function updateManualFrontend(
  frontendName: string,
  request: UpdateManualFrontendRequest,
): Promise<ManualFrontendResponse> {
  const data = await apiFetch<ManualFrontendResponse>(
    ApiRoute.haproxy.manualFrontend(frontendName),
    {
      method: "PUT",
      body: request,
      correlationIdPrefix: "manual-haproxy-frontend",
      unwrap: false,
    },
  );

  if (!data.success) {
    throw new Error(data.message || "Failed to update manual frontend");
  }

  return data;
}

async function deleteManualFrontend(
  frontendName: string,
): Promise<DeleteManualFrontendResponse> {
  return apiFetch<DeleteManualFrontendResponse>(ApiRoute.haproxy.manualFrontend(frontendName), {
    method: "DELETE",
    correlationIdPrefix: "manual-haproxy-frontend",
    unwrap: false,
  });
}

async function fetchTLSCertificates(environmentId: string): Promise<TlsCertificate[]> {
  const url = new URL(ApiRoute.tls.certificates(), window.location.origin);
  url.searchParams.set("environmentId", environmentId);
  url.searchParams.set("status", "ACTIVE");

  const data = await apiFetch<TlsCertificate[]>(url.toString(), {
    correlationIdPrefix: "manual-haproxy-frontend",
  });

  return data || [];
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

  return useQuery({
    queryKey: queryKeys.haproxy.manualFrontendEligibleContainers(environmentId!),
    queryFn: () => fetchEligibleContainers(environmentId!),
    enabled: enabled && !!environmentId,
    refetchInterval,
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

  return useMutation({
    mutationFn: (request: CreateManualFrontendRequest) => createManualFrontend(request),
    onSuccess: (data) => {
      // Invalidate all frontends list
      queryClient.invalidateQueries({ queryKey: queryKeys.haproxy.frontends });
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

  return useMutation({
    mutationFn: ({
      frontendName,
      request,
    }: {
      frontendName: string;
      request: UpdateManualFrontendRequest;
    }) => updateManualFrontend(frontendName, request),
    onSuccess: (data, { frontendName }) => {
      // Invalidate frontend details
      queryClient.invalidateQueries({
        queryKey: queryKeys.haproxy.frontend(frontendName),
      });
      // Invalidate all frontends list
      queryClient.invalidateQueries({ queryKey: queryKeys.haproxy.frontends });
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

  return useMutation({
    mutationFn: (frontendName: string) => deleteManualFrontend(frontendName),
    onSuccess: (_, frontendName) => {
      // Invalidate frontends list to refresh the data
      queryClient.invalidateQueries({ queryKey: queryKeys.haproxy.frontends });

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

  return useQuery({
    queryKey: queryKeys.haproxy.tlsCertificates(environmentId!),
    queryFn: () => fetchTLSCertificates(environmentId!),
    enabled: enabled && !!environmentId,
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
    queryKey: queryKeys.haproxy.frontends,
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
