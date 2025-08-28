import { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  AuthContextType,
  AuthState,
  LoginOptions,
  LogoutOptions,
} from "./auth-types";
import { AuthContext } from "./auth-context-definition";
import { useAuthStatus } from "../hooks/use-auth-status";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 5 * 60 * 1000, // 5 minutes
    },
  },
});

interface AuthProviderProps {
  children: ReactNode;
}

function AuthProviderInner({ children }: AuthProviderProps) {
  const { data: authStatus, refetch, isLoading, error } = useAuthStatus();

  const authState: AuthState = {
    user: authStatus?.user || null,
    isAuthenticated: authStatus?.isAuthenticated || false,
    isLoading,
    error: error
      ? {
          message:
            error instanceof Error ? error.message : "Authentication error",
          statusCode: 500,
        }
      : null,
  };

  const login = (options?: LoginOptions) => {
    const redirectUrl = options?.redirectUrl || window.location.href;
    const authUrl = `/api/auth/google?redirect=${encodeURIComponent(redirectUrl)}`;
    window.location.href = authUrl;
  };

  const logout = async (options?: LogoutOptions) => {
    try {
      const response = await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "include",
      });

      if (response.ok) {
        await refetch();
        const redirectUrl = options?.redirectUrl || "/";
        if (redirectUrl !== window.location.pathname) {
          window.location.href = redirectUrl;
        }
      } else {
        throw new Error("Logout failed");
      }
    } catch (error) {
      console.error("Logout error:", error);
      throw error;
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

