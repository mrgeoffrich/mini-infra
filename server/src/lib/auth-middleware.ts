import { Request, Response, NextFunction } from "express";
import logger from "./logger.js";
import { getCurrentUser, getCurrentUserId } from "./api-key-middleware.js";

/**
 * Authentication error types for standardized responses
 */
export enum AuthErrorType {
  UNAUTHORIZED = "unauthorized",
  FORBIDDEN = "forbidden",
  INVALID_SESSION = "invalid_session",
  INVALID_API_KEY = "invalid_api_key",
  AUTHENTICATION_REQUIRED = "authentication_required",
}

/**
 * Standardized authentication error response interface
 */
export interface AuthErrorResponse {
  error: string;
  type: AuthErrorType;
  message: string;
  timestamp: string;
  requestId?: string;
}

/**
 * Create a standardized authentication error response
 */
export function createAuthErrorResponse(
  type: AuthErrorType,
  message: string,
  requestId?: string,
): AuthErrorResponse {
  return {
    error: "Authentication Error",
    type,
    message,
    timestamp: new Date().toISOString(),
    requestId,
  };
}

/**
 * Middleware to require session-based authentication
 * Only allows requests from authenticated users with valid sessions
 */
export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const requestId = req.headers["x-request-id"] as string;

  logger.debug(
    { requestId, path: req.path },
    "Validating session-based authentication",
  );

  try {
    // Check if user is authenticated via session
    if (!req.user) {
      logger.warn(
        { requestId, path: req.path, ip: req.ip },
        "Session authentication failed: no user in session",
      );

      const errorResponse = createAuthErrorResponse(
        AuthErrorType.AUTHENTICATION_REQUIRED,
        "Authentication required. Please log in to access this resource.",
        requestId,
      );

      res.status(401).json(errorResponse);
      return;
    }

    // Additional session validation
    if (!req.session || !req.sessionID) {
      logger.warn(
        { requestId, path: req.path, ip: req.ip, userId: req.user.id },
        "Session authentication failed: invalid session state",
      );

      const errorResponse = createAuthErrorResponse(
        AuthErrorType.INVALID_SESSION,
        "Invalid session. Please log in again.",
        requestId,
      );

      res.status(401).json(errorResponse);
      return;
    }

    logger.debug(
      { requestId, path: req.path, userId: req.user.id },
      "Session authentication successful",
    );

    next();
  } catch (error) {
    logger.error(
      { error, requestId, path: req.path },
      "Error during session authentication",
    );

    const errorResponse = createAuthErrorResponse(
      AuthErrorType.UNAUTHORIZED,
      "Authentication error occurred. Please try again.",
      requestId,
    );

    res.status(500).json(errorResponse);
  }
}

/**
 * Middleware for optional authentication that works with both session and API key
 * Validates authentication if present, but allows request to continue if not
 * Provides consistent user context regardless of authentication method
 */
export function optionalAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const requestId = req.headers["x-request-id"] as string;

  try {
    // Get current user from either session or API key
    const user = getCurrentUser(req);

    if (user) {
      logger.debug(
        {
          requestId,
          path: req.path,
          userId: user.id,
          authMethod: req.user ? "session" : "api_key",
        },
        "Optional authentication found user",
      );
    } else {
      logger.debug(
        { requestId, path: req.path },
        "No authentication provided for optional auth",
      );
    }

    next();
  } catch (error) {
    logger.error(
      { error, requestId, path: req.path },
      "Error during optional authentication",
    );
    // Continue without authentication on error for optional middleware
    next();
  }
}

/**
 * Authorization middleware that checks if the authenticated user can access a resource
 * For now, this is a basic implementation that just ensures the user is authenticated
 * Can be extended for role-based access control in the future
 */
export function requireAuthorization(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const requestId = req.headers["x-request-id"] as string;
  const user = getCurrentUser(req);
  const userId = getCurrentUserId(req);

  logger.debug(
    { requestId, path: req.path, userId },
    "Checking user authorization",
  );

  try {
    if (!user || !userId) {
      logger.warn(
        { requestId, path: req.path, ip: req.ip },
        "Authorization failed: user not authenticated",
      );

      const errorResponse = createAuthErrorResponse(
        AuthErrorType.FORBIDDEN,
        "Access denied. Authentication required to access this resource.",
        requestId,
      );

      res.status(403).json(errorResponse);
      return;
    }

    // Basic authorization check - user is authenticated
    // In the future, this could check roles, permissions, resource ownership, etc.
    logger.debug(
      { requestId, path: req.path, userId },
      "User authorization successful",
    );

    next();
  } catch (error) {
    logger.error(
      { error, requestId, path: req.path, userId },
      "Error during authorization check",
    );

    const errorResponse = createAuthErrorResponse(
      AuthErrorType.FORBIDDEN,
      "Authorization error occurred. Access denied.",
      requestId,
    );

    res.status(500).json(errorResponse);
  }
}

