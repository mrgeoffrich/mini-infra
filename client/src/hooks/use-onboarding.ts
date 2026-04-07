import { useQueryClient } from "@tanstack/react-query";
import {
  useSystemSettings,
  useCreateSystemSetting,
  useUpdateSystemSetting,
} from "@/hooks/use-settings";

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

export function useCompleteOnboarding() {
  const queryClient = useQueryClient();
  const { data } = useSystemSettings({
    filters: ONBOARDING_FILTER,
    limit: 1,
  });
  const createSetting = useCreateSystemSetting();
  const updateSetting = useUpdateSystemSetting();

  const existing = data?.data?.[0];

  const complete = async () => {
    if (existing) {
      await updateSetting.mutateAsync({
        id: existing.id,
        setting: { value: "true" },
      });
    } else {
      await createSetting.mutateAsync({
        category: "system",
        key: "onboarding_complete",
        value: "true",
        isEncrypted: false,
      });
    }
    queryClient.invalidateQueries({
      queryKey: ["systemSettings", ONBOARDING_FILTER],
    });
  };

  const isPending = createSetting.isPending || updateSetting.isPending;

  return { complete, isPending };
}
