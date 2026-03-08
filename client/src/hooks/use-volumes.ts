import React from "react";
import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import {
  DockerVolume,
  DockerVolumeListResponse,
  DockerVolumeApiResponse,
  DockerVolumeDeleteResponse,
  VolumeInspection,
  VolumeInspectionResponse,
  VolumeInspectionStartResponse,
  VolumeFileContent,
  FetchFileContentsRequest,
  FetchFileContentsResponse,
  VolumeFileContentResponse,
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

// Volume inspection functions
async function startVolumeInspection(volumeName: string): Promise<VolumeInspectionStartResponse> {
  const correlationId = `inspect-volume-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

  const response = await fetch(`/api/docker/volumes/${encodeURIComponent(volumeName)}/inspect`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
    credentials: "include",
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.message || "Failed to start volume inspection");
  }

  return response.json();
}

async function fetchVolumeInspection(
  volumeName: string,
  correlationId: string
): Promise<VolumeInspection> {
  const response = await fetch(
    `/api/docker/volumes/${encodeURIComponent(volumeName)}/inspect`,
    {
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "X-Correlation-ID": correlationId,
      },
    }
  );

  if (!response.ok) {
    if (response.status === 404) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || "Inspection not found");
    }
    throw new Error(`Failed to fetch inspection: ${response.statusText}`);
  }

  const data: VolumeInspectionResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to fetch inspection");
  }

  return data.data;
}

export interface UseInspectVolumeOptions {
  onSuccess?: (volumeName: string) => void;
  onError?: (volumeName: string, error: Error) => void;
}

export function useInspectVolume(options: UseInspectVolumeOptions = {}) {
  const { onSuccess, onError } = options;
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (volumeName: string) => startVolumeInspection(volumeName),
    onSuccess: (_data, volumeName) => {
      // Invalidate inspection query to start polling
      queryClient.invalidateQueries({
        queryKey: ["volume-inspection", volumeName]
      });

      // Show success toast
      toast.success("Volume inspection started", {
        description: `Scanning files in volume '${volumeName}'...`,
      });

      // Call optional success callback
      if (onSuccess) {
        onSuccess(volumeName);
      }
    },
    onError: (error: Error, volumeName) => {
      // Show error toast
      toast.error("Failed to start inspection", {
        description: error.message,
      });

      // Call optional error callback
      if (onError) {
        onError(volumeName, error);
      }
    },
  });
}

export interface UseVolumeInspectionOptions {
  volumeName: string;
  enabled?: boolean;
  refetchInterval?: number | false;
  onComplete?: (inspection: VolumeInspection) => void;
}

export function useVolumeInspection(options: UseVolumeInspectionOptions) {
  const {
    volumeName,
    enabled = true,
    refetchInterval,
    onComplete,
  } = options;

  const correlationId = `get-inspection-${volumeName}-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

  const query = useQuery({
    queryKey: ["volume-inspection", volumeName],
    queryFn: () => fetchVolumeInspection(volumeName, correlationId),
    enabled: enabled && !!volumeName,
    // Auto-refresh while inspection is running
    refetchInterval: (query) => {
      const data = query.state.data;
      // If inspection is running, poll every 2 seconds
      if (data?.status === "running" || data?.status === "pending") {
        return refetchInterval !== undefined ? refetchInterval : 2000;
      }
      // Stop polling once completed or failed
      return false;
    },
    retry: (failureCount: number, error: Error) => {
      // Don't retry on 404 (inspection doesn't exist yet)
      if (error.message.includes("Inspection not found")) {
        return false;
      }
      // Retry up to 3 times for other errors
      return failureCount < 3;
    },
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 10000),
    staleTime: 1000,
    gcTime: 5 * 60 * 1000,
  });

  // Call onComplete callback when inspection completes
  const previousStatus = React.useRef(query.data?.status);
  React.useEffect(() => {
    if (query.data) {
      const currentStatus = query.data.status;

      // Check if status changed to completed
      if (
        previousStatus.current !== "completed" &&
        currentStatus === "completed" &&
        onComplete
      ) {
        onComplete(query.data);
        toast.success("Volume inspection completed", {
          description: `Found ${query.data.fileCount} files in '${volumeName}'`,
        });
      }

      // Check if status changed to failed
      if (
        previousStatus.current !== "failed" &&
        currentStatus === "failed"
      ) {
        toast.error("Volume inspection failed", {
          description: query.data.errorMessage || "An error occurred during inspection",
        });
      }

      previousStatus.current = currentStatus;
    }
  }, [query.data, volumeName, onComplete]);

  return query;
}

