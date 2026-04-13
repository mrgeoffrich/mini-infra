import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CloudflareSettingResponse,
  CreateCloudflareSettingRequest,
  ConnectivityStatusResponse,
  CloudflareTunnelListResponse,
  CloudflareTunnelConfigResponse,
  CloudflareAddHostnameRequest,
  CloudflareHostnameResponse,
  ManagedTunnelListResponse,
  ManagedTunnelResponse,
} from "@mini-infra/types";
import { Channel, ServerEvent } from "@mini-infra/types";
import { useSocket, useSocketChannel, useSocketEvent } from "./use-socket";

// Hook for retrieving current Cloudflare settings
export function useCloudflareSettings() {
  return useQuery<CloudflareSettingResponse>({
    queryKey: ["cloudflare-settings"],
    queryFn: async () => {
      const response = await fetch("/api/settings/cloudflare", {
        credentials: "include",
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({
          message: "Failed to fetch Cloudflare settings",
        }));
        throw new Error(errorData.message || "Failed to fetch settings");
      }

      return response.json();
    },
    staleTime: 30000, // 30 seconds
    retry: (failureCount, error) => {
      // Don't retry on 401/403 errors
      if (error instanceof Error) {
        const message = error.message.toLowerCase();
        if (message.includes("unauthorized") || message.includes("forbidden")) {
          return false;
        }
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
    mutationFn: async (payload) => {
      const response = await fetch("/api/settings/cloudflare", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({
          message: "Failed to update Cloudflare settings",
        }));
        throw new Error(errorData.message || "Failed to update settings");
      }

      return response.json();
    },
    onSuccess: () => {
      // Invalidate related queries
      queryClient.invalidateQueries({ queryKey: ["cloudflare-settings"] });
      queryClient.invalidateQueries({ queryKey: ["cloudflare-connectivity"] });
      queryClient.invalidateQueries({ queryKey: ["cloudflare-tunnels"] });
    },
  });
}

// Hook for deleting Cloudflare settings
export function useDeleteCloudflareSettings() {
  const queryClient = useQueryClient();

  return useMutation<{ success: boolean; message?: string }, Error>({
    mutationFn: async () => {
      const response = await fetch("/api/settings/cloudflare", {
        method: "DELETE",
        credentials: "include",
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({
          message: "Failed to delete Cloudflare settings",
        }));
        throw new Error(errorData.message || "Failed to delete settings");
      }

      return response.json();
    },
    onSuccess: () => {
      // Invalidate related queries
      queryClient.invalidateQueries({ queryKey: ["cloudflare-settings"] });
      queryClient.invalidateQueries({ queryKey: ["cloudflare-connectivity"] });
      queryClient.invalidateQueries({ queryKey: ["cloudflare-tunnels"] });
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
      queryClient.invalidateQueries({ queryKey: ["cloudflare-connectivity"] });
    },
  );

  return useQuery<ConnectivityStatusResponse>({
    queryKey: ["cloudflare-connectivity"],
    queryFn: async () => {
      const response = await fetch("/api/connectivity/cloudflare", {
        credentials: "include",
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({
          message: "Failed to fetch connectivity status",
        }));
        throw new Error(errorData.message || "Failed to fetch status");
      }

      return response.json();
    },
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
      queryClient.invalidateQueries({ queryKey: ["cloudflare-tunnels"] });
    },
  );

  return useQuery<CloudflareTunnelListResponse>({
    queryKey: ["cloudflare-tunnels"],
    queryFn: async () => {
      const response = await fetch("/api/settings/cloudflare/tunnels", {
        credentials: "include",
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({
          message: "Failed to fetch Cloudflare tunnels",
        }));
        throw new Error(errorData.message || "Failed to fetch tunnels");
      }

      return response.json();
    },
    staleTime: 60000, // 1 minute - matches backend cache TTL
    refetchInterval: connected ? false : 120000,
    refetchOnReconnect: true,
    retry: (failureCount, error) => {
      // Don't retry on 401/403/404 errors
      if (error instanceof Error) {
        const message = error.message.toLowerCase();
        if (
          message.includes("unauthorized") ||
          message.includes("forbidden") ||
          message.includes("not configured")
        ) {
          return false;
        }
      }
      return failureCount < 2;
    },
  });
}

// Hook for retrieving tunnel configuration
export function useCloudfareTunnelConfig(tunnelId: string | undefined) {
  return useQuery<CloudflareTunnelConfigResponse>({
    queryKey: ["cloudflare-tunnel-config", tunnelId],
    queryFn: async () => {
      if (!tunnelId) {
        throw new Error("Tunnel ID is required");
      }

      const response = await fetch(
        `/api/settings/cloudflare/tunnels/${tunnelId}/config`,
        {
          credentials: "include",
        },
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({
          message: "Failed to fetch tunnel configuration",
        }));
        throw new Error(
          errorData.message || "Failed to fetch tunnel configuration",
        );
      }

      return response.json();
    },
    enabled: !!tunnelId,
    staleTime: 60000, // 1 minute - matches backend cache TTL
    retry: (failureCount, error) => {
      // Don't retry on 401/403/404 errors
      if (error instanceof Error) {
        const message = error.message.toLowerCase();
        if (
          message.includes("unauthorized") ||
          message.includes("forbidden") ||
          message.includes("not found")
        ) {
          return false;
        }
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
      await queryClient.invalidateQueries({ queryKey: ["cloudflare-tunnels"] });
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
    mutationFn: async ({ tunnelId, hostname, service, path }) => {
      const response = await fetch(
        `/api/settings/cloudflare/tunnels/${tunnelId}/hostnames`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          credentials: "include",
          body: JSON.stringify({
            hostname,
            service,
            path,
          }),
        },
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({
          message: "Failed to add hostname to tunnel",
        }));
        throw new Error(
          errorData.details || errorData.message || "Failed to add hostname",
        );
      }

      return response.json();
    },
    onSuccess: (data) => {
      // Invalidate tunnel-related queries to refresh the data
      queryClient.invalidateQueries({ queryKey: ["cloudflare-tunnels"] });
      queryClient.invalidateQueries({
        queryKey: ["cloudflare-tunnel", data.data.tunnelId],
      });
      queryClient.invalidateQueries({
        queryKey: ["cloudflare-tunnel-config", data.data.tunnelId],
      });
    },
    onError: (error) => {
      console.error("Failed to add hostname to tunnel:", error.message);
    },
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
    mutationFn: async ({ tunnelId, hostname, path }) => {
      // URL encode hostname to handle special characters
      const encodedHostname = encodeURIComponent(hostname);
      const params = new URLSearchParams();
      if (path) {
        params.set("path", path);
      }
      const queryString = params.toString() ? `?${params.toString()}` : "";

      const response = await fetch(
        `/api/settings/cloudflare/tunnels/${tunnelId}/hostnames/${encodedHostname}${queryString}`,
        {
          method: "DELETE",
          credentials: "include",
        },
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({
          message: "Failed to remove hostname from tunnel",
        }));
        throw new Error(
          errorData.details || errorData.message || "Failed to remove hostname",
        );
      }

      return response.json();
    },
    onSuccess: (data) => {
      // Invalidate tunnel-related queries to refresh the data
      queryClient.invalidateQueries({ queryKey: ["cloudflare-tunnels"] });
      queryClient.invalidateQueries({
        queryKey: ["cloudflare-tunnel", data.data.tunnelId],
      });
      queryClient.invalidateQueries({
        queryKey: ["cloudflare-tunnel-config", data.data.tunnelId],
      });
    },
    onError: (error) => {
      console.error("Failed to remove hostname from tunnel:", error.message);
    },
  });
}

