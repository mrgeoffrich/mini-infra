import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiRoute, queryKeys } from "@mini-infra/types";
import type {
  CloudflareSettingResponse,
  CreateCloudflareSettingRequest,
  CloudflareTunnelListResponse,
  CloudflareTunnelConfigResponse,
  CloudflareAddHostnameRequest,
  CloudflareHostnameResponse,
  ManagedTunnelListResponse,
  ManagedTunnelResponse,
} from "@mini-infra/types";
import { Channel, ServerEvent } from "@mini-infra/types";
import { useSocket, useSocketChannel, useSocketEvent } from "./use-socket";
import { apiFetch, ApiRequestError } from "@/lib/api-client";

// The /api/connectivity/cloudflare endpoint returns the latest status as a
// flat object (not the wrapped `{ success, data }` shape used elsewhere).
export interface CloudflareConnectivityStatus {
  id: string;
  service: string;
  status: "connected" | "failed" | "timeout" | "unreachable";
  message: string | null;
  metadata: Record<string, unknown> | null;
  checkedAt: string;
  responseTime: number | null;
}

function isAuthOrForbidden(error: unknown): boolean {
  return error instanceof ApiRequestError && (error.isAuth || error.status === 403);
}

// Hook for retrieving current Cloudflare settings
export function useCloudflareSettings() {
  return useQuery<CloudflareSettingResponse>({
    queryKey: queryKeys.settings.cloudflareSettings,
    queryFn: () =>
      // Enveloped endpoint, but callers read the full `{ success, data }`
      // shape (matches `CloudflareSettingResponse`) — preserve that
      // contract with `unwrap: false`.
      apiFetch<CloudflareSettingResponse>(ApiRoute.settings.cloudflare(), {
        correlationIdPrefix: "cloudflare-settings",
        unwrap: false,
      }),
    staleTime: 30000, // 30 seconds
    retry: (failureCount, error) => {
      // Don't retry on 401/403 errors
      if (isAuthOrForbidden(error)) {
        return false;
      }
      return failureCount < 3;
    },
  });
}

// Hook for updating Cloudflare settings
export function useUpdateCloudflareSettings() {
  const queryClient = useQueryClient();

  return useMutation<
    CloudflareSettingResponse,
    Error,
    CreateCloudflareSettingRequest
  >({
    mutationFn: (payload) =>
      apiFetch<CloudflareSettingResponse>(ApiRoute.settings.cloudflare(), {
        method: "POST",
        body: payload,
        correlationIdPrefix: "cloudflare-settings",
        unwrap: false,
      }),
    onSuccess: () => {
      // Invalidate related queries
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.cloudflareSettings });
      queryClient.invalidateQueries({ queryKey: queryKeys.connectivity.cloudflare });
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.cloudflareTunnels });
    },
  });
}

// Hook for deleting Cloudflare settings
export function useDeleteCloudflareSettings() {
  const queryClient = useQueryClient();

  return useMutation<{ success: boolean; message?: string }, Error>({
    mutationFn: () =>
      apiFetch<{ success: boolean; message?: string }>(ApiRoute.settings.cloudflare(), {
        method: "DELETE",
        correlationIdPrefix: "cloudflare-settings",
        unwrap: false,
      }),
    onSuccess: () => {
      // Invalidate related queries
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.cloudflareSettings });
      queryClient.invalidateQueries({ queryKey: queryKeys.connectivity.cloudflare });
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.cloudflareTunnels });
    },
  });
}

