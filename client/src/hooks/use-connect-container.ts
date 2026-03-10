/**
 * Hooks for the async Connect Container (Manual Frontend Setup) flow.
 *
 * - useStartConnectContainer() — fires the POST mutation, returns operationId
 * - useConnectContainerProgress() — wraps useOperationProgress for this flow
 */

import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Channel, ServerEvent } from "@mini-infra/types";
import type { CreateManualFrontendRequest } from "@mini-infra/types";
import { useOperationProgress } from "./use-operation-progress";

// ====================
// API Function
// ====================

interface StartConnectContainerResponse {
  success: boolean;
  data: {
    started: boolean;
    operationId: string;
    environmentId: string;
  };
}

async function startConnectContainer(
  request: CreateManualFrontendRequest,
): Promise<StartConnectContainerResponse> {
  const response = await fetch("/api/haproxy/manual-frontends", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.message || "Failed to start container connection");
  }

  return response.json();
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

export function useConnectContainerProgress(operationId: string | null) {
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
      ["haproxy-frontends"],
      ["haproxy-backends"],
      ["containers"],
    ],
    toasts: {
      success: "Container connected successfully",
      error: "Container connection failed",
    },
  });
}
