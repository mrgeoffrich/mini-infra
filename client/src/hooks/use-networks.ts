import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import {
  DockerNetwork,
  DockerNetworkListResponse,
  DockerNetworkApiResponse,
  DockerNetworkDeleteResponse,
  Channel,
  ServerEvent,
} from "@mini-infra/types";
import { toast } from "sonner";
import { useSocket, useSocketChannel, useSocketEvent } from "./use-socket";

const POLL_INTERVAL_DISCONNECTED = 5000; // 5s fallback when socket not connected

// Generate correlation ID for debugging
function generateCorrelationId(): string {
  return `networks-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

async function fetchNetworks(
  correlationId: string
): Promise<DockerNetworkListResponse> {
  const url = new URL(`/api/docker/networks`, window.location.origin);

  const response = await fetch(url.toString(), {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    if (response.status === 503) {
      try {
        const errorData = await response.json();
        throw new Error(errorData.message || "Docker service is not available");
      } catch {
        throw new Error(
          "Docker service is not available. Please try again later."
        );
      }
    }

    throw new Error(`Failed to fetch networks: ${response.statusText}`);
  }

  const data: DockerNetworkApiResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to fetch networks");
  }

  return data.data;
}

async function deleteNetwork(networkId: string): Promise<DockerNetworkDeleteResponse> {
  const correlationId = `delete-network-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

  const response = await fetch(`/api/docker/networks/${networkId}`, {
    method: "DELETE",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
    credentials: "include",
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.message || "Failed to delete network");
  }

  return response.json();
}

export interface UseNetworksOptions {
  enabled?: boolean;
  refetchInterval?: number;
  retry?: number | boolean;
}

export function useNetworks(options: UseNetworksOptions = {}) {
  const {
    enabled = true,
    retry = 3,
  } = options;

  const queryClient = useQueryClient();
  const { connected } = useSocket();
  const correlationId = generateCorrelationId();

  // Subscribe to the networks channel for push updates
  useSocketChannel(Channel.NETWORKS, enabled);

  // When server pushes a networks update, invalidate to refetch
  useSocketEvent(
    ServerEvent.NETWORKS_LIST,
    () => {
      queryClient.invalidateQueries({ queryKey: ["docker-networks"] });
    },
    enabled,
  );

  // No polling when socket is connected; fall back to 5s when disconnected
  const refetchInterval =
    options.refetchInterval ?? (connected ? false : POLL_INTERVAL_DISCONNECTED);

  return useQuery({
    queryKey: ["docker-networks"],
    queryFn: () => fetchNetworks(correlationId),
    enabled,
    refetchInterval,
    placeholderData: keepPreviousData,
    retry: (failureCount: number, error: Error) => {
      // Don't retry on authentication errors
      if (
        error.message.includes("401") ||
        error.message.includes("Unauthorized")
      ) {
        return false;
      }

      // Don't retry immediately on Docker service unavailable
      if (
        error.message.includes("Docker service is not available") ||
        error.message.includes("Service Unavailable")
      ) {
        return false;
      }

      // Retry up to the specified number of times for other errors
      return typeof retry === "boolean" ? retry : failureCount < retry;
    },
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),
    staleTime: 2000,
    gcTime: 5 * 60 * 1000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

export interface UseDeleteNetworkOptions {
  onSuccess?: (networkId: string) => void;
  onError?: (networkId: string, error: Error) => void;
}

export function useDeleteNetwork(options: UseDeleteNetworkOptions = {}) {
  const { onSuccess, onError } = options;
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (networkId: string) => deleteNetwork(networkId),
    onSuccess: (data, networkId) => {
      // Invalidate networks query to refresh the list
      queryClient.invalidateQueries({ queryKey: ["docker-networks"] });

      // Show success toast
      toast.success("Network deleted successfully", {
        description: data.message,
      });

      // Call optional success callback
      if (onSuccess) {
        onSuccess(networkId);
      }
    },
    onError: (error: Error, networkId) => {
      // Show error toast
      toast.error("Failed to delete network", {
        description: error.message,
      });

      // Call optional error callback
      if (onError) {
        onError(networkId, error);
      }
    },
  });
}

// Type exports for convenience
export type { DockerNetwork, DockerNetworkListResponse };
