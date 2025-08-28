import { useState } from "react";
import { useAuth } from "./use-auth";
import { LogoutOptions } from "../lib/auth-types";

export interface UseLogoutResult {
  logout: (options?: LogoutOptions) => Promise<void>;
  isLoggingOut: boolean;
  error: string | null;
}

export function useLogout(): UseLogoutResult {
  const { logout: authLogout } = useAuth();
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const logout = async (options?: LogoutOptions) => {
    setIsLoggingOut(true);
    setError(null);

    try {
      await authLogout(options);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Logout failed";
      setError(errorMessage);
      throw err;
    } finally {
      setIsLoggingOut(false);
    }
  };

  return {
    logout,
    isLoggingOut,
    error,
  };
}