// ====================
// File Content Hooks
// ====================

async function fetchFileContents(
  volumeName: string,
  filePaths: string[]
): Promise<FetchFileContentsResponse> {
  const correlationId = `fetch-file-contents-${volumeName}-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

  const requestBody: FetchFileContentsRequest = { filePaths };

  const response = await fetch(`/api/docker/volumes/${encodeURIComponent(volumeName)}/files/fetch`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
    credentials: "include",
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.message || "Failed to fetch file contents");
  }

  return response.json();
}

async function fetchFileContent(
  volumeName: string,
  filePath: string,
  correlationId: string
): Promise<VolumeFileContent> {
  const url = new URL(
    `/api/docker/volumes/${encodeURIComponent(volumeName)}/files`,
    window.location.origin
  );
  url.searchParams.set("path", filePath);

  const response = await fetch(url.toString(), {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    if (response.status === 404) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || "File content not found");
    }
    throw new Error(`Failed to fetch file content: ${response.statusText}`);
  }

  const data: VolumeFileContentResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to fetch file content");
  }

  return data.data;
}

export interface UseFetchFileContentsOptions {
  onSuccess?: (volumeName: string, result: FetchFileContentsResponse) => void;
  onError?: (volumeName: string, error: Error) => void;
}

export function useFetchFileContents(volumeName: string, options: UseFetchFileContentsOptions = {}) {
  const { onSuccess, onError } = options;
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (filePaths: string[]) => fetchFileContents(volumeName, filePaths),
    onSuccess: (result) => {
      // Invalidate file content queries
      queryClient.invalidateQueries({
        queryKey: ["volume-file-content", volumeName],
      });

      // Show success toast
      const successMsg = result.data.errors.length > 0
        ? `Fetched ${result.data.fetched} file(s), skipped ${result.data.skipped}, ${result.data.errors.length} error(s)`
        : `Fetched ${result.data.fetched} file(s), skipped ${result.data.skipped}`;

      toast.success("File contents fetched", {
        description: successMsg,
      });

      // Call optional success callback
      if (onSuccess) {
        onSuccess(volumeName, result);
      }
    },
    onError: (error: Error) => {
      // Show error toast
      toast.error("Failed to fetch file contents", {
        description: error.message,
      });

      // Call optional error callback
      if (onError) {
        onError(volumeName, error);
      }
    },
  });
}

export interface UseFileContentOptions {
  volumeName: string;
  filePath: string | null;
  enabled?: boolean;
}

export function useFileContent(options: UseFileContentOptions) {
  const { volumeName, filePath, enabled = true } = options;

  const correlationId = `get-file-content-${volumeName}-${filePath}-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

  return useQuery({
    queryKey: ["volume-file-content", volumeName, filePath],
    queryFn: () => {
      if (!filePath) {
        throw new Error("File path is required");
      }
      return fetchFileContent(volumeName, filePath, correlationId);
    },
    enabled: enabled && !!volumeName && !!filePath,
    retry: (failureCount: number, error: Error) => {
      // Don't retry on 404 (file content doesn't exist)
      if (error.message.includes("File content not found")) {
        return false;
      }
      // Retry up to 3 times for other errors
      return failureCount < 3;
    },
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 10000),
    staleTime: 5 * 60 * 1000, // 5 minutes
    gcTime: 10 * 60 * 1000, // 10 minutes
  });
}

// Type exports for convenience
export type { DockerVolume, DockerVolumeListResponse, VolumeInspection, VolumeFileContent };
