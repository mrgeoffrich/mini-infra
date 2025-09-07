import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { 
  UserPreferenceInfo, 
  UpdateUserPreferencesRequest 
} from "@mini-infra/types";

interface ApiResponse<T> {
  success: boolean;
  data: T;
  message?: string;
  error?: string;
}

interface TimezoneOption {
  value: string;
  label: string;
}

// API functions
async function fetchUserPreferences(): Promise<UserPreferenceInfo> {
  const response = await fetch("/api/user/preferences", {
    method: "GET",
    credentials: "include",
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch user preferences: ${response.statusText}`);
  }

  const result: ApiResponse<UserPreferenceInfo> = await response.json();
  
  if (!result.success) {
    throw new Error(result.error || "Failed to fetch user preferences");
  }

  return result.data;
}

async function updateUserPreferences(
  updates: UpdateUserPreferencesRequest
): Promise<UserPreferenceInfo> {
  const response = await fetch("/api/user/preferences", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    credentials: "include",
    body: JSON.stringify(updates),
  });

  if (!response.ok) {
    throw new Error(`Failed to update user preferences: ${response.statusText}`);
  }

  const result: ApiResponse<UserPreferenceInfo> = await response.json();
  
  if (!result.success) {
    throw new Error(result.error || "Failed to update user preferences");
  }

  return result.data;
}

async function fetchTimezones(): Promise<TimezoneOption[]> {
  const response = await fetch("/api/user/timezones", {
    method: "GET",
    credentials: "include",
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch timezones: ${response.statusText}`);
  }

  const result: ApiResponse<TimezoneOption[]> = await response.json();
  
  if (!result.success) {
    throw new Error(result.error || "Failed to fetch timezones");
  }

  return result.data;
}

// Query keys
export const userPreferencesKeys = {
  all: ["userPreferences"] as const,
  preferences: () => [...userPreferencesKeys.all, "preferences"] as const,
  timezones: () => [...userPreferencesKeys.all, "timezones"] as const,
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
        queryKey: userPreferencesKeys.preferences() 
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