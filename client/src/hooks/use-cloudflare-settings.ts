import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CloudflareSettingResponse,
  ConnectivityStatusInfo,
  CloudflareTunnelInfo,
  CloudflareTunnelConfig,
  CloudflareAddHostnameRequest,
  CloudflareHostnameResponse,
} from "@mini-infra/types";
import { Channel, ServerEvent } from "@mini-infra/types";
import { useSocket, useSocketChannel, useSocketEvent } from "./use-socket";

interface UpdateCloudflareSettingsPayload {
  api_token: string;
  account_id?: string;
  encrypt?: boolean;
}

interface TestConnectionResponse {
  success: boolean;
  message?: string;
  details?: {
    user?: {
      email?: string;
      id?: string;
    };
    account?: {
      name?: string;
      id?: string;
    };
  };
}

interface ConnectivityResponse {
  success: boolean;
  data?: ConnectivityStatusInfo;
  message?: string;
}

interface ConnectivityHistoryResponse {
  success: boolean;
  data?: ConnectivityStatusInfo[];
  pagination?: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
  message?: string;
}

interface TunnelsResponse {
  success: boolean;
  data?: {
    tunnels: CloudflareTunnelInfo[];
    tunnelCount: number;
  };
  message?: string;
}

interface TunnelDetailsResponse {
  success: boolean;
  tunnel?: CloudflareTunnelInfo;
  message?: string;
}

interface TunnelConfigResponse {
  success: boolean;
  data?: CloudflareTunnelConfig;
  message?: string;
}

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
    UpdateCloudflareSettingsPayload
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

// Hook for testing Cloudflare connection
export function useTestCloudflareConnection() {
  const queryClient = useQueryClient();

  return useMutation<TestConnectionResponse, Error>({
    mutationFn: async () => {
      const response = await fetch("/api/settings/cloudflare/test", {
        method: "POST",
        credentials: "include",
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({
          message: "Failed to test Cloudflare connection",
        }));
        throw new Error(errorData.message || "Connection test failed");
      }

      return response.json();
    },
    onSuccess: () => {
      // Invalidate connectivity status after successful test
      queryClient.invalidateQueries({ queryKey: ["cloudflare-connectivity"] });
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

  return useQuery<ConnectivityResponse>({
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

// Hook for retrieving Cloudflare connectivity history
export function useCloudflareConnectivityHistory(
  page: number = 1,
  pageSize: number = 20,
) {
  return useQuery<ConnectivityHistoryResponse>({
    queryKey: ["cloudflare-connectivity-history", page, pageSize],
    queryFn: async () => {
      const params = new URLSearchParams({
        page: page.toString(),
        pageSize: pageSize.toString(),
      });

      const response = await fetch(
        `/api/connectivity/cloudflare/history?${params}`,
        {
          credentials: "include",
        },
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({
          message: "Failed to fetch connectivity history",
        }));
        throw new Error(errorData.message || "Failed to fetch history");
      }

      return response.json();
    },
    staleTime: 30000, // 30 seconds
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

  return useQuery<TunnelsResponse>({
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

// Hook for retrieving specific tunnel details
export function useCloudfareTunnelDetails(tunnelId: string | undefined) {
  return useQuery<TunnelDetailsResponse>({
    queryKey: ["cloudflare-tunnel", tunnelId],
    queryFn: async () => {
      if (!tunnelId) {
        throw new Error("Tunnel ID is required");
      }

      const response = await fetch(
        `/api/settings/cloudflare/tunnels/${tunnelId}`,
        {
          credentials: "include",
        },
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({
          message: "Failed to fetch tunnel details",
        }));
        throw new Error(errorData.message || "Failed to fetch tunnel");
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

// Hook for retrieving tunnel configuration
export function useCloudfareTunnelConfig(tunnelId: string | undefined) {
  return useQuery<TunnelConfigResponse>({
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
