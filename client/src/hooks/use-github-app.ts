import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
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

// Helper to unwrap the { success, data } API response envelope
async function fetchAndUnwrap<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: "include",
    ...options,
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({
      message: `Request failed (${response.status})`,
    }));
    throw new Error(errorData.message || errorData.error || `Request failed (${response.status})`);
  }

  const result = await response.json();
  return result.data !== undefined ? result.data : result;
}

// Hook for retrieving current GitHub App settings
export function useGitHubAppSettings() {
  return useQuery<GitHubAppSettingResponse>({
    queryKey: ["github-app-settings"],
    queryFn: () => fetchAndUnwrap<GitHubAppSettingResponse>("/api/settings/github-app"),
    staleTime: 30000,
    retry: (failureCount, error) => {
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

// Hook for completing GitHub App setup after OAuth callback
export function useGitHubAppSetupComplete() {
  const queryClient = useQueryClient();

  return useMutation<GitHubAppSetupCompleteResponse, Error, { code: string }>({
    mutationFn: (payload) =>
      fetchAndUnwrap<GitHubAppSetupCompleteResponse>(
        "/api/settings/github-app/setup/complete",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["github-app-settings"] });
      queryClient.invalidateQueries({ queryKey: ["connectivityStatus"] });
    },
  });
}

// Hook for refreshing GitHub App installation after user installs on GitHub
export function useRefreshGitHubAppInstallation() {
  const queryClient = useQueryClient();

  return useMutation<{ found: boolean; installationId?: string }, Error>({
    mutationFn: () =>
      fetchAndUnwrap<{ found: boolean; installationId?: string }>(
        "/api/settings/github-app/refresh-installation",
        { method: "POST" },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["github-app-settings"] });
      queryClient.invalidateQueries({ queryKey: ["connectivityStatus"] });
    },
  });
}

// Hook for testing GitHub App connection
export function useTestGitHubApp() {
  const queryClient = useQueryClient();

  return useMutation<GitHubAppValidationResponse, Error>({
    mutationFn: () =>
      fetchAndUnwrap<GitHubAppValidationResponse>(
        "/api/settings/github-app/test",
        { method: "POST" },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["connectivityStatus"] });
    },
  });
}

// Hook for deleting GitHub App settings
export function useDeleteGitHubApp() {
  const queryClient = useQueryClient();

  return useMutation<{ success: boolean; message?: string }, Error>({
    mutationFn: () =>
      fetchAndUnwrap<{ success: boolean; message?: string }>(
        "/api/settings/github-app",
        { method: "DELETE" },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["github-app-settings"] });
      queryClient.invalidateQueries({ queryKey: ["connectivityStatus"] });
    },
  });
}

// Hook for retrieving GitHub App packages
export function useGitHubAppPackages(enabled?: boolean) {
  return useQuery<GitHubAppPackage[]>({
    queryKey: ["github-app-packages"],
    queryFn: () => fetchAndUnwrap<GitHubAppPackage[]>("/api/github-app/packages"),
    enabled: enabled === undefined ? true : enabled,
    staleTime: 60000,
    retry: (failureCount, error) => {
      if (error instanceof Error) {
        const message = error.message.toLowerCase();
        if (
          message.includes("unauthorized") ||
          message.includes("forbidden") ||
          message.includes("not configured")
        ) {
          return false;
        }
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
    queryKey: ["github-app-package-versions", packageName],
    queryFn: () =>
      fetchAndUnwrap<GitHubAppPackageVersion[]>(
        `/api/github-app/packages/${encodeURIComponent(packageName)}/versions`,
      ),
    enabled: (enabled === undefined ? true : enabled) && !!packageName,
    staleTime: 60000,
    retry: (failureCount, error) => {
      if (error instanceof Error) {
        const message = error.message.toLowerCase();
        if (
          message.includes("unauthorized") ||
          message.includes("forbidden") ||
          message.includes("not found")
        ) {
          return false;
        }
      }
      return failureCount < 3;
    },
  });
}

// Hook for retrieving GitHub App repositories
export function useGitHubAppRepositories(enabled?: boolean) {
  return useQuery<GitHubAppRepository[]>({
    queryKey: ["github-app-repos"],
    queryFn: () => fetchAndUnwrap<GitHubAppRepository[]>("/api/github-app/repos"),
    enabled: enabled === undefined ? true : enabled,
    staleTime: 60000,
    retry: (failureCount, error) => {
      if (error instanceof Error) {
        const message = error.message.toLowerCase();
        if (
          message.includes("unauthorized") ||
          message.includes("forbidden") ||
          message.includes("not configured")
        ) {
          return false;
        }
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
    queryKey: ["github-app-action-runs", owner, repo],
    queryFn: () =>
      fetchAndUnwrap<GitHubAppActionsRun[]>(
        `/api/github-app/repos/${owner}/${repo}/actions/runs`,
      ),
    enabled: (enabled === undefined ? true : enabled) && !!owner && !!repo,
    staleTime: 30000,
    retry: (failureCount, error) => {
      if (error instanceof Error) {
        const message = error.message.toLowerCase();
        if (
          message.includes("unauthorized") ||
          message.includes("forbidden") ||
          message.includes("not found")
        ) {
          return false;
        }
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
      fetchAndUnwrap<{ message: string; registryCredentialCreated?: boolean; githubUsername?: string }>(
        "/api/settings/github-app/oauth/pat",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["github-app-settings"] });
      queryClient.invalidateQueries({ queryKey: ["github-app-packages"] });
      queryClient.invalidateQueries({ queryKey: ["registryCredentials"] });
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
      fetchAndUnwrap<{ message: string; githubUsername?: string }>(
        "/api/settings/github-app/oauth/sync-registry",
        { method: "POST" },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["registryCredentials"] });
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
      fetchAndUnwrap<{ message: string }>(
        "/api/settings/github-app/agent/token",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["github-app-settings"] });
    },
  });
}

// Hook for revoking agent GitHub token
export function useGitHubRevokeAgentToken() {
  const queryClient = useQueryClient();

  return useMutation<{ message: string }, Error>({
    mutationFn: () =>
      fetchAndUnwrap<{ message: string }>(
        "/api/settings/github-app/agent/revoke",
        { method: "POST" },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["github-app-settings"] });
    },
  });
}

// Hook for revoking GitHub OAuth user token
export function useGitHubOAuthRevoke() {
  const queryClient = useQueryClient();

  return useMutation<{ message: string }, Error>({
    mutationFn: () =>
      fetchAndUnwrap<{ message: string }>(
        "/api/settings/github-app/oauth/revoke",
        { method: "POST" },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["github-app-settings"] });
      queryClient.invalidateQueries({ queryKey: ["github-app-packages"] });
    },
  });
}
