import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiRoute, queryKeys } from "@mini-infra/types";
import type {
  GitHubAppSettingResponse,
  GitHubAppValidationResponse,
  GitHubAppPackage,
  GitHubAppPackageVersion,
  GitHubAppRepository,
  GitHubAppActionsRun,
  GitHubAppSetupCompleteResponse,
  GitHubAgentAccessLevel,
} from "@mini-infra/types";
import { apiFetch, ApiRequestError } from "@/lib/api-client";

function isAuthError(error: unknown): boolean {
  return error instanceof ApiRequestError && (error.isAuth || error.status === 403);
}

// Hook for retrieving current GitHub App settings
export function useGitHubAppSettings() {
  return useQuery<GitHubAppSettingResponse>({
    queryKey: queryKeys.githubAppSettings.all,
    queryFn: () =>
      apiFetch<GitHubAppSettingResponse>(ApiRoute.settings.githubApp(), {
        correlationIdPrefix: "github-app",
      }),
    staleTime: 30000,
    retry: (failureCount, error) => {
      if (isAuthError(error)) {
        return false;
      }
      return failureCount < 3;
    },
  });
}

// Hook for completing GitHub App setup after OAuth callback
export function useGitHubAppSetupComplete() {
  const queryClient = useQueryClient();

  return useMutation<GitHubAppSetupCompleteResponse, Error, { code: string }>({
    mutationFn: (payload) =>
      apiFetch<GitHubAppSetupCompleteResponse>(
        ApiRoute.settings.githubAppSetupComplete(),
        {
          method: "POST",
          body: payload,
          correlationIdPrefix: "github-app",
        },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.githubAppSettings.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.connectivity.status });
    },
  });
}

// Hook for refreshing GitHub App installation after user installs on GitHub
export function useRefreshGitHubAppInstallation() {
  const queryClient = useQueryClient();

  return useMutation<{ found: boolean; installationId?: string }, Error>({
    mutationFn: () =>
      apiFetch<{ found: boolean; installationId?: string }>(
        ApiRoute.settings.githubAppRefreshInstallation(),
        { method: "POST", correlationIdPrefix: "github-app" },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.githubAppSettings.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.connectivity.status });
    },
  });
}

// Hook for testing GitHub App connection
export function useTestGitHubApp() {
  const queryClient = useQueryClient();

  return useMutation<GitHubAppValidationResponse, Error>({
    mutationFn: () =>
      apiFetch<GitHubAppValidationResponse>(ApiRoute.settings.githubAppTest(), {
        method: "POST",
        correlationIdPrefix: "github-app",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.connectivity.status });
    },
  });
}

// Hook for deleting GitHub App settings
export function useDeleteGitHubApp() {
  const queryClient = useQueryClient();

  return useMutation<{ success: boolean; message?: string }, Error>({
    mutationFn: () =>
      apiFetch<{ success: boolean; message?: string }>(
        ApiRoute.settings.githubApp(),
        { method: "DELETE", correlationIdPrefix: "github-app" },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.githubAppSettings.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.connectivity.status });
    },
  });
}

// Hook for retrieving GitHub App packages
export function useGitHubAppPackages(enabled?: boolean) {
  return useQuery<GitHubAppPackage[]>({
    queryKey: queryKeys.githubApp.packages,
    queryFn: () =>
      apiFetch<GitHubAppPackage[]>(ApiRoute.githubApp.packages(), {
        correlationIdPrefix: "github-app",
      }),
    enabled: enabled === undefined ? true : enabled,
    staleTime: 60000,
    retry: (failureCount, error) => {
      if (isAuthError(error)) {
        return false;
      }
      if (error instanceof Error && error.message.toLowerCase().includes("not configured")) {
        return false;
      }
      return failureCount < 3;
    },
  });
}

// Hook for retrieving versions of a specific GitHub App package
export function useGitHubAppPackageVersions(
  packageName: string,
  enabled?: boolean,
) {
  return useQuery<GitHubAppPackageVersion[]>({
    queryKey: queryKeys.githubApp.packageVersions(packageName),
    queryFn: () =>
      apiFetch<GitHubAppPackageVersion[]>(
        ApiRoute.githubApp.packageVersions(encodeURIComponent(packageName)),
        { correlationIdPrefix: "github-app" },
      ),
    enabled: (enabled === undefined ? true : enabled) && !!packageName,
    staleTime: 60000,
    retry: (failureCount, error) => {
      if (isAuthError(error)) {
        return false;
      }
      if (error instanceof Error && error.message.toLowerCase().includes("not found")) {
        return false;
      }
      return failureCount < 3;
    },
  });
}

