import { useAuth } from "./use-auth";
import { LoginOptions } from "../lib/auth-types";

export interface UseLoginResult {
  loginLocal: (email: string, password: string) => Promise<{ success: boolean; mustResetPwd?: boolean; error?: string }>;
  loginGoogle: (options?: LoginOptions) => void;
  isLoading: boolean;
  isAuthenticated: boolean;
}

export function useLogin(): UseLoginResult {
  const { loginLocal, loginGoogle, authState } = useAuth();

  return {
    loginLocal,
    loginGoogle,
    isLoading: authState.isLoading,
    isAuthenticated: authState.isAuthenticated,
  };
}
