import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type {
  StackTemplateInfo,
  StackTemplateListResponse,
  StackTemplateResponse,
  StackTemplateVersionInfo,
  CreateStackTemplateRequest,
  DraftVersionInput,
  StackInfo,
  StackListResponse,
  StackResponse,
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

async function fetchApplication(
  id: string,
  correlationId: string,
): Promise<StackTemplateResponse> {
  const response = await fetch(`/api/stack-templates/${id}`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch application: ${response.statusText}`);
  }

  const data: StackTemplateResponse = await response.json();
  if (!data.success) {
    throw new Error(data.message || "Failed to fetch application");
  }

  return data;
}

async function createApplication(
  request: CreateStackTemplateRequest,
  correlationId: string,
): Promise<StackTemplateResponse> {
  const response = await fetch("/api/stack-templates", {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    let errorMessage = `Failed to create application: ${response.statusText}`;
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
    throw new Error(data.message || "Failed to create application");
  }

  return data;
}

async function publishApplication(
  templateId: string,
  correlationId: string,
): Promise<void> {
  const response = await fetch(`/api/stack-templates/${templateId}/publish`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
    body: JSON.stringify({}),
  });

  if (!response.ok) {
    let errorMessage = `Failed to publish application: ${response.statusText}`;
    try {
      const errorData = await response.json();
      errorMessage = errorData.message || errorMessage;
    } catch {
      // Use default error message
    }
    throw new Error(errorMessage);
  }
}

async function createDraft(
  templateId: string,
  input: DraftVersionInput,
  correlationId: string,
): Promise<void> {
  const response = await fetch(`/api/stack-templates/${templateId}/draft`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    let errorMessage = `Failed to update application: ${response.statusText}`;
    try {
      const errorData = await response.json();
      errorMessage = errorData.message || errorMessage;
    } catch {
      // Use default error message
    }
    throw new Error(errorMessage);
  }
}

async function updateTemplateMetadata(
  templateId: string,
  metadata: { displayName?: string; description?: string; category?: string },
  correlationId: string,
): Promise<void> {
  const response = await fetch(`/api/stack-templates/${templateId}`, {
    method: "PUT",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
    body: JSON.stringify(metadata),
  });

  if (!response.ok) {
    let errorMessage = `Failed to update application metadata: ${response.statusText}`;
    try {
      const errorData = await response.json();
      errorMessage = errorData.message || errorMessage;
    } catch {
      // Use default error message
    }
    throw new Error(errorMessage);
  }
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

async function instantiateApplication(
  templateId: string,
  body: { name?: string; environmentId?: string; parameterValues?: Record<string, unknown> },
  correlationId: string,
): Promise<StackResponse> {
  const response = await fetch(`/api/stack-templates/${templateId}/instantiate`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    let errorMessage = `Failed to instantiate application: ${response.statusText}`;
    try {
      const errorData = await response.json();
      errorMessage = errorData.message || errorMessage;
    } catch {
      // Use default error message
    }
    throw new Error(errorMessage);
  }

  const data: StackResponse = await response.json();
  if (!data.success) {
    throw new Error(data.message || "Failed to instantiate application");
  }

  return data;
}

async function applyStack(
  stackId: string,
  correlationId: string,
): Promise<{ success: boolean; data: { started: true; stackId: string } }> {
  const response = await fetch(`/api/stacks/${stackId}/apply`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
    body: JSON.stringify({}),
  });

  if (!response.ok) {
    let errorMessage = `Failed to deploy application: ${response.statusText}`;
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

async function destroyStack(
  stackId: string,
  correlationId: string,
): Promise<{ success: boolean; data: { started: true; stackId: string } }> {
  const response = await fetch(`/api/stacks/${stackId}/destroy`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    let errorMessage = `Failed to stop application: ${response.statusText}`;
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

async function updateStack(
  stackId: string,
  correlationId: string,
): Promise<{ success: boolean; data: { started: true; stackId: string } }> {
  const response = await fetch(`/api/stacks/${stackId}/update`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    let errorMessage = `Failed to update application: ${response.statusText}`;
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

async function fetchUserStacks(
  correlationId: string,
): Promise<StackListResponse> {
  const url = new URL("/api/stacks", window.location.origin);
  url.searchParams.set("source", "user");

  const response = await fetch(url.toString(), {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch stacks: ${response.statusText}`);
  }

  const data: StackListResponse = await response.json();
  if (!data.success) {
    throw new Error(data.message || "Failed to fetch stacks");
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

export function useApplication(id: string) {
  const correlationId = generateCorrelationId();

  return useQuery({
    queryKey: ["application", id],
    queryFn: () => fetchApplication(id, correlationId),
    enabled: !!id,
    staleTime: 5000,
    gcTime: 5 * 60 * 1000,
  });
}

export function useUserStacks() {
  const correlationId = generateCorrelationId();

  return useQuery({
    queryKey: ["userStacks"],
    queryFn: () => fetchUserStacks(correlationId),
    staleTime: 10000,
    gcTime: 5 * 60 * 1000,
    refetchOnWindowFocus: true,
  });
}

export function useCreateApplication() {
  const queryClient = useQueryClient();
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: async (request: CreateStackTemplateRequest) => {
      // Create template
      const result = await createApplication(request, correlationId);
      // Publish the draft immediately
      await publishApplication(result.data.id, correlationId);

      // If deployImmediately, instantiate and apply
      if (request.deployImmediately && request.environmentId) {
        try {
          const stackResult = await instantiateApplication(
            result.data.id,
            { name: result.data.name, environmentId: request.environmentId },
            correlationId,
          );
          // Apply is fire-and-forget (progress via Socket.IO)
          await applyStack(stackResult.data.id, correlationId);
        } catch {
          // Template was created successfully, but deploy failed
          toast.error("Application created but deployment failed. You can retry from the applications list.");
          return result; // Return success for the create
        }
      }

      return result;
    },
    onSuccess: (_data, variables) => {
      const message = variables.deployImmediately
        ? "Application created and deployment started"
        : "Application created successfully";
      toast.success(message);
      queryClient.invalidateQueries({ queryKey: ["applications"] });
      if (variables.deployImmediately) {
        queryClient.invalidateQueries({ queryKey: ["userStacks"] });
        queryClient.invalidateQueries({ queryKey: ["stacks"] });
      }
    },
    onError: (error: Error) => {
      toast.error(`Failed to create application: ${error.message}`);
    },
  });
}

