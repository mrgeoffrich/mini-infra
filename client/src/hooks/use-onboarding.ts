import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useSystemSettings } from "@/hooks/use-settings";

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
  const response = await fetch("/api/onboarding/complete", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
  });

  if (!response.ok) {
    throw new Error(`Failed to complete onboarding: ${response.statusText}`);
  }

  const data = await response.json();
  if (!data.success) {
    throw new Error(data.error || "Failed to complete onboarding");
  }
}

export function useCompleteOnboarding() {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: completeOnboardingRequest,
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["systemSettings", ONBOARDING_FILTER],
      });
      queryClient.invalidateQueries({ queryKey: ["systemSettings"] });
      queryClient.invalidateQueries({ queryKey: ["selfBackupConfig"] });
      queryClient.invalidateQueries({ queryKey: ["tlsSettings"] });
    },
  });

  return { complete: mutation.mutateAsync, isPending: mutation.isPending };
}
