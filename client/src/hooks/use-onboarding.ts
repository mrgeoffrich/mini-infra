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
      // Refresh the self-backup config (cached under "self-backup-config" in
      // use-self-backup.ts) and the TLS settings form (cached under
      // ["settings","tls"] in use-tls-settings.ts) so onboarding-completion
      // changes show up without waiting for a natural refetch.
      queryClient.invalidateQueries({ queryKey: queryKeys.selfBackup.config });
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.tlsSettings });
    },
  });

  return { complete: mutation.mutateAsync, isPending: mutation.isPending };
}
