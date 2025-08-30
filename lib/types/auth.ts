// ====================
// Core User Types
// ====================

// Database User type (matches Prisma schema)
export interface User {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  googleId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// User profile for API responses (cleaner, frontend-friendly)
export interface UserProfile {
  id: string;
  email: string;
  name?: string;
  image?: string;
  createdAt: string; // ISO string for JSON serialization
}

// JWT User type for request context
export interface JWTUser {
  id: string;
  email: string;
  name?: string;
  image?: string;
  createdAt: Date;
}

// ====================
// Authentication Types
// ====================

export interface AuthStatus {
  isAuthenticated: boolean;
  user: UserProfile | null;
}

export interface AuthState {
  user: UserProfile | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: AuthError | null;
}

export interface AuthError {
  message: string;
  code?: string;
  statusCode?: number;
}

// ====================
// OAuth Types
// ====================

export interface GoogleOAuthProfile {
  id: string;
  displayName?: string;
  emails?: Array<{
    value: string;
    verified?: boolean;
  }>;
  photos?: Array<{
    value: string;
  }>;
  provider: string;
}

// ====================
// API Key Types
// ====================

export interface ApiKey {
  id: string;
  name: string;
  key: string;
  userId: string;
  active: boolean;
  lastUsedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// API Key for frontend (without sensitive data)
export interface ApiKeyInfo {
  id: string;
  name: string;
  active: boolean;
  lastUsedAt: string | null; // ISO string
  createdAt: string; // ISO string
  updatedAt: string; // ISO string
}

export interface CreateApiKeyRequest {
  name: string;
}

export interface CreateApiKeyResponse extends ApiKeyInfo {
  key: string; // Only present on creation
}

export interface ApiKeyValidationResult {
  valid: boolean;
  userId?: string;
  keyId?: string;
  user?: JWTUser;
}

// ====================
// Authentication Options
// ====================

export interface LoginOptions {
  redirectUrl?: string;
}

export interface LogoutOptions {
  redirectUrl?: string;
}

// ====================
// Frontend Context Types
// ====================

export type AuthContextType = {
  authState: AuthState;
  login: (options?: LoginOptions) => void;
  logout: (options?: LogoutOptions) => Promise<void>;
  refetch: () => Promise<unknown>;
};

// ====================
// API Response Types
// ====================

export interface AuthResponse {
  success: boolean;
  data: AuthStatus;
  message?: string;
}

export interface ApiKeyResponse {
  success: boolean;
  data: ApiKeyInfo;
  message?: string;
}

// ====================
// Server-only Types
// ====================

// These types are only used on the server side and should not be imported by the client

export type PassportDoneCallback = (error: any, user?: any, info?: any) => void;

export type OAuthCallbackHandler = (
  issuer: string,
  profile: GoogleOAuthProfile,
  done: PassportDoneCallback,
) => Promise<void> | void;

// Express Request augmentation (server-only)
declare module "express-serve-static-core" {
  interface Request {
    user?: JWTUser;
    apiKey?: {
      id: string;
      userId: string;
      user: JWTUser;
    };
    logout(done: (err: any) => void): void;
  }
}
