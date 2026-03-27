import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type {
  StackTemplateInfo,
  StackTemplateListResponse,
  StackTemplateResponse,
} from "@mini-infra/types";

// Generate correlation ID for debugging
function generateCorrelationId(): string {
  return `applications-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// ====================
// Application API Functions
// ====================

async function fetchApplications(
  correlationId: string,
): Promise<StackTemplateListResponse> {
  const url = new URL("/api/stack-templates", window.location.origin);
  url.searchParams.set("source", "user");

  const response = await fetch(url.toString(), {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch applications: ${response.statusText}`);
  }

  const data: StackTemplateListResponse = await response.json();
  if (!data.success) {
    throw new Error(data.message || "Failed to fetch applications");
  }

  return data;
}

async function deleteApplication(
  id: string,
  correlationId: string,
): Promise<{ success: boolean; message: string }> {
  const response = await fetch(`/api/stack-templates/${id}`, {
    method: "DELETE",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    let errorMessage = `Failed to delete application: ${response.statusText}`;
    try {
      const errorData = await response.json();
      errorMessage = errorData.message || errorMessage;
    } catch {
      // Use default error message
    }
    throw new Error(errorMessage);
  }

  return await response.json();
}

async function importDeploymentConfig(
  configId: string,
  correlationId: string,
): Promise<StackTemplateResponse> {
  const response = await fetch(`/api/stack-templates/import-deployment/${configId}`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    let errorMessage = `Failed to import deployment: ${response.statusText}`;
    try {
      const errorData = await response.json();
      errorMessage = errorData.message || errorMessage;
    } catch {
      // Use default error message
    }
    throw new Error(errorMessage);
  }

  const data: StackTemplateResponse = await response.json();
  if (!data.success) {
    throw new Error(data.message || "Failed to import deployment");
  }

  return data;
}

// ====================
// Application Hooks
// ====================

export function useApplications() {
  const correlationId = generateCorrelationId();

  return useQuery({
    queryKey: ["applications"],
    queryFn: () => fetchApplications(correlationId),
    staleTime: 10000,
    gcTime: 5 * 60 * 1000,
    refetchOnWindowFocus: true,
  });
}

export function useDeleteApplication() {
  const queryClient = useQueryClient();
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: (id: string) => deleteApplication(id, correlationId),
    onSuccess: () => {
      toast.success("Application deleted successfully");
      queryClient.invalidateQueries({ queryKey: ["applications"] });
    },
    onError: (error: Error) => {
      toast.error(`Failed to delete application: ${error.message}`);
    },
  });
}

export function useImportDeploymentConfig() {
  const queryClient = useQueryClient();
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: (configId: string) => importDeploymentConfig(configId, correlationId),
    onSuccess: () => {
      toast.success("Deployment imported as application successfully");
      queryClient.invalidateQueries({ queryKey: ["applications"] });
    },
    onError: (error: Error) => {
      toast.error(`Failed to import deployment: ${error.message}`);
    },
  });
}

// ====================
// Type Exports
// ====================

export type { StackTemplateInfo };
