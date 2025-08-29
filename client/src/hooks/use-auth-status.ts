import { useQuery, UseQueryResult } from "@tanstack/react-query";
import { AuthStatus } from "../lib/auth-types";

const BACKEND_URL = window.location.origin;

async function fetchAuthStatus(): Promise<AuthStatus> {
  try {
    const response = await fetch(`${BACKEND_URL}/auth/status`, {
      method: "GET",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      if (response.status === 401) {
        // Unauthorized is expected when not authenticated
        return {
          isAuthenticated: false,
          user: null,
        };
      }

      // For other errors, create descriptive error messages
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(
        `${response.status}: Failed to fetch auth status - ${errorText}`,
      );
    }

    const data = await response.json();
    return data.data || data;
  } catch (error) {
    // Handle network errors and other fetch errors
    if (error instanceof TypeError && error.message.includes("fetch")) {
      throw new Error(
        "NetworkError: Unable to connect to the authentication server. Please check your connection.",
      );
    }
    // Re-throw other errors as-is
    throw error;
  }
}

export function useAuthStatus(): UseQueryResult<AuthStatus, Error> {
  return useQuery({
    queryKey: ["auth", "status"],
    queryFn: fetchAuthStatus,
    retry: (failureCount, error) => {
      // Don't retry on 401 (unauthorized) - that's a valid response
      if (error instanceof Error && error.message.includes("401")) {
        return false;
      }
      return failureCount < 2;
    },
    // Enhanced session persistence settings
    refetchInterval: 5 * 60 * 1000, // Refetch every 5 minutes
    refetchOnMount: true, // Always check on mount
    refetchOnWindowFocus: true, // Check when window regains focus
    refetchOnReconnect: true, // Check when network reconnects
    staleTime: 1 * 60 * 1000, // Consider data fresh for 1 minute
    gcTime: 10 * 60 * 1000, // Keep in cache for 10 minutes (formerly cacheTime)

    // Network mode for better offline handling
    networkMode: "online",

    // Retry on network error for better persistence
    retryOnMount: true,
  });
}
