import { useQuery, UseQueryResult } from "@tanstack/react-query";
import { AuthStatus } from "../lib/auth-types";

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "http://localhost:5000";

async function fetchAuthStatus(): Promise<AuthStatus> {
  const response = await fetch(`${BACKEND_URL}/api/auth/status`, {
    method: "GET",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    if (response.status === 401) {
      return {
        isAuthenticated: false,
        user: null,
        sessionId: null,
      };
    }
    throw new Error(`Failed to fetch auth status: ${response.statusText}`);
  }

  const data = await response.json();
  return data.data || data;
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
    refetchInterval: 5 * 60 * 1000, // Refetch every 5 minutes
    refetchOnMount: true,
    refetchOnWindowFocus: true,
  });
}