// ====================
// Managed Tunnel Hooks
// ====================

// Hook for listing all managed tunnels across environments
export function useManagedTunnels() {
  return useQuery<ManagedTunnelListResponse>({
    queryKey: ["managed-tunnels"],
    queryFn: async () => {
      const response = await fetch("/api/settings/cloudflare/managed-tunnels", {
        credentials: "include",
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({
          message: "Failed to fetch managed tunnels",
        }));
        throw new Error(errorData.message || "Failed to fetch managed tunnels");
      }
      return response.json();
    },
    staleTime: 30000,
  });
}

// Hook for getting managed tunnel for a specific environment
export function useManagedTunnel(environmentId: string | undefined) {
  return useQuery<ManagedTunnelResponse>({
    queryKey: ["managed-tunnel", environmentId],
    queryFn: async () => {
      if (!environmentId) throw new Error("Environment ID is required");
      const response = await fetch(
        `/api/settings/cloudflare/managed-tunnels/${environmentId}`,
        { credentials: "include" },
      );
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({
          message: "Failed to fetch managed tunnel",
        }));
        throw new Error(errorData.message || "Failed to fetch managed tunnel");
      }
      return response.json();
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
    mutationFn: async ({ environmentId, name }) => {
      const response = await fetch(
        `/api/settings/cloudflare/managed-tunnels/${environmentId}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ name }),
        },
      );
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({
          error: "Failed to create managed tunnel",
        }));
        throw new Error(
          errorData.error || errorData.message || "Failed to create managed tunnel",
        );
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["managed-tunnels"] });
      queryClient.invalidateQueries({ queryKey: ["managed-tunnel"] });
      queryClient.invalidateQueries({ queryKey: ["cloudflare-tunnels"] });
      queryClient.invalidateQueries({ queryKey: ["stacks"] });
    },
  });
}

// Hook for deleting a managed tunnel
export function useDeleteManagedTunnel() {
  const queryClient = useQueryClient();

  return useMutation<{ success: boolean; message?: string }, Error, string>({
    mutationFn: async (environmentId: string) => {
      const response = await fetch(
        `/api/settings/cloudflare/managed-tunnels/${environmentId}`,
        {
          method: "DELETE",
          credentials: "include",
        },
      );
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({
          error: "Failed to delete managed tunnel",
        }));
        throw new Error(
          errorData.error || errorData.message || "Failed to delete managed tunnel",
        );
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["managed-tunnels"] });
      queryClient.invalidateQueries({ queryKey: ["managed-tunnel"] });
      queryClient.invalidateQueries({ queryKey: ["cloudflare-tunnels"] });
      queryClient.invalidateQueries({ queryKey: ["stacks"] });
    },
  });
}
