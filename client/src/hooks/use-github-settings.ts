import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  GitHubSettingResponse,
  GitHubValidationResponse,
} from "@mini-infra/types";

interface UpdateGitHubSettingsPayload {
  personal_access_token: string;
  repo_owner: string;
  repo_name: string;
  encrypt?: boolean;
}

interface TestConnectionPayload {
  personal_access_token?: string;
  repo_owner?: string;
  repo_name?: string;
}

// Hook for retrieving current GitHub settings
export function useGitHubSettings() {
  return useQuery<GitHubSettingResponse>({
    queryKey: ["github-settings"],
    queryFn: async () => {
      const response = await fetch("/api/settings/github", {
        credentials: "include",
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({
          message: "Failed to fetch GitHub settings",
        }));
        throw new Error(errorData.message || "Failed to fetch settings");
      }

      return response.json();
    },
    staleTime: 30000, // 30 seconds
    retry: (failureCount, error) => {
      // Don't retry on 401/403 errors
      if (error instanceof Error) {
        const message = error.message.toLowerCase();
        if (message.includes("unauthorized") || message.includes("forbidden")) {
          return false;
        }
      }
      return failureCount < 3;
    },
  });
}

// Hook for updating GitHub settings
export function useUpdateGitHubSettings() {
  const queryClient = useQueryClient();

  return useMutation<
    GitHubSettingResponse,
    Error,
    UpdateGitHubSettingsPayload
  >({
    mutationFn: async (payload) => {
      const response = await fetch("/api/settings/github", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({
          message: "Failed to update GitHub settings",
        }));
        throw new Error(errorData.message || "Failed to update settings");
      }

      return response.json();
    },
    onSuccess: () => {
      // Invalidate related queries
      queryClient.invalidateQueries({ queryKey: ["github-settings"] });
    },
  });
}

// Hook for deleting GitHub settings
export function useDeleteGitHubSettings() {
  const queryClient = useQueryClient();

  return useMutation<{ success: boolean; message?: string }, Error>({
    mutationFn: async () => {
      const response = await fetch("/api/settings/github", {
        method: "DELETE",
        credentials: "include",
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({
          message: "Failed to delete GitHub settings",
        }));
        throw new Error(errorData.message || "Failed to delete settings");
      }

      return response.json();
    },
    onSuccess: () => {
      // Invalidate related queries
      queryClient.invalidateQueries({ queryKey: ["github-settings"] });
    },
  });
}

// Hook for testing GitHub connection
export function useTestGitHubConnection() {
  return useMutation<GitHubValidationResponse, Error, TestConnectionPayload>({
    mutationFn: async (payload) => {
      const response = await fetch("/api/settings/github/test", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({
          message: "Failed to test GitHub connection",
        }));
        throw new Error(errorData.message || "Connection test failed");
      }

      return response.json();
    },
  });
}
