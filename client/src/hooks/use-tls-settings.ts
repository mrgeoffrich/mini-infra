import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiRoute, queryKeys } from "@mini-infra/types";
import type { ApiResponse } from "@mini-infra/types";
import { apiFetch } from "@/lib/api-client";

async function fetchTlsSettings(): Promise<Record<string, string>> {
  return (
    (await apiFetch<Record<string, string>>(ApiRoute.tls.settings(), {
      correlationIdPrefix: "tls-settings",
    })) ?? {}
  );
}

async function updateTlsSettings(
  settings: Record<string, string>
): Promise<void> {
  await apiFetch<void>(ApiRoute.tls.settings(), {
    method: "PUT",
    body: settings,
    correlationIdPrefix: "tls-settings",
  });
}

async function testTlsConnectivity(
  settings: Record<string, string>
): Promise<{ success: boolean; error?: string }> {
  // The server can report `success: false` in a 2xx response for a failed
  // connectivity check (not a request error), so this opts out of
  // apiFetch's default unwrap/throw-on-`success:false` behavior.
  const response = await apiFetch<ApiResponse<{ error?: string }>>(
    ApiRoute.tls.connectivityTest(),
    {
      method: "POST",
      body: settings,
      unwrap: false,
      correlationIdPrefix: "tls-connectivity-test",
    }
  );

  // Backend returns: { success: boolean, data: { isValid: boolean, error?: string }, message?: string }
  // Transform to frontend format: { success: boolean, error?: string }
  return {
    success: response.success,
    error: response.data?.error || response.message || undefined,
  };
}

async function fetchTlsContainers(): Promise<string[]> {
  return (
    (
      await apiFetch<{ containers: string[] }>(ApiRoute.tls.containers(), {
        correlationIdPrefix: "tls-containers",
      })
    )?.containers ?? []
  );
}

export function useTlsSettings() {
  return useQuery({
    queryKey: queryKeys.settings.tlsSettings,
    queryFn: fetchTlsSettings,
  });
}

export function useUpdateTlsSettings() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: updateTlsSettings,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.tlsSettings });
      toast.success("TLS settings saved successfully");
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to save settings");
    },
  });
}

export function useTestTlsConnectivity() {
  return useMutation({
    mutationFn: testTlsConnectivity,
    onSuccess: (data) => {
      if (data.success) {
        toast.success("Connection successful! Azure Storage container is accessible.");
      } else {
        toast.error(data.error || "Connection failed");
      }
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to test connection");
    },
  });
}

export function useTlsContainers() {
  return useQuery({
    queryKey: queryKeys.tls.containers,
    queryFn: fetchTlsContainers,
    staleTime: 30000, // Consider data fresh for 30 seconds
    retry: 1,
  });
}
