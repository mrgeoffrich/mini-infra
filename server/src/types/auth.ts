// TypeScript type definitions for authentication

// User type from Prisma (for type safety)
export interface User {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  googleId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// User profile information for API responses
export interface UserProfile {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  createdAt: Date;
}

// Authentication status response
export interface AuthStatus {
  authenticated: boolean;
  user: UserProfile | null;
}

// Google OAuth profile interface (extends the basic profile)
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

// JWT User interface (similar to session user but for JWT context)
export interface JWTUser {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  createdAt: Date;
}

// Augment Express Request interface to include user
declare module "express-serve-static-core" {
  interface Request {
    user?: JWTUser;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logout(done: (err: any) => void): void;
  }
}

// Passport strategy callback function type
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PassportDoneCallback = (error: any, user?: any, info?: any) => void;

// OAuth callback handler type
export type OAuthCallbackHandler = (
  issuer: string,
  profile: GoogleOAuthProfile,
  done: PassportDoneCallback,
) => Promise<void> | void;

// API Key type from Prisma (for type safety)
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

// API Key creation request
export interface CreateApiKeyRequest {
  name: string;
}

// API Key response (without the actual key after creation)
export interface ApiKeyResponse {
  id: string;
  name: string;
  userId: string;
  active: boolean;
  lastUsedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// API Key creation response (includes the key only on creation)
export interface CreateApiKeyResponse extends ApiKeyResponse {
  key: string;
}

// API Key validation result
export interface ApiKeyValidationResult {
  valid: boolean;
  userId?: string;
  keyId?: string;
  user?: JWTUser;
}

// Augment Express Request interface to include API key authentication
declare module "express-serve-static-core" {
  interface Request {
    apiKey?: {
      id: string;
      userId: string;
      user: JWTUser;
    };
  }
}