export function useUpdateApplication() {
  const queryClient = useQueryClient();
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: async ({
      templateId,
      metadata,
      draft,
    }: {
      templateId: string;
      metadata: { displayName?: string; description?: string; category?: string };
      draft: DraftVersionInput;
    }) => {
      // Update metadata
      await updateTemplateMetadata(templateId, metadata, correlationId);
      // Create a new draft
      await createDraft(templateId, draft, correlationId);
      // Publish it
      await publishApplication(templateId, correlationId);
    },
    onSuccess: () => {
      toast.success("Application updated successfully");
      queryClient.invalidateQueries({ queryKey: ["applications"] });
      queryClient.invalidateQueries({ queryKey: ["application"] });
    },
    onError: (error: Error) => {
      toast.error(`Failed to update application: ${error.message}`);
    },
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

export function useDeployApplication() {
  const queryClient = useQueryClient();
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: async ({
      templateId,
      name,
      environmentId,
    }: {
      templateId: string;
      name: string;
      environmentId: string;
    }) => {
      // Instantiate a stack from the template
      const stackResult = await instantiateApplication(
        templateId,
        { name, environmentId },
        correlationId,
      );
      // Apply/deploy the stack
      await applyStack(stackResult.data.id, correlationId);
      return stackResult.data;
    },
    onSuccess: () => {
      toast.success("Application deployment started");
      queryClient.invalidateQueries({ queryKey: ["applications"] });
      queryClient.invalidateQueries({ queryKey: ["userStacks"] });
      queryClient.invalidateQueries({ queryKey: ["stacks"] });
    },
    onError: (error: Error) => {
      toast.error(`Failed to deploy application: ${error.message}`);
    },
  });
}

export function useStopApplication() {
  const queryClient = useQueryClient();
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: async (stackId: string) => {
      await destroyStack(stackId, correlationId);
    },
    onSuccess: () => {
      toast.success("Application stop initiated");
      queryClient.invalidateQueries({ queryKey: ["applications"] });
      queryClient.invalidateQueries({ queryKey: ["userStacks"] });
      queryClient.invalidateQueries({ queryKey: ["stacks"] });
    },
    onError: (error: Error) => {
      toast.error(`Failed to stop application: ${error.message}`);
    },
  });
}

export function useRedeployApplication() {
  const queryClient = useQueryClient();
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: async (stackId: string) => {
      await updateStack(stackId, correlationId);
    },
    onSuccess: () => {
      toast.success("Application update started");
      queryClient.invalidateQueries({ queryKey: ["applications"] });
      queryClient.invalidateQueries({ queryKey: ["userStacks"] });
      queryClient.invalidateQueries({ queryKey: ["stacks"] });
    },
    onError: (error: Error) => {
      toast.error(`Failed to update application: ${error.message}`);
    },
  });
}

// ====================
// Type Exports
// ====================

export type { StackTemplateInfo, StackTemplateVersionInfo, StackInfo };
