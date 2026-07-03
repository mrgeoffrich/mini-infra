import { ReactNode, useEffect } from "react";
import {
  QueryClient,
  QueryClientProvider,
  useQueryClient,
} from "@tanstack/react-query";
import { ApiRoute, queryKeys } from "@mini-infra/types";
import { apiFetch, ApiRequestError } from "./api-client";
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
    console.warn("Failed to save session data to localStorage");
  }
}

function clearSessionData(): void {
  try {
    localStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    console.warn("Failed to clear session data from localStorage");
  }
}

// Helper function to parse authentication errors
function parseAuthError(error: unknown): AuthError {
  if (error instanceof Error) {
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
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      staleTime: 1 * 60 * 1000,
      gcTime: 10 * 60 * 1000,
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
      return;
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

    return () => {
      channel.removeEventListener("message", handleAuthEvent);
      channel.close();
    };
  }, [refetch, authStatus]);

  // Handle session persistence and cross-tab sync on authentication state changes
  useEffect(() => {
    if (authStatus?.isAuthenticated && authStatus.user) {
      const sessionData = getSessionData();
      const wasAlreadyAuthenticated = sessionData.lastLoginTime;

      setSessionData({
        ...sessionData,
        lastLoginTime: new Date().toISOString(),
      });

      // Prefetch user preferences when user logs in
      queryClient.prefetchQuery({
        queryKey: queryKeys.userPreferences.preferences,
        queryFn: () =>
          apiFetch(ApiRoute.userPreferences.preferences(), {
            correlationIdPrefix: "auth",
          }),
        staleTime: 5 * 60 * 1000,
      });

      if (!wasAlreadyAuthenticated) {
        broadcastAuthEvent("AUTH_LOGIN", { user: authStatus.user });
        toastWithCopy.success(
          `Welcome back, ${authStatus.user.name || authStatus.user.email}!`,
        );
      }
    } else if (authStatus && !authStatus.isAuthenticated) {
      const sessionData = getSessionData();
      const wasAuthenticated = sessionData.lastLoginTime;

      clearSessionData();

      queryClient.removeQueries({
        queryKey: queryKeys.userPreferences.all,
      });

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
    mustResetPwd: authStatus?.mustResetPwd || false,
  };

  const loginLocal = async (
    email: string,
    password: string,
  ): Promise<{ success: boolean; mustResetPwd?: boolean; error?: string }> => {
    try {
      // /auth/login returns { success, mustResetPwd } on success and
      // { error: "..." } on failure — neither matches the standard
      // {success,data} envelope, so this call opts out of apiFetch's
      // automatic unwrap/throw and reads the raw body itself.
      const data = await apiFetch<{ success: boolean; mustResetPwd?: boolean }>(
        ApiRoute.auth.login(),
        {
          method: "POST",
          body: { email, password },
          unwrap: false,
          correlationIdPrefix: "auth",
        },
      );

      // Refetch auth status to update state
      await refetch();
      broadcastAuthEvent("AUTH_LOGIN");

      return { success: true, mustResetPwd: data.mustResetPwd };
    } catch (error) {
      if (error instanceof ApiRequestError) {
        const body = error.body as { error?: string } | undefined;
        return { success: false, error: body?.error || "Login failed" };
      }
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "An unexpected error occurred",
      };
    }
  };

  const loginGoogle = (options?: LoginOptions) => {
    let redirectPath = options?.redirectUrl;
    if (!redirectPath) {
      redirectPath = window.location.pathname + window.location.search;
    }

    const authUrl = `${ApiRoute.auth.google()}?redirect=${encodeURIComponent(redirectPath)}`;
    window.location.href = authUrl;
  };

  const logout = async (options?: LogoutOptions) => {
    try {
      // /auth/logout returns { message: "..." } on success and
      // { error: "..." } on failure — not the standard envelope, so this
      // opts out of apiFetch's automatic unwrap.
      await apiFetch(ApiRoute.auth.logout(), {
        method: "POST",
        unwrap: false,
        correlationIdPrefix: "auth",
      });

      clearSessionData();
      broadcastAuthEvent("AUTH_LOGOUT");
      toastWithCopy.success("You have been logged out successfully.");
      await refetch();
      const redirectUrl = options?.redirectUrl || "/";
      if (redirectUrl !== window.location.pathname) {
        window.location.href = redirectUrl;
      }
    } catch (error) {
      if (error instanceof ApiRequestError && error.isAuth) {
        // Already logged out (401) — treat as success, not an error.
        clearSessionData();
        broadcastAuthEvent("AUTH_LOGOUT");
        await refetch();
        const redirectUrl = options?.redirectUrl || "/";
        if (redirectUrl !== window.location.pathname) {
          window.location.href = redirectUrl;
        }
        return;
      }

      console.error("Logout error:", error);
      let errorMessage: string;
      if (error instanceof ApiRequestError) {
        const body = error.body as { error?: string } | undefined;
        errorMessage = `Logout failed: ${error.status} ${body?.error ?? error.message}`;
      } else if (error instanceof Error) {
        errorMessage = `Failed to log out: ${error.message}`;
      } else {
        errorMessage = "Failed to log out due to an unknown error";
      }

      // Single toast here (the pre-migration code toasted once inline for
      // the HTTP-failure path and once more in this catch for anything
      // else, with a message-substring guard to avoid double-toasting a
      // re-thrown HTTP failure — now that both paths funnel through this
      // one catch, a single unconditional toast covers both cases).
      toastWithCopy.error(errorMessage);
      throw new Error(errorMessage, { cause: error });
    }
  };

  const contextValue: AuthContextType = {
    authState,
    loginLocal,
    loginGoogle,
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
