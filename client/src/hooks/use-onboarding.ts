import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiRoute, queryKeys } from "@mini-infra/types";
import { useSystemSettings } from "@/hooks/use-settings";
import { apiFetch } from "@/lib/api-client";

const ONBOARDING_FILTER = {
  category: "system" as const,
  key: "onboarding_complete",
  isActive: true,
};

export function useOnboardingStatus() {
  const { data, isLoading } = useSystemSettings({
    filters: ONBOARDING_FILTER,
    limit: 1,
  });

  const setting = data?.data?.[0];
  const onboardingComplete = setting?.value === "true";

  return { onboardingComplete, isLoading };
}

async function completeOnboardingRequest(): Promise<void> {
  await apiFetch<void>(ApiRoute.onboarding.complete(), {
    method: "POST",
    correlationIdPrefix: "onboarding",
  });
}

export function useCompleteOnboarding() {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: completeOnboardingRequest,
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: [...queryKeys.settings.systemSettings, ONBOARDING_FILTER],
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.settings.systemSettings,
      });
      // These two invalidation targets don't match any live query key
      // anywhere in the app today — self-backup config is actually cached
      // under "self-backup-config" (use-self-backup.ts) and TLS settings
      // under ["settings","tls"] (use-tls-settings.ts). Pre-existing no-op
      // bugs, preserved via documented "Legacy" registry entries rather than
      // silently repointed — see queryKeys.selfBackup.configLegacy /
      // queryKeys.settings.tlsSettingsLegacy in lib/types/query-keys.ts.
      queryClient.invalidateQueries({ queryKey: queryKeys.selfBackup.configLegacy });
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.tlsSettingsLegacy });
    },
  });

  return { complete: mutation.mutateAsync, isPending: mutation.isPending };
}
