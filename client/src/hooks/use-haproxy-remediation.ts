import { useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  HAProxyStatusResponse,
  RemediationPreviewResponse,
  RemediateHAProxyResponse,
  MigrationPreviewResponse,
  MigrationResultResponse,
  MigrationStep,
  MigrationResult,
  Channel,
  ServerEvent,
  ApiRoute,
  queryKeys,
} from "@mini-infra/types";
import { useSocket, useSocketChannel, useSocketEvent } from "./use-socket";
import { toast } from "sonner";
import { apiFetch, ApiRequestError } from "@/lib/api-client";

// ====================
// API Functions
// ====================
//
// These endpoints are enveloped (`{success, data, message?}`), but every
// existing consumer of these hooks (many outside this migration batch) reads
// the *whole* envelope off the query result (e.g. `statusResponse?.data`,
// `previewResponse?.data`). To avoid rippling type/shape changes into files
// outside this batch's scope, these functions keep returning the full
// envelope via `{ unwrap: false }` rather than letting `apiFetch` auto-
// unwrap to the inner `data` payload.

async function fetchHAProxyStatus(environmentId: string): Promise<HAProxyStatusResponse> {
  const data = await apiFetch<HAProxyStatusResponse>(
    ApiRoute.environments.haproxyStatus(environmentId),
    { correlationIdPrefix: "haproxy-remediation", unwrap: false },
  );

  if (!data.success) {
    throw new Error("Failed to fetch HAProxy status");
  }

  return data;
}

async function fetchRemediationPreview(
  environmentId: string,
): Promise<RemediationPreviewResponse> {
  const data = await apiFetch<RemediationPreviewResponse>(
    ApiRoute.environments.remediationPreview(environmentId),
    { correlationIdPrefix: "haproxy-remediation", unwrap: false },
  );

  if (!data.success) {
    throw new Error("Failed to fetch remediation preview");
  }

  return data;
}

async function remediateHAProxy(environmentId: string): Promise<RemediateHAProxyResponse> {
  const data = await apiFetch<RemediateHAProxyResponse>(
    ApiRoute.environments.remediateHaproxy(environmentId),
    { method: "POST", correlationIdPrefix: "haproxy-remediation", unwrap: false },
  );

  if (!data.success) {
    throw new Error(data.message || "Failed to remediate HAProxy");
  }

  return data;
}

// ====================
// Hooks
// ====================

export interface UseHAProxyRemediationOptions {
  enabled?: boolean;
  refetchInterval?: number;
}

/**
 * Hook to get HAProxy status for an environment
 */
export function useHAProxyStatus(
  environmentId: string | undefined,
  options: UseHAProxyRemediationOptions = {},
) {
  const { enabled = true, refetchInterval } = options;

  return useQuery({
    queryKey: queryKeys.environments.haproxyStatus(environmentId!),
    queryFn: () => fetchHAProxyStatus(environmentId!),
    enabled: enabled && !!environmentId,
    refetchInterval,
    retry: (failureCount: number, error: Error) => {
      // Don't retry on 404 or auth errors
      if (error instanceof ApiRequestError && (error.isAuth || error.status === 404)) {
        return false;
      }
      return failureCount < 3;
    },
    staleTime: 30000, // Data is fresh for 30 seconds
    gcTime: 5 * 60 * 1000, // Keep in cache for 5 minutes
  });
}

/**
 * Hook to get remediation preview for an environment
 */
export function useRemediationPreview(
  environmentId: string | undefined,
  options: UseHAProxyRemediationOptions = {},
) {
  const { enabled = true } = options;

  return useQuery({
    queryKey: queryKeys.environments.remediationPreview(environmentId!),
    queryFn: () => fetchRemediationPreview(environmentId!),
    enabled: enabled && !!environmentId,
    retry: (failureCount: number, error: Error) => {
      // Don't retry on certain errors
      if (error instanceof ApiRequestError) {
        if (error.isAuth || error.status === 404 || error.status === 503) {
          return false;
        }
      }
      if (error.message.includes("unavailable")) {
        return false;
      }
      return failureCount < 2;
    },
    staleTime: 10000, // Preview data is fresh for 10 seconds
    gcTime: 60 * 1000, // Keep in cache for 1 minute
  });
}

/**
 * Hook to trigger HAProxy remediation for an environment
 */
export function useRemediateHAProxy() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (environmentId: string) => remediateHAProxy(environmentId),
    onSuccess: (_, environmentId) => {
      // Invalidate related queries
      queryClient.invalidateQueries({ queryKey: queryKeys.environments.haproxyStatus(environmentId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.environments.remediationPreview(environmentId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.haproxy.frontends });
      queryClient.invalidateQueries({ queryKey: queryKeys.environments.detail(environmentId) });
    },
  });
}

