import { ReactNode, useEffect } from "react";
import {
  QueryClient,
  QueryClientProvider,
  useQueryClient,
} from "@tanstack/react-query";
import { toastWithCopy } from "./toast-utils";
import {
  AuthContextType,
  AuthState,
  LoginOptions,
  LogoutOptions,
  AuthError,
} from "./auth-types";
import { AuthContext } from "./auth-context-definition";
import { useAuthStatus } from "../hooks/use-auth-status";
import { userPreferencesKeys } from "../hooks/use-user-preferences";

// Cross-tab communication helper
function broadcastAuthEvent(type: string, data?: unknown): void {
  if (typeof window === "undefined" || !window.BroadcastChannel) {
    return;
  }

  try {
    const channel = new BroadcastChannel("mini-infra-auth");
    channel.postMessage({ type, data });
    channel.close();
  } catch (error) {
    console.warn("Failed to broadcast auth event:", error);
  }
}

// Session persistence utilities
const SESSION_STORAGE_KEY = "mini-infra-session";

interface SessionData {
  lastLoginTime?: string;
  userPreferences?: {
    theme?: string;
    lastVisitedPath?: string;
  };
}

function getSessionData(): SessionData {
  try {
    const data = localStorage.getItem(SESSION_STORAGE_KEY);
    return data ? JSON.parse(data) : {};
  } catch {
    return {};
  }
}

function setSessionData(data: SessionData): void {
  try {
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(data));
  } catch {
    // Handle localStorage errors gracefully
    console.warn("Failed to save session data to localStorage");
  }
}

function clearSessionData(): void {
  try {
    localStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // Handle localStorage errors gracefully
    console.warn("Failed to clear session data from localStorage");
  }
}

// Helper function to parse authentication errors
function parseAuthError(error: unknown): AuthError {
  if (error instanceof Error) {
    // Parse HTTP errors from fetch responses
    if (error.message.includes("401")) {
      return {
        message: "Your session has expired. Please log in again.",
        code: "UNAUTHORIZED",
        statusCode: 401,
      };
    }
    if (error.message.includes("403")) {
      return {
        message:
          "Access denied. You don't have permission to access this resource.",
        code: "FORBIDDEN",
        statusCode: 403,
      };
    }
    if (error.message.includes("429")) {
      return {
        message: "Too many requests. Please wait a moment and try again.",
        code: "RATE_LIMITED",
        statusCode: 429,
      };
    }
    if (
      error.message.includes("500") ||
      error.message.includes("502") ||
      error.message.includes("503")
    ) {
      return {
        message: "Server error. Please try again later.",
        code: "SERVER_ERROR",
        statusCode: 500,
      };
    }
    if (
      error.message.includes("Failed to fetch") ||
      error.message.includes("NetworkError")
    ) {
      return {
        message:
          "Unable to connect to the server. Please check your internet connection.",
        code: "NETWORK_ERROR",
        statusCode: 0,
      };
    }
    return {
      message: error.message,
      code: "UNKNOWN_ERROR",
    };
  }
  return {
    message: "An unknown authentication error occurred.",
    code: "UNKNOWN_ERROR",
  };
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: true, // Enable refetch on focus for better session management
      refetchOnReconnect: true, // Refetch when network reconnects
      staleTime: 1 * 60 * 1000, // 1 minute for auth-related queries
      gcTime: 10 * 60 * 1000, // Keep auth data in cache longer
    },
  },
});

interface AuthProviderProps {
  children: ReactNode;
}

