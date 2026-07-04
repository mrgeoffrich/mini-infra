import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import {
  DockerNetwork,
  DockerNetworkListResponse,
  DockerNetworkDeleteResponse,
  ManagedNetworkListResponse,
  ManagedNetworkView,
  DockerNetworkGcResponse,
  DockerNetworkGcReport,
  NetworkConvergeResponse,
  NetworkConvergeResult,
  SetNetworkEnforceMembershipsResponse,
  ManagedNetworkSummary,
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

// ====================
// Managed Networks (network overhaul Phase 9 — visibility UI)
// ====================
//
// Everything below reads/mutates the desired-state `ManagedNetwork`/
// `NetworkMembership` rows (Phases 5-8) rather than raw Docker networks —
// owner, purpose, drift status, and the full desired-vs-actual membership
// table with per-membership source/creator.

export interface ManagedNetworkFilter {
  scope?: "host" | "environment" | "stack";
  environmentId?: string;
  stackId?: string;
}

function buildManagedNetworksUrl(filter: ManagedNetworkFilter = {}): string {
  const url = new URL(ApiRoute.docker.networksManaged(), window.location.origin);
  if (filter.scope) url.searchParams.set("scope", filter.scope);
  if (filter.environmentId) url.searchParams.set("environmentId", filter.environmentId);
  if (filter.stackId) url.searchParams.set("stackId", filter.stackId);
  return url.toString();
}

async function fetchManagedNetworks(filter: ManagedNetworkFilter): Promise<ManagedNetworkView[]> {
  const response = await apiFetch<ManagedNetworkListResponse>(buildManagedNetworksUrl(filter), {
    correlationIdPrefix: "managed-networks",
    unwrap: false,
  });
  return response.data;
}

export interface UseManagedNetworksOptions {
  enabled?: boolean;
  refetchInterval?: number;
}

/**
 * Lists `ManagedNetwork` rows (owner, purpose, status, desired-vs-actual
 * members with per-membership source/creator), optionally filtered by
 * scope/environmentId/stackId. Backs the networks tab's managed-network
 * view, the environment detail networks panel, and the application detail
 * connected-networks list.
 */
export function useManagedNetworks(
  filter: ManagedNetworkFilter = {},
  options: UseManagedNetworksOptions = {},
) {
  const { enabled = true } = options;
  const queryClient = useQueryClient();
  const { connected } = useSocket();

  // Managed networks don't have a dedicated socket channel of their own —
  // reuse the existing raw-networks channel, which already fires on every
  // connect/disconnect/create/remove, so a stack apply or reconcile action
  // elsewhere in the app refreshes this view too.
  useSocketChannel(Channel.NETWORKS, enabled);
  useSocketEvent(
    ServerEvent.NETWORKS_LIST,
    () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.docker.managedNetworksAll });
    },
    enabled,
  );

  const refetchInterval =
    options.refetchInterval ?? (connected ? false : POLL_INTERVAL_DISCONNECTED);

  return useQuery({
    queryKey: queryKeys.docker.managedNetworks(filter),
    queryFn: () => fetchManagedNetworks(filter),
    enabled,
    refetchInterval,
    staleTime: 2000,
    gcTime: 5 * 60 * 1000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

async function runNetworkGc(dryRun: boolean): Promise<DockerNetworkGcReport> {
  const response = await apiFetch<DockerNetworkGcResponse>(ApiRoute.docker.networksGc(), {
    method: "POST",
    body: { dryRun },
    correlationIdPrefix: "network-gc",
    unwrap: false,
  });
  return response.data;
}

/** Label-driven GC sweep (Phase 4) — dry-run by default; pass `false` to actually remove orphaned managed networks. */
export function useNetworkGc() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (dryRun: boolean) => runNetworkGc(dryRun),
    onSuccess: (report) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.docker.managedNetworksAll });
      queryClient.invalidateQueries({ queryKey: queryKeys.docker.networks });
      if (report.dryRun) {
        toast.info(
          report.orphans.length === 0
            ? "No orphaned networks found"
            : `Found ${report.orphans.length} orphaned network(s) (dry run — none removed)`,
        );
      } else {
        toast.success(
          report.removedCount === 0
            ? "No orphaned networks needed removal"
            : `Removed ${report.removedCount} orphaned network(s)`,
        );
      }
    },
    onError: (error: Error) => {
      toast.error("Network GC failed", { description: error.message });
    },
  });
}

export type NetworkReconcileScopeInput =
  | { scope: "all" }
  | { scope: "environment"; environmentId: string }
  | { scope: "stack"; stackId: string };

async function runNetworkConverge(input: NetworkReconcileScopeInput): Promise<NetworkConvergeResult> {
  const response = await apiFetch<NetworkConvergeResponse>(ApiRoute.docker.networksReconcile(), {
    method: "POST",
    body: input,
    correlationIdPrefix: "network-reconcile-converge",
    unwrap: false,
  });
  return response.data;
}

/** Manual reconcile trigger (Phase 8 convergence) — connects missing memberships (and disconnects stale ones only where a network's `enforceMemberships` is already true). */
export function useReconcileNetworks() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: NetworkReconcileScopeInput) => runNetworkConverge(input),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.docker.managedNetworksAll });
      queryClient.invalidateQueries({ queryKey: queryKeys.docker.networks });
      const parts: string[] = [];
      if (result.networksCreated > 0) parts.push(`${result.networksCreated} network(s) created`);
      if (result.membershipsConnected > 0) parts.push(`${result.membershipsConnected} membership(s) reconnected`);
      if (result.membershipsDisconnected > 0) parts.push(`${result.membershipsDisconnected} stale membership(s) disconnected`);
      toast.success(parts.length > 0 ? `Reconciled: ${parts.join(", ")}` : "Already in sync — nothing to reconcile");
    },
    onError: (error: Error) => {
      toast.error("Network reconcile failed", { description: error.message });
    },
  });
}

async function setNetworkEnforceMemberships(input: {
  name: string;
  enforceMemberships: boolean;
}): Promise<ManagedNetworkSummary> {
  const response = await apiFetch<SetNetworkEnforceMembershipsResponse>(
    ApiRoute.docker.networksEnforceMemberships(),
    {
      method: "PATCH",
      body: input,
      correlationIdPrefix: "network-enforce-memberships",
      unwrap: false,
    },
  );
  return response.data;
}

/** Toggles a single managed network's `enforceMemberships` gate — operator-driven, defaults to false everywhere (see Phase 8). */
export function useSetNetworkEnforceMemberships() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: setNetworkEnforceMemberships,
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.docker.managedNetworksAll });
      toast.success(
        data.enforceMemberships
          ? `Enforcement enabled for "${data.name}" — stale attachments will now be disconnected`
          : `Enforcement disabled for "${data.name}"`,
      );
    },
    onError: (error: Error) => {
      toast.error("Failed to update enforcement setting", { description: error.message });
    },
  });
}
