import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  DockerVolume,
  DockerVolumeListResponse,
  DockerVolumeApiResponse,
  DockerVolumeDeleteResponse,
} from "@mini-infra/types";
import { toast } from "sonner";

const POLL_INTERVAL = 5000; // 5 seconds auto-refresh

// Generate correlation ID for debugging
function generateCorrelationId(): string {
  return `volumes-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

async function fetchVolumes(
  correlationId: string
): Promise<DockerVolumeListResponse> {
  const url = new URL(`/api/docker/volumes`, window.location.origin);

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

    throw new Error(`Failed to fetch volumes: ${response.statusText}`);
  }

  const data: DockerVolumeApiResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to fetch volumes");
  }

  return data.data;
}

async function deleteVolume(volumeName: string): Promise<DockerVolumeDeleteResponse> {
  const correlationId = `delete-volume-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

  const response = await fetch(`/api/docker/volumes/${encodeURIComponent(volumeName)}`, {
    method: "DELETE",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
    credentials: "include",
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.message || "Failed to delete volume");
  }

  return response.json();
}

export interface UseVolumesOptions {
  enabled?: boolean;
  refetchInterval?: number;
  retry?: number | boolean;
}

export function useVolumes(options: UseVolumesOptions = {}) {
  const {
    enabled = true,
    refetchInterval = POLL_INTERVAL,
    retry = 3,
  } = options;

  const correlationId = generateCorrelationId();

  return useQuery({
    queryKey: ["docker-volumes"],
    queryFn: () => fetchVolumes(correlationId),
    enabled,
    refetchInterval,
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

export interface UseDeleteVolumeOptions {
  onSuccess?: (volumeName: string) => void;
  onError?: (volumeName: string, error: Error) => void;
}

export function useDeleteVolume(options: UseDeleteVolumeOptions = {}) {
  const { onSuccess, onError } = options;
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (volumeName: string) => deleteVolume(volumeName),
    onSuccess: (data, volumeName) => {
      // Invalidate volumes query to refresh the list
      queryClient.invalidateQueries({ queryKey: ["docker-volumes"] });

      // Show success toast
      toast.success("Volume deleted successfully", {
        description: data.message,
      });

      // Call optional success callback
      if (onSuccess) {
        onSuccess(volumeName);
      }
    },
    onError: (error: Error, volumeName) => {
      // Show error toast
      toast.error("Failed to delete volume", {
        description: error.message,
      });

      // Call optional error callback
      if (onError) {
        onError(volumeName, error);
      }
    },
  });
}

// Type exports for convenience
export type { DockerVolume, DockerVolumeListResponse };
