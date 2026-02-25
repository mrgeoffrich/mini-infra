import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  GitHubAppSettingResponse,
  GitHubAppValidationResponse,
  GitHubAppPackage,
  GitHubAppPackageVersion,
  GitHubAppRepository,
  GitHubAppActionsRun,
  GitHubAppRegistryTokenResponse,
  GitHubAppSetupCompleteResponse,
} from "@mini-infra/types";

// Hook for retrieving current GitHub App settings
export function useGitHubAppSettings() {
  return useQuery<GitHubAppSettingResponse>({
    queryKey: ["github-app-settings"],
    queryFn: async () => {
      const response = await fetch("/api/settings/github-app", {
        credentials: "include",
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({
          message: "Failed to fetch GitHub App settings",
        }));
        throw new Error(errorData.message || "Failed to fetch settings");
      }

      const result = await response.json();
      return result.data;
    },
    staleTime: 30000, // 30 seconds
    retry: (failureCount, error) => {
      // Don't retry on 401/403 errors
      if (error instanceof Error) {
        const message = error.message.toLowerCase();
        if (
          message.includes("unauthorized") ||
          message.includes("forbidden")
        ) {
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

  return useMutation<
    GitHubAppSetupCompleteResponse,
    Error,
    { code: string }
  >({
    mutationFn: async (payload) => {
      const response = await fetch("/api/settings/github-app/setup/complete", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({
          message: "Failed to complete GitHub App setup",
        }));
        throw new Error(errorData.message || "Setup completion failed");
      }

      const result = await response.json();
      return result.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["github-app-settings"] });
      queryClient.invalidateQueries({ queryKey: ["connectivityStatus"] });
    },
  });
}

// Hook for refreshing GitHub App installation after user installs on GitHub
export function useRefreshGitHubAppInstallation() {
  const queryClient = useQueryClient();

  return useMutation<
    { found: boolean; installationId?: string },
    Error
  >({
    mutationFn: async () => {
      const response = await fetch("/api/settings/github-app/refresh-installation", {
        method: "POST",
        credentials: "include",
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({
          message: "Failed to refresh installation",
        }));
        throw new Error(errorData.message || "Installation refresh failed");
      }

      const result = await response.json();
      return result.data;
    },
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
    mutationFn: async () => {
      const response = await fetch("/api/settings/github-app/test", {
        method: "POST",
        credentials: "include",
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({
          message: "Failed to test GitHub App connection",
        }));
        throw new Error(errorData.message || "Connection test failed");
      }

      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["connectivityStatus"] });
    },
  });
}

// Hook for deleting GitHub App settings
export function useDeleteGitHubApp() {
  const queryClient = useQueryClient();

  return useMutation<{ success: boolean; message?: string }, Error>({
    mutationFn: async () => {
      const response = await fetch("/api/settings/github-app", {
        method: "DELETE",
        credentials: "include",
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({
          message: "Failed to delete GitHub App settings",
        }));
        throw new Error(errorData.message || "Failed to delete settings");
      }

      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["github-app-settings"] });
      queryClient.invalidateQueries({ queryKey: ["connectivityStatus"] });
    },
  });
}

// Hook for creating a GHCR registry credential from the GitHub App
export function useCreateGhcrCredential() {
  const queryClient = useQueryClient();

  return useMutation<GitHubAppRegistryTokenResponse, Error>({
    mutationFn: async () => {
      const response = await fetch("/api/settings/github-app/registry-token", {
        method: "POST",
        credentials: "include",
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({
          message: "Failed to create GHCR credential",
        }));
        throw new Error(
          errorData.message || "Failed to create registry credential",
        );
      }

      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["registryCredentials"] });
    },
  });
}

// Hook for retrieving GitHub App packages
export function useGitHubAppPackages(enabled?: boolean) {
  return useQuery<GitHubAppPackage[]>({
    queryKey: ["github-app-packages"],
    queryFn: async () => {
      const response = await fetch("/api/github-app/packages", {
        credentials: "include",
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({
          message: "Failed to fetch GitHub App packages",
        }));
        throw new Error(errorData.message || "Failed to fetch packages");
      }

      return response.json();
    },
    enabled: enabled === undefined ? true : enabled,
    staleTime: 60000, // 1 minute
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
    queryFn: async () => {
      const response = await fetch(
        `/api/github-app/packages/${encodeURIComponent(packageName)}/versions`,
        {
          credentials: "include",
        },
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({
          message: "Failed to fetch package versions",
        }));
        throw new Error(errorData.message || "Failed to fetch versions");
      }

      return response.json();
    },
    enabled: (enabled === undefined ? true : enabled) && !!packageName,
    staleTime: 60000, // 1 minute
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
    queryFn: async () => {
      const response = await fetch("/api/github-app/repos", {
        credentials: "include",
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({
          message: "Failed to fetch GitHub App repositories",
        }));
        throw new Error(errorData.message || "Failed to fetch repositories");
      }

      return response.json();
    },
    enabled: enabled === undefined ? true : enabled,
    staleTime: 60000, // 1 minute
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
    queryFn: async () => {
      const response = await fetch(
        `/api/github-app/repos/${owner}/${repo}/actions/runs`,
        {
          credentials: "include",
        },
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({
          message: "Failed to fetch GitHub Actions runs",
        }));
        throw new Error(errorData.message || "Failed to fetch action runs");
      }

      return response.json();
    },
    enabled: (enabled === undefined ? true : enabled) && !!owner && !!repo,
    staleTime: 30000, // 30 seconds
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
