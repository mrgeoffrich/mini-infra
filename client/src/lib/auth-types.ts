export interface User {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  googleId: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuthStatus {
  isAuthenticated: boolean;
  user: User | null;
  sessionId: string | null;
}

export interface ApiKey {
  id: string;
  name: string;
  key: string;
  active: boolean;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuthError {
  message: string;
  code?: string;
  statusCode?: number;
}

export interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: AuthError | null;
}

export interface LoginOptions {
  redirectUrl?: string;
}

export interface LogoutOptions {
  redirectUrl?: string;
}

export interface CreateApiKeyRequest {
  name: string;
}

export interface ApiKeyResponse {
  success: boolean;
  data: ApiKey;
  message?: string;
}

export interface AuthResponse {
  success: boolean;
  data: AuthStatus;
  message?: string;
}

export type AuthContextType = {
  authState: AuthState;
  login: (options?: LoginOptions) => void;
  logout: (options?: LogoutOptions) => Promise<void>;
  refetch: () => Promise<unknown>;
};