/**
 * Middleware that ensures a user can only access their own resources
 * Checks if the authenticated user ID matches the userId parameter or body
 */
export function requireOwnership(paramName: string = "userId") {
  return (req: Request, res: Response, next: NextFunction): void => {
    const requestId = req.headers["x-request-id"] as string;
    const currentUserId = getCurrentUserId(req);

    logger.debug(
      { requestId, path: req.path, currentUserId, paramName },
      "Checking resource ownership",
    );

    try {
      if (!currentUserId) {
        logger.warn(
          { requestId, path: req.path, ip: req.ip },
          "Ownership check failed: no authenticated user",
        );

        const errorResponse = createAuthErrorResponse(
          AuthErrorType.AUTHENTICATION_REQUIRED,
          "Authentication required to access this resource.",
          requestId,
        );

        res.status(401).json(errorResponse);
        return;
      }

      // Check userId in URL parameters
      const resourceUserId =
        req.params[paramName] ||
        req.body?.[paramName] ||
        req.query?.[paramName];

      if (resourceUserId && resourceUserId !== currentUserId) {
        logger.warn(
          {
            requestId,
            path: req.path,
            currentUserId,
            resourceUserId,
            paramName,
          },
          "Ownership check failed: user does not own resource",
        );

        const errorResponse = createAuthErrorResponse(
          AuthErrorType.FORBIDDEN,
          "Access denied. You can only access your own resources.",
          requestId,
        );

        res.status(403).json(errorResponse);
        return;
      }

      logger.debug(
        { requestId, path: req.path, currentUserId },
        "Resource ownership verified",
      );

      next();
    } catch (error) {
      logger.error(
        { error, requestId, path: req.path, currentUserId },
        "Error during ownership check",
      );

      const errorResponse = createAuthErrorResponse(
        AuthErrorType.FORBIDDEN,
        "Authorization error occurred. Access denied.",
        requestId,
      );

      res.status(500).json(errorResponse);
    }
  };
}

/**
 * Middleware composition utilities for common authentication patterns
 */

/**
 * Compose multiple middleware functions into a single middleware
 */
export function composeMiddleware(
  ...middlewares: Array<
    (req: Request, res: Response, next: NextFunction) => void
  >
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    let index = 0;

    function dispatch(i: number): void {
      if (i <= index) {
        throw new Error("next() called multiple times");
      }
      index = i;

      if (i >= middlewares.length) {
        return next();
      }

      const middleware = middlewares[i];
      try {
        middleware(req, res, () => dispatch(i + 1));
      } catch (error) {
        next(error);
      }
    }

    dispatch(0);
  };
}

/**
 * Pre-composed middleware combinations for common use cases
 */
export const authMiddleware = {
  /**
   * Require session-based authentication
   */
  requireSession: requireAuth,

  /**
   * Require API key authentication (re-exported for convenience)
   */
  requireApiKey: async (req: Request, res: Response, next: NextFunction) => {
    const { requireApiKey } = await import("./api-key-middleware.js");
    return requireApiKey(req, res, next);
  },

  /**
   * Accept either session or API key authentication
   */
  requireSessionOrApiKey: async (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => {
    const { requireSessionOrApiKey } = await import("./api-key-middleware.js");
    return requireSessionOrApiKey(req, res, next);
  },

  /**
   * Optional authentication (session or API key)
   */
  optional: optionalAuth,

  /**
   * Require authentication and authorization
   */
  requireAuthAndAuthorization: composeMiddleware(
    optionalAuth,
    requireAuthorization,
  ),

  /**
   * Require session-based auth with ownership check
   */
  requireSessionWithOwnership: (paramName: string = "userId") =>
    composeMiddleware(requireAuth, requireOwnership(paramName)),

  /**
   * Require any authentication method with ownership check
   */
  requireAuthWithOwnership: (paramName: string = "userId") =>
    composeMiddleware(
      optionalAuth,
      requireAuthorization,
      requireOwnership(paramName),
    ),
};

/**
 * Utility function to extract user information for API responses
 * Works with both session-based and API key authentication
 */
export function getAuthenticatedUser(req: Request) {
  const user = getCurrentUser(req);
  if (!user) return null;

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    image: user.image,
    createdAt: user.createdAt,
  };
}

/**
 * Utility function to check if request is authenticated
 */
export function isAuthenticated(req: Request): boolean {
  return getCurrentUserId(req) !== null;
}

/**
 * Utility function to get the authentication method used
 */
export function getAuthMethod(req: Request): "session" | "api_key" | null {
  if (req.user) return "session";
  if (req.apiKey) return "api_key";
  return null;
}
