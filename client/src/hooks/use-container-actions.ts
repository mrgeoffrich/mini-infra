import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ContainerAction, ContainerActionResponse } from "@mini-infra/types/containers";
import { toast } from "sonner";

interface UseContainerActionsOptions {
  containerId: string;
  onSuccess?: (action: ContainerAction) => void;
  onError?: (action: ContainerAction, error: Error) => void;
}

interface UseContainerActionsResult {
  startContainer: () => void;
  stopContainer: () => void;
  restartContainer: () => void;
  isStarting: boolean;
  isStopping: boolean;
  isRestarting: boolean;
  isPerformingAction: boolean;
}

function generateCorrelationId(): string {
  return `container-action-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

async function performContainerAction(
  containerId: string,
  action: ContainerAction
): Promise<ContainerActionResponse> {
  const response = await fetch(`/api/containers/${containerId}/${action}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-request-id": generateCorrelationId(),
    },
    credentials: "include",
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.message || `Failed to ${action} container`);
  }

  return response.json();
}

export function useContainerActions(options: UseContainerActionsOptions): UseContainerActionsResult {
  const { containerId, onSuccess, onError } = options;
  const queryClient = useQueryClient();

  const createMutation = (action: ContainerAction) =>
    useMutation({
      mutationFn: () => performContainerAction(containerId, action),
      onSuccess: (data) => {
        // Invalidate container queries to refresh the UI
        queryClient.invalidateQueries({ queryKey: ["containers"] });
        queryClient.invalidateQueries({ queryKey: ["container", containerId] });

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
        // Show error toast
        toast.error(`Failed to ${action} container`, {
          description: error.message,
        });

        // Call optional error callback
        if (onError) {
          onError(action, error);
        }
      },
    });

  const startMutation = createMutation("start");
  const stopMutation = createMutation("stop");
  const restartMutation = createMutation("restart");

  return {
    startContainer: () => startMutation.mutate(),
    stopContainer: () => stopMutation.mutate(),
    restartContainer: () => restartMutation.mutate(),
    isStarting: startMutation.isPending,
    isStopping: stopMutation.isPending,
    isRestarting: restartMutation.isPending,
    isPerformingAction:
      startMutation.isPending || stopMutation.isPending || restartMutation.isPending,
  };
}