// Hook for retrieving Cloudflare connectivity status
export function useCloudflareConnectivity() {
  const queryClient = useQueryClient();
  const { connected } = useSocket();

  useSocketChannel(Channel.CONNECTIVITY);

  useSocketEvent(
    ServerEvent.CONNECTIVITY_ALL,
    () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.connectivity.cloudflare });
    },
  );

  return useQuery<CloudflareConnectivityStatus>({
    queryKey: queryKeys.connectivity.cloudflare,
    queryFn: () =>
      // Raw (non-enveloped) endpoint — the flat status object is the body itself.
      apiFetch<CloudflareConnectivityStatus>(ApiRoute.connectivity.cloudflare(), {
        correlationIdPrefix: "cloudflare-connectivity",
        unwrap: false,
      }),
    staleTime: 60000, // 1 minute
    refetchInterval: connected ? false : 300000,
    refetchOnReconnect: true,
  });
}

// Hook for retrieving Cloudflare tunnels
export function useCloudfareTunnels() {
  const queryClient = useQueryClient();
  const { connected } = useSocket();

  useSocketChannel(Channel.CONNECTIVITY);

  useSocketEvent(
    ServerEvent.CONNECTIVITY_ALL,
    () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.cloudflareTunnels });
    },
  );

  return useQuery<CloudflareTunnelListResponse>({
    queryKey: queryKeys.settings.cloudflareTunnels,
    queryFn: () =>
      apiFetch<CloudflareTunnelListResponse>(ApiRoute.settings.cloudflareTunnels(), {
        correlationIdPrefix: "cloudflare-tunnels",
        unwrap: false,
      }),
    staleTime: 60000, // 1 minute - matches backend cache TTL
    refetchInterval: connected ? false : 120000,
    refetchOnReconnect: true,
    retry: (failureCount, error) => {
      // Don't retry on 401/403/404 errors
      if (isAuthOrForbidden(error)) {
        return false;
      }
      if (error instanceof Error && error.message.toLowerCase().includes("not configured")) {
        return false;
      }
      return failureCount < 2;
    },
  });
}

// Hook for retrieving tunnel configuration
export function useCloudfareTunnelConfig(tunnelId: string | undefined) {
  return useQuery<CloudflareTunnelConfigResponse>({
    queryKey: queryKeys.settings.cloudflareTunnelConfig(tunnelId ?? ""),
    queryFn: () => {
      if (!tunnelId) {
        throw new Error("Tunnel ID is required");
      }
      return apiFetch<CloudflareTunnelConfigResponse>(
        ApiRoute.settings.cloudflareTunnelConfig(tunnelId),
        { correlationIdPrefix: "cloudflare-tunnels", unwrap: false },
      );
    },
    enabled: !!tunnelId,
    staleTime: 60000, // 1 minute - matches backend cache TTL
    retry: (failureCount, error) => {
      // Don't retry on 401/403/404 errors
      if (isAuthOrForbidden(error) || (error instanceof ApiRequestError && error.status === 404)) {
        return false;
      }
      return failureCount < 2;
    },
  });
}

// Hook for refreshing tunnel data manually
export function useRefreshCloudfareTunnels() {
  const queryClient = useQueryClient();

  return useMutation<void, Error>({
    mutationFn: async () => {
      // Just invalidate the cache to force a refetch
      await queryClient.invalidateQueries({ queryKey: queryKeys.settings.cloudflareTunnels });
    },
  });
}

// Hook for adding a hostname to a tunnel
export function useAddTunnelHostname() {
  const queryClient = useQueryClient();

  return useMutation<
    CloudflareHostnameResponse,
    Error,
    { tunnelId: string } & CloudflareAddHostnameRequest
  >({
    mutationFn: ({ tunnelId, hostname, service, path }) =>
      apiFetch<CloudflareHostnameResponse>(
        ApiRoute.settings.cloudflareTunnelHostnames(tunnelId),
        {
          method: "POST",
          body: { hostname, service, path },
          correlationIdPrefix: "cloudflare-tunnels",
          unwrap: false,
        },
      ),
    onSuccess: (data) => {
      // Invalidate tunnel-related queries to refresh the data
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.cloudflareTunnels });
      queryClient.invalidateQueries({
        queryKey: queryKeys.settings.cloudflareTunnel(data.data.tunnelId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.settings.cloudflareTunnelConfig(data.data.tunnelId),
      });
    },
    // Error toast handled by the global MutationCache.onError (client/src/lib/query-client.ts).
  });
}

