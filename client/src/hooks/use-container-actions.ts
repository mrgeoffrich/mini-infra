import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ContainerAction, ContainerActionResponse } from "@mini-infra/types/containers";
import { ApiRoute, queryKeys } from "@mini-infra/types";
import { toast } from "sonner";
import { apiFetch } from "@/lib/api-client";

interface UseContainerActionsOptions {
  containerId: string;
  onSuccess?: (action: ContainerAction) => void;
  onError?: (action: ContainerAction, error: Error) => void;
}

interface UseContainerActionsResult {
  startContainer: () => void;
  stopContainer: () => void;
  restartContainer: () => void;
  removeContainer: () => void;
  isStarting: boolean;
  isStopping: boolean;
  isRestarting: boolean;
  isRemoving: boolean;
  isPerformingAction: boolean;
}

/**
 * Query key for a single container's detail query. No registry builder
 * exists yet for this key (see Phase 4 report) — centralized here (rather
 * than inlined at each call site) so this hook and the container detail page
 * stay in sync until a `queryKeys.containers.detail(id)` builder is added.
 */
export function containerDetailKey(containerId: string) {
  return ["container", containerId] as const;
}

async function performContainerAction(
  containerId: string,
  action: ContainerAction
): Promise<ContainerActionResponse> {
  // Flat response shape ({ success, message, containerId, action, status } —
  // no nested `data`), so this stays raw rather than unwrapped.
  return apiFetch<ContainerActionResponse>(ApiRoute.containers.action(containerId, action), {
    method: "POST",
    correlationIdPrefix: "container-action",
    unwrap: false,
  });
}

export function useContainerActions(options: UseContainerActionsOptions): UseContainerActionsResult {
  const { containerId, onSuccess, onError } = options;
  const queryClient = useQueryClient();

  const buildMutationOptions = (action: ContainerAction) => ({
    mutationFn: () => performContainerAction(containerId, action),
    onSuccess: (data: ContainerActionResponse) => {
      // Invalidate container queries to refresh the UI
      queryClient.invalidateQueries({ queryKey: queryKeys.containers.all });
      queryClient.invalidateQueries({ queryKey: containerDetailKey(containerId) });

      // Show success toast
      toast.success(`Container ${action} successful`, {
        description: data.message,
      });

      // Call optional success callback
      if (onSuccess) {
        onSuccess(action);
      }
    },
    onError: (error: Error) => {
      // No local toast — the global `MutationCache.onError` (see
      // `client/src/lib/query-client.ts`) shows an actionable toast for
      // every mutation error by default (Phase 7 of
      // docs/planning/not-shipped/error-handling-overhaul-plan.md).
      if (onError) {
        onError(action, error);
      }
    },
  });

  const startMutation = useMutation(buildMutationOptions("start"));
  const stopMutation = useMutation(buildMutationOptions("stop"));
  const restartMutation = useMutation(buildMutationOptions("restart"));
  const removeMutation = useMutation(buildMutationOptions("remove"));

  return {
    startContainer: () => startMutation.mutate(),
    stopContainer: () => stopMutation.mutate(),
    restartContainer: () => restartMutation.mutate(),
    removeContainer: () => removeMutation.mutate(),
    isStarting: startMutation.isPending,
    isStopping: stopMutation.isPending,
    isRestarting: restartMutation.isPending,
    isRemoving: removeMutation.isPending,
    isPerformingAction:
      startMutation.isPending ||
      stopMutation.isPending ||
      restartMutation.isPending ||
      removeMutation.isPending,
  };
}