function AuthProviderInner({ children }: AuthProviderProps) {
  const { data: authStatus, refetch, isLoading, error } = useAuthStatus();
  const queryClient = useQueryClient();

  // Cross-tab synchronization using BroadcastChannel
  useEffect(() => {
    if (typeof window === "undefined" || !window.BroadcastChannel) {
      return; // BroadcastChannel not supported
    }

    const channel = new BroadcastChannel("mini-infra-auth");

    const handleAuthEvent = (event: MessageEvent) => {
      const { type } = event.data;

      switch (type) {
        case "AUTH_LOGIN":
          console.log("Authentication detected in another tab, refreshing...");
          refetch();
          break;
        case "AUTH_LOGOUT":
          console.log("Logout detected in another tab, refreshing...");
          refetch();
          break;
        case "AUTH_SYNC_REQUEST":
          // Another tab is requesting auth status, broadcast our current state
          if (authStatus?.isAuthenticated) {
            channel.postMessage({
              type: "AUTH_STATUS",
              data: { isAuthenticated: true, user: authStatus.user },
            });
          }
          break;
      }
    };

    channel.addEventListener("message", handleAuthEvent);

    // Cleanup
    return () => {
      channel.removeEventListener("message", handleAuthEvent);
      channel.close();
    };
  }, [refetch, authStatus]);

  // Handle session persistence and cross-tab sync on authentication state changes
  useEffect(() => {
    if (authStatus?.isAuthenticated && authStatus.user) {
      // User is authenticated, save session data and broadcast login event
      const sessionData = getSessionData();
      const wasAlreadyAuthenticated = sessionData.lastLoginTime;

      setSessionData({
        ...sessionData,
        lastLoginTime: new Date().toISOString(),
      });

      // Prefetch user preferences when user logs in (both new logins and status refreshes)
      queryClient.prefetchQuery({
        queryKey: userPreferencesKeys.preferences(),
        queryFn: async () => {
          const response = await fetch("/api/user/preferences", {
            method: "GET",
            credentials: "include",
          });
          if (!response.ok) {
            throw new Error(
              `Failed to fetch user preferences: ${response.statusText}`,
            );
          }
          const result = await response.json();
          if (!result.success) {
            throw new Error(result.error || "Failed to fetch user preferences");
          }
          return result.data;
        },
        staleTime: 5 * 60 * 1000, // 5 minutes
      });

      // Only broadcast if this is a new login (not just a status refresh)
      if (!wasAlreadyAuthenticated) {
        broadcastAuthEvent("AUTH_LOGIN", { user: authStatus.user });
        toastWithCopy.success(
          `Welcome back, ${authStatus.user.name || authStatus.user.email}!`,
        );
      }
    } else if (authStatus && !authStatus.isAuthenticated) {
      // User is not authenticated, clear session data and broadcast logout
      const sessionData = getSessionData();
      const wasAuthenticated = sessionData.lastLoginTime;

      clearSessionData();

      // Clear user preferences from cache when logging out
      queryClient.removeQueries({
        queryKey: userPreferencesKeys.all,
      });

      // Only broadcast if user was previously authenticated
      if (wasAuthenticated) {
        broadcastAuthEvent("AUTH_LOGOUT");
      }
    }
  }, [authStatus, queryClient]);

  const authState: AuthState = {
    user: authStatus?.user || null,
    isAuthenticated: authStatus?.isAuthenticated || false,
    isLoading,
    error: error ? parseAuthError(error) : null,
  };

  const login = (options?: LoginOptions) => {
    // Use the redirect URL from options or default to current path (not full URL)
    let redirectPath = options?.redirectUrl;
    if (!redirectPath) {
      // Extract just the pathname + search from current location
      redirectPath = window.location.pathname + window.location.search;
    }

    const authUrl = `/auth/google?redirect=${encodeURIComponent(redirectPath)}`;
    console.log(`Initiating OAuth login with redirect: ${redirectPath}`);
    window.location.href = authUrl;
  };

  const logout = async (options?: LogoutOptions) => {
    try {
      const response = await fetch(`/auth/logout`, {
        method: "POST",
        credentials: "include",
      });

      if (response.ok) {
        // Clear session data on successful logout
        clearSessionData();
        // Broadcast logout event to other tabs
        broadcastAuthEvent("AUTH_LOGOUT");
        // Show success message
        toastWithCopy.success("You have been logged out successfully.");
        // Invalidate the auth status query to clear the user state
        await refetch();
        const redirectUrl = options?.redirectUrl || "/";
        if (redirectUrl !== window.location.pathname) {
          window.location.href = redirectUrl;
        }
      } else {
        // Handle different error status codes
        if (response.status === 401) {
          // User was already logged out, just clear state and redirect
          clearSessionData();
          broadcastAuthEvent("AUTH_LOGOUT");
          await refetch();
          const redirectUrl = options?.redirectUrl || "/";
          if (redirectUrl !== window.location.pathname) {
            window.location.href = redirectUrl;
          }
          return;
        }
        const errorText = await response.text().catch(() => "Unknown error");
        const errorMessage = `Logout failed: ${response.status} ${errorText}`;
        toastWithCopy.error(errorMessage);
        throw new Error(errorMessage);
      }
    } catch (error) {
      console.error("Logout error:", error);
      // Re-throw with better error message and show toast
      let errorMessage: string;
      if (error instanceof Error) {
        errorMessage = `Failed to log out: ${error.message}`;
      } else {
        errorMessage = "Failed to log out due to an unknown error";
      }

      // Only show toast if error hasn't been shown already
      if (
        !(error instanceof Error && error.message.includes("Logout failed:"))
      ) {
        toastWithCopy.error(errorMessage);
      }
      throw new Error(errorMessage);
    }
  };

  const contextValue: AuthContextType = {
    authState,
    login,
    logout,
    refetch,
  };

  return (
    <AuthContext.Provider value={contextValue}>{children}</AuthContext.Provider>
  );
}

export function AuthProvider({ children }: AuthProviderProps) {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProviderInner>{children}</AuthProviderInner>
    </QueryClientProvider>
  );
}