// Hook for removing a hostname from a tunnel
export function useRemoveTunnelHostname() {
  const queryClient = useQueryClient();

  return useMutation<
    CloudflareHostnameResponse,
    Error,
    { tunnelId: string; hostname: string; path?: string }
  >({
    mutationFn: ({ tunnelId, hostname, path }) => {
      // URL encode hostname to handle special characters
      const url = new URL(
        ApiRoute.settings.cloudflareTunnelHostname(tunnelId, encodeURIComponent(hostname)),
        window.location.origin,
      );
      if (path) {
        url.searchParams.set("path", path);
      }
      return apiFetch<CloudflareHostnameResponse>(url.pathname + url.search, {
        method: "DELETE",
        correlationIdPrefix: "cloudflare-tunnels",
        unwrap: false,
      });
    },
    onSuccess: (data) => {
      // Invalidate tunnel-related queries to refresh the data
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.cloudflareTunnels });
      queryClient.invalidateQueries({
        queryKey: queryKeys.settings.cloudflareTunnel(data.data.tunnelId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.settings.cloudflareTunnelConfig(data.data.tunnelId),
      });
    },
    // Error toast handled by the global MutationCache.onError (client/src/lib/query-client.ts).
  });
}

// ====================
// Managed Tunnel Hooks
// ====================

// Hook for listing all managed tunnels across environments
export function useManagedTunnels() {
  return useQuery<ManagedTunnelListResponse>({
    queryKey: queryKeys.settings.managedTunnels,
    queryFn: () =>
      apiFetch<ManagedTunnelListResponse>(ApiRoute.settings.cloudflareManagedTunnels(), {
        correlationIdPrefix: "managed-tunnels",
        unwrap: false,
      }),
    staleTime: 30000,
  });
}

// Hook for getting managed tunnel for a specific environment
export function useManagedTunnel(environmentId: string | undefined) {
  return useQuery<ManagedTunnelResponse>({
    queryKey: queryKeys.settings.managedTunnel(environmentId ?? ""),
    queryFn: () => {
      if (!environmentId) throw new Error("Environment ID is required");
      return apiFetch<ManagedTunnelResponse>(
        ApiRoute.settings.cloudflareManagedTunnel(environmentId),
        { correlationIdPrefix: "managed-tunnels", unwrap: false },
      );
    },
    enabled: !!environmentId,
    staleTime: 30000,
  });
}

// Hook for creating a managed tunnel
export function useCreateManagedTunnel() {
  const queryClient = useQueryClient();

  return useMutation<
    ManagedTunnelResponse,
    Error,
    { environmentId: string; name: string }
  >({
    mutationFn: ({ environmentId, name }) =>
      apiFetch<ManagedTunnelResponse>(
        ApiRoute.settings.cloudflareManagedTunnel(environmentId),
        {
          method: "POST",
          body: { name },
          correlationIdPrefix: "managed-tunnels",
          unwrap: false,
        },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.managedTunnels });
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.managedTunnelAll });
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.cloudflareTunnels });
      queryClient.invalidateQueries({ queryKey: queryKeys.stacks.all });
    },
  });
}

// Hook for deleting a managed tunnel
export function useDeleteManagedTunnel() {
  const queryClient = useQueryClient();

  return useMutation<{ success: boolean; message?: string }, Error, string>({
    mutationFn: (environmentId: string) =>
      apiFetch<{ success: boolean; message?: string }>(
        ApiRoute.settings.cloudflareManagedTunnel(environmentId),
        {
          method: "DELETE",
          correlationIdPrefix: "managed-tunnels",
          unwrap: false,
        },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.managedTunnels });
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.managedTunnelAll });
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.cloudflareTunnels });
      queryClient.invalidateQueries({ queryKey: queryKeys.stacks.all });
    },
  });
}
