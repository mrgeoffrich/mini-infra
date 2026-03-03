import { useAuth } from "./use-auth";
import { User } from "../lib/auth-types";

export interface UseUserResult {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
}

export function useUser(): UseUserResult {
  const { authState } = useAuth();

  return {
    user: authState.user,
    isAuthenticated: authState.isAuthenticated,
    isLoading: authState.isLoading,
  };
}
