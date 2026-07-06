import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiRoute, queryKeys } from "@mini-infra/types";
import type {
  GitHubSettingResponse,
  GitHubValidationResponse,
  CreateGitHubSettingRequest,
  ValidateGitHubConnectionRequest,
} from "@mini-infra/types";
import { apiFetch } from "@/lib/api-client";

// Hook for retrieving current GitHub settings
export function useGitHubSettings() {
  return useQuery<GitHubSettingResponse>({
    queryKey: queryKeys.githubSettings.all,
    queryFn: () =>
      // Enveloped endpoint, but callers read the full `{ success, data }`
      // shape (matches `GitHubSettingResponse`) rather than the unwrapped
      // `data` — preserve that contract with `unwrap: false`.
      apiFetch<GitHubSettingResponse>(ApiRoute.settings.github(), {
        correlationIdPrefix: "github-settings",
        unwrap: false,
      }),
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
    CreateGitHubSettingRequest
  >({
    mutationFn: (payload) =>
      apiFetch<GitHubSettingResponse>(ApiRoute.settings.github(), {
        method: "POST",
        body: payload,
        correlationIdPrefix: "github-settings",
        unwrap: false,
      }),
    onSuccess: () => {
      // Invalidate related queries
      queryClient.invalidateQueries({ queryKey: queryKeys.githubSettings.all });
    },
  });
}

// Hook for deleting GitHub settings
export function useDeleteGitHubSettings() {
  const queryClient = useQueryClient();

  return useMutation<{ success: boolean; message?: string }, Error>({
    mutationFn: () =>
      apiFetch<{ success: boolean; message?: string }>(
        ApiRoute.settings.github(),
        {
          method: "DELETE",
          correlationIdPrefix: "github-settings",
          unwrap: false,
        },
      ),
    onSuccess: () => {
      // Invalidate related queries
      queryClient.invalidateQueries({ queryKey: queryKeys.githubSettings.all });
    },
  });
}

// Hook for testing GitHub connection
export function useTestGitHubConnection() {
  return useMutation<GitHubValidationResponse, Error, ValidateGitHubConnectionRequest>({
    mutationFn: (payload) =>
      apiFetch<GitHubValidationResponse>(ApiRoute.settings.githubTest(), {
        method: "POST",
        body: payload,
        correlationIdPrefix: "github-settings",
        unwrap: false,
      }),
  });
}
