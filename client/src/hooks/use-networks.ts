import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import {
  DockerNetwork,
  DockerNetworkListResponse,
  DockerNetworkDeleteResponse,
  Channel,
  ServerEvent,
  ApiRoute,
  queryKeys,
} from "@mini-infra/types";
import { toast } from "sonner";
import { useSocket, useSocketChannel, useSocketEvent } from "./use-socket";
import { apiFetch, ApiRequestError } from "@/lib/api-client";

const POLL_INTERVAL_DISCONNECTED = 5000; // 5s fallback when socket not connected

/** Best-effort extraction of a `.message` string off an unknown error body. */
function extractBodyMessage(body: unknown): string | undefined {
  if (typeof body === "object" && body !== null && "message" in body) {
    const message = (body as { message?: unknown }).message;
    return typeof message === "string" && message.length > 0 ? message : undefined;
  }
  return undefined;
}

async function fetchNetworks(): Promise<DockerNetworkListResponse> {
  try {
    return await apiFetch<DockerNetworkListResponse>(ApiRoute.docker.networks(), {
      correlationIdPrefix: "networks",
    });
  } catch (err) {
    // Docker-service-unavailable gets a friendlier fallback message than the
    // generic apiFetch one, since it surfaces directly in the networks list UI.
    // Re-thrown as an ApiRequestError (not a plain Error) so the `retry`
    // callback below can still branch on `.status`.
    if (err instanceof ApiRequestError && err.status === 503) {
      throw new ApiRequestError(
        err.status,
        err.code,
        extractBodyMessage(err.body) ??
          "Docker service is not available. Please try again later.",
        err.body,
      );
    }
    throw err;
  }
}

async function deleteNetwork(networkId: string): Promise<DockerNetworkDeleteResponse> {
  return apiFetch<DockerNetworkDeleteResponse>(ApiRoute.docker.network(networkId), {
    method: "DELETE",
    correlationIdPrefix: "delete-network",
    unwrap: false,
  });
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

  // Subscribe to the networks channel for push updates
  useSocketChannel(Channel.NETWORKS, enabled);

  // When server pushes a networks update, invalidate to refetch
  useSocketEvent(
    ServerEvent.NETWORKS_LIST,
    () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.docker.networks });
    },
    enabled,
  );

  // No polling when socket is connected; fall back to 5s when disconnected
  const refetchInterval =
    options.refetchInterval ?? (connected ? false : POLL_INTERVAL_DISCONNECTED);

  return useQuery({
    queryKey: queryKeys.docker.networks,
    queryFn: fetchNetworks,
    enabled,
    refetchInterval,
    placeholderData: keepPreviousData,
    retry: (failureCount: number, error: Error) => {
      if (error instanceof ApiRequestError) {
        // Don't retry on authentication errors
        if (error.isAuth) {
          return false;
        }

        // Don't retry immediately on Docker service unavailable
        if (error.status === 503) {
          return false;
        }
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
      queryClient.invalidateQueries({ queryKey: queryKeys.docker.networks });

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
