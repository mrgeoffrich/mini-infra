import jwt from "jsonwebtoken";
import { appLogger } from "./logger-factory";
import { getAuthSecret } from "./security-config";

const logger = appLogger();
import type { UserProfile } from "@mini-infra/types";

// JWT payload interface
export interface JwtPayload {
  sub: string; // User ID
  email: string;
  name?: string;
  image?: string;
  mustResetPwd?: boolean;
  iat?: number; // Issued at
  exp?: number; // Expires at
}

// JWT configuration
const JWT_EXPIRES_IN = "24h"; // 24 hours
const JWT_ISSUER = "mini-infra";

/**
 * Generate a JWT token for a user
 */
export const generateToken = (
  user: UserProfile,
  options?: { mustResetPwd?: boolean },
): string => {
  try {
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      name: user.name || undefined,
      image: user.image || undefined,
      ...(options?.mustResetPwd ? { mustResetPwd: true } : {}),
    };

    const token = jwt.sign(payload, getAuthSecret(), {
      expiresIn: JWT_EXPIRES_IN,
      issuer: JWT_ISSUER,
      algorithm: "HS256",
    });

    logger.debug({ userId: user.id }, "JWT token generated successfully");
    return token;
  } catch (error) {
    logger.error({ error, userId: user.id }, "Error generating JWT token");
    throw new Error("Failed to generate authentication token", {
      cause: error,
    });
  }
};

/**
 * Verify and decode a JWT token
 */
export const verifyToken = (token: string): JwtPayload => {
  try {
    const decoded = jwt.verify(token, getAuthSecret(), {
      issuer: JWT_ISSUER,
      algorithms: ["HS256"],
    }) as JwtPayload;

    return decoded;
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError) {
      logger.debug({ error: error.message }, "Invalid JWT token");
      throw new Error("Invalid authentication token", { cause: error });
    }
    if (error instanceof jwt.TokenExpiredError) {
      logger.debug("JWT token expired");
      throw new Error("Authentication token expired", { cause: error });
    }
    if (error instanceof jwt.NotBeforeError) {
      logger.debug("JWT token not active");
      throw new Error("Authentication token not yet valid", { cause: error });
    }

    logger.error({ error }, "Unexpected error verifying JWT token");
    throw new Error("Token verification failed", { cause: error });
  }
};

/**
 * Extract token from Authorization header
 */
export const extractTokenFromHeader = (authHeader?: string): string | null => {
  if (!authHeader) {
    return null;
  }

  // Check for Bearer token format
  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") {
    return null;
  }

  return parts[1];
};

/**
 * Extract token from cookies
 */
export const extractTokenFromCookie = (
  cookies: Record<string, string>,
  cookieName: string = "auth-token",
): string | null => {
  if (!cookies || !cookies[cookieName]) {
    return null;
  }

  return cookies[cookieName];
};

/**
 * Decode token without verification (for debugging/logging)
 */
export const decodeToken = (token: string): JwtPayload | null => {
  try {
    const decoded = jwt.decode(token) as JwtPayload;
    return decoded;
  } catch (error) {
    logger.warn({ error }, "Failed to decode JWT token");
    return null;
  }
};

/**
 * Get token expiration time
 */
export const getTokenExpiration = (token: string): Date | null => {
  try {
    const decoded = decodeToken(token);
    if (!decoded || !decoded.exp) {
      return null;
    }

    return new Date(decoded.exp * 1000);
  } catch (error) {
    logger.warn({ error }, "Failed to get token expiration");
    return null;
  }
};

/**
 * Check if token is expired
 */
export const isTokenExpired = (token: string): boolean => {
  try {
    const expiration = getTokenExpiration(token);
    if (!expiration) {
      return true; // Consider invalid tokens as expired
    }

    return new Date() >= expiration;
  } catch {
    return true; // Consider invalid tokens as expired
  }
};
