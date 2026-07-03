import { useQuery, UseQueryResult } from "@tanstack/react-query";
import { ApiRoute, queryKeys } from "@mini-infra/types";
import { apiFetch, ApiRequestError } from "../lib/api-client";
import { AuthStatus } from "../lib/auth-types";

async function fetchAuthStatus(): Promise<AuthStatus> {
  try {
    // /auth/status returns the AuthStatus object directly (no {success,data}
    // envelope) — see server/src/routes/auth.ts. It currently always
    // responds 200 (even when unauthenticated, with isAuthenticated: false),
    // but the 401 branch below is kept as a defensive fallback in case that
    // ever changes, matching the pre-migration behavior.
    return await apiFetch<AuthStatus>(ApiRoute.auth.status(), {
      unwrap: false,
      correlationIdPrefix: "auth",
    });
  } catch (error) {
    if (error instanceof ApiRequestError) {
      if (error.status === 401) {
        // Unauthorized is expected when not authenticated
        return {
          isAuthenticated: false,
          user: null,
        };
      }

      // For other errors, create descriptive error messages
      throw new Error(
        `${error.status}: Failed to fetch auth status - ${error.message}`,
        { cause: error },
      );
    }

    // Handle network errors and other fetch errors
    if (error instanceof TypeError && error.message.includes("fetch")) {
      throw new Error(
        "NetworkError: Unable to connect to the authentication server. Please check your connection.",
        { cause: error },
      );
    }
    // Re-throw other errors as-is
    throw error;
  }
}

export function useAuthStatus(): UseQueryResult<AuthStatus, Error> {
  return useQuery({
    queryKey: queryKeys.auth.status,
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
