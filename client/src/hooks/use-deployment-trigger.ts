import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  TriggerDeploymentRequest,
  DeploymentResponse,
} from "@mini-infra/types";

// Generate correlation ID for debugging
function generateCorrelationId(): string {
  return `deployment-trigger-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// ====================
// Deployment Trigger API Functions
// ====================

async function triggerDeployment(
  request: TriggerDeploymentRequest,
  correlationId: string,
): Promise<DeploymentResponse> {
  const response = await fetch(`/api/deployments/trigger`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to trigger deployment: ${response.statusText}`,
    );
  }

  const data: DeploymentResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to trigger deployment");
  }

  return data;
}

async function rollbackDeployment(
  deploymentId: string,
  correlationId: string,
): Promise<DeploymentResponse> {
  const response = await fetch(`/api/deployments/${deploymentId}/rollback`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to rollback deployment: ${response.statusText}`,
    );
  }

  const data: DeploymentResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to rollback deployment");
  }

  return data;
}

// ====================
// Deployment Trigger Hooks
// ====================

export function useDeploymentTrigger() {
  const queryClient = useQueryClient();
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: (request: TriggerDeploymentRequest) =>
      triggerDeployment(request, correlationId),
    onSuccess: (data) => {
      // Invalidate deployment history to show new deployment
      queryClient.invalidateQueries({ queryKey: ["deploymentHistory"] });
      // Set initial data for the new deployment status
      queryClient.setQueryData(
        ["deploymentStatus", data.data.id],
        data,
      );
      // Start polling for the deployment status
      queryClient.invalidateQueries({
        queryKey: ["deploymentStatus", data.data.id],
      });
    },
  });
}

export function useDeploymentRollback() {
  const queryClient = useQueryClient();
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: (deploymentId: string) =>
      rollbackDeployment(deploymentId, correlationId),
    onSuccess: (data, deploymentId) => {
      // Invalidate deployment history to show updated status
      queryClient.invalidateQueries({ queryKey: ["deploymentHistory"] });
      // Update deployment status cache
      queryClient.setQueryData(
        ["deploymentStatus", deploymentId],
        data,
      );
      // Invalidate to trigger fresh fetch
      queryClient.invalidateQueries({
        queryKey: ["deploymentStatus", deploymentId],
      });
    },
  });
}

// ====================
// Type Exports
// ====================

export type {
  TriggerDeploymentRequest,
  DeploymentResponse,
};