// ====================
// Migration Hooks
// ====================

async function fetchMigrationPreview(environmentId: string): Promise<MigrationPreviewResponse> {
  const data = await apiFetch<MigrationPreviewResponse>(
    ApiRoute.environments.migrationPreview(environmentId),
    { correlationIdPrefix: "haproxy-migration", unwrap: false },
  );

  if (!data.success) {
    throw new Error("Failed to fetch migration preview");
  }

  return data;
}

async function migrateHAProxy(
  environmentId: string,
): Promise<{ success: boolean; data: { started: boolean; environmentId: string } }> {
  return apiFetch<{ success: boolean; data: { started: boolean; environmentId: string } }>(
    ApiRoute.environments.migrateHaproxy(environmentId),
    { method: "POST", correlationIdPrefix: "haproxy-migration", unwrap: false },
  );
}

/**
 * Hook to get migration preview for an environment
 */
export function useMigrationPreview(
  environmentId: string | undefined,
  options: UseHAProxyRemediationOptions = {},
) {
  const { enabled = true } = options;

  return useQuery({
    queryKey: queryKeys.environments.migrationPreview(environmentId!),
    queryFn: () => fetchMigrationPreview(environmentId!),
    enabled: enabled && !!environmentId,
    retry: 1,
    staleTime: 10000,
    gcTime: 60 * 1000,
  });
}

/**
 * Hook to trigger HAProxy migration (fire-and-forget, progress via Socket.IO)
 */
export function useMigrateHAProxy() {
  return useMutation({
    mutationFn: (environmentId: string) => migrateHAProxy(environmentId),
    // Errors are toasted by the global `MutationCache.onError` default
    // (client/src/lib/query-client.ts) via `toastApiError` — no hand-rolled
    // onError needed here.
  });
}

// ====================
// Migration Progress Hook (Socket.IO)
// ====================

export interface MigrationProgressState {
  isMigrating: boolean;
  totalSteps: number;
  completedSteps: MigrationStep[];
  finalResult: (MigrationResult & { environmentId: string }) | null;
}

const INITIAL_MIGRATION_STATE: MigrationProgressState = {
  isMigrating: false,
  totalSteps: 0,
  completedSteps: [],
  finalResult: null,
};

/**
 * Subscribe to Socket.IO events for live HAProxy migration progress.
 * Returns real-time state as each step completes.
 */
export function useMigrationProgress(environmentId: string) {
  const queryClient = useQueryClient();
  const { connected } = useSocket();
  const [state, setState] = useState<MigrationProgressState>(INITIAL_MIGRATION_STATE);

  // Subscribe to the stacks channel (migration events are emitted here)
  useSocketChannel(Channel.STACKS, !!environmentId);

  // Migration started
  useSocketEvent(
    ServerEvent.MIGRATION_STARTED,
    (data) => {
      if (data.environmentId !== environmentId) return;
      setState({
        isMigrating: true,
        totalSteps: data.totalSteps,
        completedSteps: [],
        finalResult: null,
      });
    },
    !!environmentId,
  );

  // Per-step progress
  useSocketEvent(
    ServerEvent.MIGRATION_STEP,
    (data) => {
      if (data.environmentId !== environmentId) return;
      setState((prev) => ({
        ...prev,
        totalSteps: data.totalSteps,
        completedSteps: [...prev.completedSteps, data.step],
      }));
    },
    !!environmentId,
  );

  // Migration completed
  useSocketEvent(
    ServerEvent.MIGRATION_COMPLETED,
    (data) => {
      if (data.environmentId !== environmentId) return;
      setState((prev) => ({
        ...prev,
        isMigrating: false,
        finalResult: data,
      }));
      // Invalidate related queries
      queryClient.invalidateQueries({ queryKey: queryKeys.environments.haproxyStatus(environmentId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.environments.migrationPreview(environmentId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.environments.remediationPreview(environmentId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.haproxy.frontends });
      queryClient.invalidateQueries({ queryKey: queryKeys.environments.detail(environmentId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.stacks.all });

      if (data.success) {
        toast.success("HAProxy migration completed successfully");
      } else {
        toast.error("HAProxy migration completed with errors");
      }
    },
    !!environmentId,
  );

  const reset = useCallback(() => setState(INITIAL_MIGRATION_STATE), []);

  return { ...state, connected, reset };
}

// ====================
// Type Exports
// ====================

export type {
  HAProxyStatusResponse,
  RemediationPreviewResponse,
  RemediateHAProxyResponse,
  MigrationPreviewResponse,
  MigrationResultResponse,
  MigrationStep,
};
