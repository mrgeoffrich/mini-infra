import { useAuth } from "./use-auth";
import { LoginOptions } from "../lib/auth-types";

export interface UseLoginResult {
  login: (options?: LoginOptions) => void;
  isLoading: boolean;
  isAuthenticated: boolean;
}

export function useLogin(): UseLoginResult {
  const { login, authState } = useAuth();

  return {
    login,
    isLoading: authState.isLoading,
    isAuthenticated: authState.isAuthenticated,
  };
}
