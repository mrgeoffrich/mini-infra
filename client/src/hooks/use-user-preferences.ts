import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiRoute, queryKeys } from "@mini-infra/types";
import type {
  UserPreferenceInfo,
  UpdateUserPreferencesRequest,
} from "@mini-infra/types";
import { apiFetch } from "@/lib/api-client";

interface TimezoneOption {
  value: string;
  label: string;
}

// API functions
async function fetchUserPreferences(): Promise<UserPreferenceInfo> {
  return apiFetch<UserPreferenceInfo>(ApiRoute.userPreferences.preferences(), {
    correlationIdPrefix: "user-preferences",
  });
}

async function updateUserPreferences(
  updates: UpdateUserPreferencesRequest,
): Promise<UserPreferenceInfo> {
  return apiFetch<UserPreferenceInfo>(ApiRoute.userPreferences.preferences(), {
    method: "PUT",
    body: updates,
    correlationIdPrefix: "user-preferences",
  });
}

async function fetchTimezones(): Promise<TimezoneOption[]> {
  return apiFetch<TimezoneOption[]>(ApiRoute.userPreferences.timezones(), {
    correlationIdPrefix: "user-preferences",
  });
}

// Query keys
//
// Re-exported (not just used internally) because `client/src/lib/auth-context.tsx`
// imports `userPreferencesKeys` directly to prefetch/clear the preferences
// cache on login/logout. Derived from the shared `queryKeys.userPreferences`
// registry so both files keep agreeing on the same cache entries.
export const userPreferencesKeys = {
  all: queryKeys.userPreferences.all,
  preferences: () =>
    [...queryKeys.userPreferences.all, "preferences"] as const,
  timezones: () => queryKeys.userPreferences.timezones,
};

// Hooks
export function useUserPreferences() {
  return useQuery({
    queryKey: userPreferencesKeys.preferences(),
    queryFn: fetchUserPreferences,
    staleTime: 5 * 60 * 1000, // 5 minutes
    retry: 1,
  });
}

export function useUpdateUserPreferences() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: updateUserPreferences,
    onSuccess: (data) => {
      // Invalidate and refetch user preferences
      queryClient.invalidateQueries({
        queryKey: userPreferencesKeys.preferences(),
      });

      // Update cache with new data
      queryClient.setQueryData(userPreferencesKeys.preferences(), data);
    },
    onError: (error) => {
      console.error("Failed to update user preferences:", error);
    },
  });
}

export function useTimezones() {
  return useQuery({
    queryKey: userPreferencesKeys.timezones(),
    queryFn: fetchTimezones,
    staleTime: 60 * 60 * 1000, // 1 hour - timezones don't change often
    gcTime: 24 * 60 * 60 * 1000, // 24 hours
    retry: 1,
  });
}
