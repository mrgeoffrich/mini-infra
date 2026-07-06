/**
 * Hooks for the async Connect Container (Manual Frontend Setup) flow.
 *
 * - useStartConnectContainer() — fires the POST mutation, returns operationId
 * - useConnectContainerProgress() — wraps useOperationProgress for this flow
 */

import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Channel, ServerEvent, ApiRoute, queryKeys } from "@mini-infra/types";
import type { CreateManualFrontendRequest, StartConnectContainerResponse } from "@mini-infra/types";
import { useOperationProgress } from "./use-operation-progress";
import { apiFetch } from "@/lib/api-client";

// ====================
// API Function
// ====================

async function startConnectContainer(
  request: CreateManualFrontendRequest,
): Promise<StartConnectContainerResponse> {
  // The route replies with the full `{ success, data }` envelope (typed
  // directly into `StartConnectContainerResponse`) rather than the unwrapped
  // `data` — callers read `result.data.operationId` — so this stays raw.
  return apiFetch<StartConnectContainerResponse>(ApiRoute.haproxy.manualFrontends(), {
    method: "POST",
    body: request,
    correlationIdPrefix: "connect-container",
    unwrap: false,
  });
}

// ====================
// Hooks
// ====================

export function useStartConnectContainer() {
  return useMutation({
    mutationFn: startConnectContainer,
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });
}

export function useConnectContainerProgress(operationId: string | null, label?: string) {
  return useOperationProgress({
    channel: Channel.HAPROXY,
    startedEvent: ServerEvent.FRONTEND_SETUP_STARTED,
    stepEvent: ServerEvent.FRONTEND_SETUP_STEP,
    completedEvent: ServerEvent.FRONTEND_SETUP_COMPLETED,
    operationId,
    getOperationId: (p) => p.operationId,
    getTotalSteps: (p) => p.totalSteps,
    getStepNames: (p) => p.stepNames ?? [],
    getStep: (p) => p.step,
    getResult: (p) => ({ success: p.success, steps: p.steps, errors: p.errors }),
    invalidateKeys: [
      [...queryKeys.haproxy.frontends],
      [...queryKeys.haproxy.backends],
      [...queryKeys.containers.all],
    ],
    toasts: {
      success: "Container connected successfully",
      error: "Container connection failed",
    },
    tracker: {
      type: "connect-container",
      label: label ?? "Connecting container",
    },
  });
}