// Hook for retrieving GitHub App repositories
export function useGitHubAppRepositories(enabled?: boolean) {
  return useQuery<GitHubAppRepository[]>({
    queryKey: queryKeys.githubApp.repos,
    queryFn: () =>
      apiFetch<GitHubAppRepository[]>(ApiRoute.githubApp.repos(), {
        correlationIdPrefix: "github-app",
      }),
    enabled: enabled === undefined ? true : enabled,
    staleTime: 60000,
    retry: (failureCount, error) => {
      if (isAuthError(error)) {
        return false;
      }
      if (error instanceof Error && error.message.toLowerCase().includes("not configured")) {
        return false;
      }
      return failureCount < 3;
    },
  });
}

// Hook for retrieving GitHub Actions workflow runs for a repository
export function useGitHubAppActionRuns(
  owner: string,
  repo: string,
  enabled?: boolean,
) {
  return useQuery<GitHubAppActionsRun[]>({
    queryKey: queryKeys.githubApp.repoActionRuns(owner, repo),
    queryFn: () =>
      apiFetch<GitHubAppActionsRun[]>(
        ApiRoute.githubApp.repoActionRuns(owner, repo),
        { correlationIdPrefix: "github-app" },
      ),
    enabled: (enabled === undefined ? true : enabled) && !!owner && !!repo,
    staleTime: 30000,
    retry: (failureCount, error) => {
      if (isAuthError(error)) {
        return false;
      }
      if (error instanceof Error && error.message.toLowerCase().includes("not found")) {
        return false;
      }
      return failureCount < 3;
    },
  });
}

// Hook for saving a PAT for package access
export function useGitHubSavePackagePat() {
  const queryClient = useQueryClient();

  return useMutation<
    { message: string; registryCredentialCreated?: boolean; githubUsername?: string },
    Error,
    { token: string }
  >({
    mutationFn: (payload) =>
      apiFetch<{ message: string; registryCredentialCreated?: boolean; githubUsername?: string }>(
        ApiRoute.settings.githubAppOauthPat(),
        { method: "POST", body: payload, correlationIdPrefix: "github-app" },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.githubAppSettings.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.githubApp.packages });
      queryClient.invalidateQueries({ queryKey: queryKeys.registryCredentials.all });
    },
  });
}

// Hook for syncing stored PAT to GHCR registry credentials
export function useGitHubSyncRegistry() {
  const queryClient = useQueryClient();

  return useMutation<
    { message: string; githubUsername?: string },
    Error
  >({
    mutationFn: () =>
      apiFetch<{ message: string; githubUsername?: string }>(
        ApiRoute.settings.githubAppOauthSyncRegistry(),
        { method: "POST", correlationIdPrefix: "github-app" },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.registryCredentials.all });
    },
  });
}

// Hook for saving an agent GitHub token
export function useGitHubSaveAgentToken() {
  const queryClient = useQueryClient();

  return useMutation<
    { message: string },
    Error,
    { token: string; accessLevel: GitHubAgentAccessLevel }
  >({
    mutationFn: (payload) =>
      apiFetch<{ message: string }>(ApiRoute.settings.githubAppAgentToken(), {
        method: "POST",
        body: payload,
        correlationIdPrefix: "github-app",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.githubAppSettings.all });
    },
  });
}

// Hook for revoking agent GitHub token
export function useGitHubRevokeAgentToken() {
  const queryClient = useQueryClient();

  return useMutation<{ message: string }, Error>({
    mutationFn: () =>
      apiFetch<{ message: string }>(ApiRoute.settings.githubAppAgentRevoke(), {
        method: "POST",
        correlationIdPrefix: "github-app",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.githubAppSettings.all });
    },
  });
}

// Hook for revoking GitHub OAuth user token
export function useGitHubOAuthRevoke() {
  const queryClient = useQueryClient();

  return useMutation<{ message: string }, Error>({
    mutationFn: () =>
      apiFetch<{ message: string }>(ApiRoute.settings.githubAppOauthRevoke(), {
        method: "POST",
        correlationIdPrefix: "github-app",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.githubAppSettings.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.githubApp.packages });
    },
  });
}
