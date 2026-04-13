import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { toast } from "sonner";
import { Channel, ServerEvent } from "@mini-infra/types";
import type { SelfUpdateStatus, SelfUpdateCheckResult } from "@mini-infra/types";
import { useOperationProgress } from "./use-operation-progress";

export type { SelfUpdateStatus, SelfUpdateCheckResult };

interface SelfUpdateLocalState {
  updateInProgress: boolean;
  targetTag: string;
  triggeredAt: string;
  updateId: string;
}

const LOCAL_STORAGE_KEY = "mini-infra:self-update";

// ---------------------------------------------------------------------------
// localStorage helpers
// ---------------------------------------------------------------------------

function getLocalUpdateState(): SelfUpdateLocalState | null {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (!raw) return null;
    const state = JSON.parse(raw) as SelfUpdateLocalState;

    // Expire after 5 minutes
    const triggeredAt = new Date(state.triggeredAt).getTime();
    if (Date.now() - triggeredAt > 5 * 60 * 1000) {
      localStorage.removeItem(LOCAL_STORAGE_KEY);
      return null;
    }

    return state;
  } catch {
    return null;
  }
}

function setLocalUpdateState(state: SelfUpdateLocalState): void {
  localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(state));
}

function clearLocalUpdateState(): void {
  localStorage.removeItem(LOCAL_STORAGE_KEY);
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/**
 * Fetches the current self-update status from the server.
 * Polls every 3s when an update is active.
 */
export function useSelfUpdateStatus() {
  const localState = getLocalUpdateState();

  const query = useQuery<{ success: boolean; status: SelfUpdateStatus }>({
    queryKey: ["self-update-status"],
    queryFn: async () => {
      const res = await fetch("/api/self-update/status");
      if (!res.ok) throw new Error("Failed to fetch update status");
      return res.json();
    },
    refetchInterval: (query) => {
      const state = query.state.data?.status?.state;
      if (!state) return false;
      // Poll while an update is in progress
      if (
        state !== "idle" &&
        state !== "complete" &&
        state !== "rollback-complete" &&
        state !== "failed"
      ) {
        return 3000;
      }
      return false;
    },
    refetchOnReconnect: true,
    retry: true,
    retryDelay: 2000,
  });

  // Clear localStorage when we get a terminal state from the server
  useEffect(() => {
    const state = query.data?.status?.state;
    if (
      state === "complete" ||
      state === "rollback-complete" ||
      state === "failed" ||
      state === "idle"
    ) {
      clearLocalUpdateState();
    }
  }, [query.data?.status?.state]);

  return {
    ...query,
    localUpdateInProgress: localState?.updateInProgress ?? false,
    localTargetTag: localState?.targetTag,
  };
}

/**
 * Checks if self-update is available (running in Docker, configured).
 */
export function useSelfUpdateCheck() {
  return useMutation<SelfUpdateCheckResult>({
    mutationFn: async () => {
      const res = await fetch("/api/self-update/check", { method: "POST" });
      if (!res.ok) throw new Error("Failed to check update availability");
      return res.json();
    },
  });
}

/**
 * Triggers a self-update to the specified tag.
 * Returns an operationId for tracking the sidecar launch via Socket.IO.
 * Stores state in localStorage so the UI survives a browser refresh.
 */
export function useTriggerUpdate() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: { targetTag: string }) => {
      const res = await fetch("/api/self-update/trigger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetTag: params.targetTag }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to trigger update");
      }
      return res.json() as Promise<{
        success: boolean;
        updateId: string;
        operationId: string;
        targetTag: string;
      }>;
    },
    onSuccess: (data) => {
      setLocalUpdateState({
        updateInProgress: true,
        targetTag: data.targetTag,
        triggeredAt: new Date().toISOString(),
        updateId: data.updateId,
      });
      queryClient.invalidateQueries({ queryKey: ["self-update-status"] });
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });
}

/**
 * Tracks the sidecar launch phase (pull + create + start) via Socket.IO.
 * This covers only the launch; the actual update is tracked via polling.
 */
export function useSelfUpdateLaunchProgress(operationId: string | null, label?: string) {
  return useOperationProgress({
    channel: Channel.SELF_UPDATE,
    startedEvent: ServerEvent.SELF_UPDATE_LAUNCH_STARTED,
    stepEvent: ServerEvent.SELF_UPDATE_LAUNCH_STEP,
    completedEvent: ServerEvent.SELF_UPDATE_LAUNCH_COMPLETED,
    operationId,
    getOperationId: (p) => p.operationId,
    getTotalSteps: (p) => p.totalSteps,
    getStepNames: (p) => p.stepNames ?? [],
    getStep: (p) => p.step,
    getResult: (p) => ({ success: p.success, steps: p.steps, errors: p.errors }),
    invalidateKeys: [["self-update-status"]],
    toasts: {
      success: "Update sidecar launched — server will restart shortly",
      error: "Failed to launch update sidecar",
    },
    tracker: {
      type: "self-update-launch",
      label: label ?? "Launching update sidecar",
    },
  });
}

/**
 * Returns true if the UI should show the "updating..." overlay.
 * This accounts for both server-reported state and localStorage fallback.
 */
export function useIsUpdateActive(): {
  isActive: boolean;
  targetTag?: string;
  state?: SelfUpdateStatus["state"];
  progress?: number;
  error?: string;
  isReconnecting: boolean;
} {
  const { data, isError, isLoading, localUpdateInProgress, localTargetTag } =
    useSelfUpdateStatus();

  const serverState = data?.status?.state;
  const isTerminal =
    serverState === "idle" ||
    serverState === "complete" ||
    serverState === "rollback-complete" ||
    serverState === "failed";

  // Server says update is in progress
  if (serverState && !isTerminal) {
    return {
      isActive: true,
      targetTag: data?.status?.targetTag,
      state: serverState,
      progress: data?.status?.progress,
      isReconnecting: false,
    };
  }

  // Server is unreachable (or still loading) but localStorage says we
  // triggered an update recently — show the "Updating..." overlay
  // immediately instead of a loading skeleton or error page.
  if ((isError || isLoading) && localUpdateInProgress) {
    return {
      isActive: true,
      targetTag: localTargetTag,
      state: "stopping",
      isReconnecting: true,
    };
  }

  // Terminal states
  return {
    isActive: false,
    state: serverState,
    targetTag: data?.status?.targetTag,
    error: data?.status?.error,
    isReconnecting: false,
  };
}
