import { useQuery } from "@tanstack/react-query";

export interface PostgresSettingsStatus {
  isConfigured: boolean;
  hasBackupImage: boolean;
  hasRestoreImage: boolean;
  lastValidated?: string;
  error?: string;
}

/**
 * Hook to check PostgreSQL settings configuration status
 */
export function usePostgresSettings() {
  return useQuery({
    queryKey: ["postgres-settings"],
    queryFn: async (): Promise<PostgresSettingsStatus> => {
      try {
        // Validate PostgreSQL settings to check if containers are configured
        const response = await fetch("/api/settings/validate/postgres", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          credentials: "include",
          body: JSON.stringify({
            settings: {},
          }),
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();

        if (data?.data?.isValid) {
          return {
            isConfigured: true,
            hasBackupImage: true,
            hasRestoreImage: true,
            lastValidated: new Date().toISOString(),
          };
        } else {
          return {
            isConfigured: false,
            hasBackupImage: false,
            hasRestoreImage: false,
            error: data?.data?.error || data?.message || "PostgreSQL settings validation failed",
          };
        }
      } catch (error) {
        // If validation fails, it likely means containers are not configured
        return {
          isConfigured: false,
          hasBackupImage: false,
          hasRestoreImage: false,
          error: error instanceof Error ? error.message : "Failed to validate PostgreSQL settings",
        };
      }
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
    retry: false, // Don't retry on failure
  });
}