import React from "react";
import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import {
  DockerVolume,
  DockerVolumeListResponse,
  DockerVolumeDeleteResponse,
  VolumeInspection,
  VolumeInspectionStartResponse,
  VolumeFileContent,
  FetchFileContentsRequest,
  FetchFileContentsResponse,
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

async function fetchVolumes(): Promise<DockerVolumeListResponse> {
  try {
    return await apiFetch<DockerVolumeListResponse>(ApiRoute.docker.volumes(), {
      correlationIdPrefix: "volumes",
    });
  } catch (err) {
    // Docker-service-unavailable gets a friendlier fallback message than the
    // generic apiFetch one, since it surfaces directly in the volumes list UI.
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

async function deleteVolume(volumeName: string): Promise<DockerVolumeDeleteResponse> {
  // Flat response shape ({ success, message, volumeName } — no nested
  // `data`), so this stays raw rather than unwrapped.
  return apiFetch<DockerVolumeDeleteResponse>(ApiRoute.docker.volume(volumeName), {
    method: "DELETE",
    correlationIdPrefix: "delete-volume",
    unwrap: false,
  });
}

export interface UseVolumesOptions {
  enabled?: boolean;
  refetchInterval?: number;
  retry?: number | boolean;
}

export function useVolumes(options: UseVolumesOptions = {}) {
  const {
    enabled = true,
    retry = 3,
  } = options;

  const queryClient = useQueryClient();
  const { connected } = useSocket();

  // Subscribe to the volumes channel for push updates
  useSocketChannel(Channel.VOLUMES, enabled);

  // When server pushes a volumes update, invalidate to refetch
  useSocketEvent(
    ServerEvent.VOLUMES_LIST,
    () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.docker.volumes });
    },
    enabled,
  );

  // No polling when socket is connected; fall back to 5s when disconnected
  const refetchInterval =
    options.refetchInterval ?? (connected ? false : POLL_INTERVAL_DISCONNECTED);

  return useQuery({
    queryKey: queryKeys.docker.volumes,
    queryFn: fetchVolumes,
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
      queryClient.invalidateQueries({ queryKey: queryKeys.docker.volumes });

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
      // No local toast — the global `MutationCache.onError` (see
      // `client/src/lib/query-client.ts`) shows an actionable toast for
      // every mutation error by default (Phase 7 of
      // docs/planning/not-shipped/error-handling-overhaul-plan.md).
      if (onError) {
        onError(volumeName, error);
      }
    },
  });
}

// Volume inspection functions
async function startVolumeInspection(volumeName: string): Promise<VolumeInspectionStartResponse> {
  // Envelope preserved raw (not unwrapped) — callers of `startVolumeInspection`
  // via `useInspectVolume` were already typed against the full envelope.
  return apiFetch<VolumeInspectionStartResponse>(ApiRoute.docker.volumeInspect(volumeName), {
    method: "POST",
    correlationIdPrefix: "inspect-volume",
    unwrap: false,
  });
}

async function fetchVolumeInspection(
  volumeName: string,
): Promise<VolumeInspection | null> {
  // `data` is null when the volume has never been inspected. The list view
  // probes this on every row mount, so the route returns 200 with null
  // rather than 404 — apiFetch's default unwrap surfaces that null through.
  return apiFetch<VolumeInspection | null>(ApiRoute.docker.volumeInspect(volumeName), {
    correlationIdPrefix: "get-inspection",
  });
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
        queryKey: queryKeys.docker.volumeInspection(volumeName),
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
      // No local toast — the global `MutationCache.onError` (see
      // `client/src/lib/query-client.ts`) shows an actionable toast for
      // every mutation error by default (Phase 7 of
      // docs/planning/not-shipped/error-handling-overhaul-plan.md).
      if (onError) {
        onError(volumeName, error);
      }
    },
  });
}

export interface UseVolumeInspectionOptions {
  volumeName: string;
  enabled?: boolean;
  onComplete?: (inspection: VolumeInspection) => void;
}

export function useVolumeInspection(options: UseVolumeInspectionOptions) {
  const {
    volumeName,
    enabled = true,
    onComplete,
  } = options;

  const queryClient = useQueryClient();

  // Subscribe to the volumes channel for inspection push updates
  useSocketChannel(Channel.VOLUMES, enabled);

  // When server pushes inspection completed, invalidate the query to refetch
  useSocketEvent(
    ServerEvent.VOLUME_INSPECTION_COMPLETED,
    (data) => {
      if (data.volumeName === volumeName) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.docker.volumeInspection(volumeName),
        });
      }
    },
    enabled,
  );

  const query = useQuery({
    queryKey: queryKeys.docker.volumeInspection(volumeName),
    queryFn: () => fetchVolumeInspection(volumeName),
    enabled: enabled && !!volumeName,
    retry: (failureCount: number) => failureCount < 3,
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
  const requestBody: FetchFileContentsRequest = { filePaths };

  // Envelope preserved raw (not unwrapped) — `useFetchFileContents`'
  // onSuccess reads `result.data.{fetched,skipped,errors}`.
  return apiFetch<FetchFileContentsResponse>(ApiRoute.docker.volumeFilesFetch(volumeName), {
    method: "POST",
    body: requestBody,
    correlationIdPrefix: "fetch-file-contents",
    unwrap: false,
  });
}

async function fetchFileContent(
  volumeName: string,
  filePath: string,
): Promise<VolumeFileContent> {
  const url = new URL(ApiRoute.docker.volumeFiles(volumeName), window.location.origin);
  url.searchParams.set("path", filePath);

  return apiFetch<VolumeFileContent>(url.toString(), {
    correlationIdPrefix: "get-file-content",
  });
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
        queryKey: queryKeys.docker.volumeFileContent(volumeName),
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
      // No local toast — the global `MutationCache.onError` (see
      // `client/src/lib/query-client.ts`) shows an actionable toast for
      // every mutation error by default (Phase 7 of
      // docs/planning/not-shipped/error-handling-overhaul-plan.md).
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

  return useQuery({
    queryKey: queryKeys.docker.volumeFileContent(volumeName, filePath ?? undefined),
    queryFn: () => {
      if (!filePath) {
        throw new Error("File path is required");
      }
      return fetchFileContent(volumeName, filePath);
    },
    enabled: enabled && !!volumeName && !!filePath,
    retry: (failureCount: number, error: Error) => {
      // Don't retry on 404 (file content doesn't exist)
      if (error instanceof ApiRequestError && error.status === 404) {
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
