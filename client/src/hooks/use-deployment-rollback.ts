import { useMutation, useQueryClient } from "@tanstack/react-query";

// Generate correlation ID for debugging
function generateCorrelationId(): string {
  return `deployment-rollback-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// ====================
// Deployment Rollback API Functions
// ====================

export interface DeploymentRollbackResponse {
  success: boolean;
  data: {
    id: string;
    message: string;
  };
  message?: string;
}

async function rollbackDeployment(
  deploymentId: string,
  correlationId: string,
): Promise<DeploymentRollbackResponse> {
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

  const data: DeploymentRollbackResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to rollback deployment");
  }

  return data;
}

// ====================
// Deployment Rollback Hook
// ====================

export interface UseDeploymentRollbackOptions {
  onSuccess?: (data: DeploymentRollbackResponse, deploymentId: string) => void;
  onError?: (error: Error, deploymentId: string) => void;
}

/**
 * Hook for rolling back deployments
 * Automatically invalidates related queries on success
 */
export function useDeploymentRollback(options: UseDeploymentRollbackOptions = {}) {
  const queryClient = useQueryClient();
  const { onSuccess, onError } = options;

  return useMutation({
    mutationFn: async (deploymentId: string) => {
      const correlationId = generateCorrelationId();
      return rollbackDeployment(deploymentId, correlationId);
    },
    onSuccess: (data, deploymentId) => {
      // Invalidate related queries to refresh UI
      queryClient.invalidateQueries({ queryKey: ["deploymentStatus", deploymentId] });
      queryClient.invalidateQueries({ queryKey: ["deploymentHistory"] });
      queryClient.invalidateQueries({ queryKey: ["activeDeployments"] });
      
      onSuccess?.(data, deploymentId);
    },
    onError: (error, deploymentId) => {
      onError?.(error as Error, deploymentId);
    },
    retry: (failureCount, error) => {
      // Don't retry on authentication errors
      if (
        error.message.includes("401") ||
        error.message.includes("Unauthorized")
      ) {
        return false;
      }
      // Don't retry on not found errors
      if (
        error.message.includes("404") ||
        error.message.includes("Not found")
      ) {
        return false;
      }
      // Retry up to 2 times for other errors
      return failureCount < 2;
    },
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 10000), // Exponential backoff with max 10s
  });
}

