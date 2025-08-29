import { Request, Response, NextFunction } from "express";
import { verifyToken, extractTokenFromHeader, extractTokenFromCookie, JwtPayload } from "./jwt";
import prisma from "./prisma";
import logger from "./logger";
import { AuthErrorType, createAuthErrorResponse } from "./auth-middleware";

// Extend Express Request type to include JWT user
declare module 'express' {
  interface Request {
    user?: {
      id: string;
      email: string;
      name?: string;
      image?: string;
      createdAt: Date;
    };
    jwtPayload?: JwtPayload;
  }
}

/**
 * Extract JWT token from request (Authorization header or cookie)
 */
function extractToken(req: Request): string | null {
  // Try Authorization header first (Bearer token)
  let token = extractTokenFromHeader(req.headers.authorization);
  
  if (!token) {
    // Fallback to cookie
    token = extractTokenFromCookie(req.cookies);
  }

  return token;
}

/**
 * Middleware to extract and validate JWT token
 * Sets req.user and req.jwtPayload if token is valid
 */
export const extractJwtUser = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const requestId = req.headers["x-request-id"] as string;

  try {
    // Skip JWT extraction for certain routes
    if (
      (req.path.startsWith("/auth") && req.path !== "/auth/status" && req.path !== "/auth/user") ||
      req.path === "/health" ||
      req.path.startsWith("/api/keys") // API keys use separate auth
    ) {
      return next();
    }

    const token = extractToken(req);

    if (!token) {
      logger.debug({ requestId, path: req.path }, "No JWT token found in request");
      return next();
    }

    // Verify and decode the token
    const payload = verifyToken(token);
    req.jwtPayload = payload;

    // Get user from database to ensure they still exist
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        email: true,
        name: true,
        image: true,
        createdAt: true,
      },
    });

    if (!user) {
      logger.warn(
        { userId: payload.sub, requestId, path: req.path },
        "JWT token valid but user not found in database",
      );
      return next();
    }

    req.user = {
      id: user.id,
      email: user.email,
      name: user.name || undefined,
      image: user.image || undefined,
      createdAt: user.createdAt,
    };

    logger.debug(
      { userId: user.id, requestId, path: req.path },
      "JWT authentication successful",
    );

    next();
  } catch (error) {
    logger.warn(
      { error: (error as Error).message, requestId, path: req.path },
      "JWT token validation failed",
    );

    // Clear any potentially corrupted auth cookie
    if (req.cookies && req.cookies["auth-token"]) {
      res.clearCookie("auth-token");
    }

    next(); // Continue without authentication
  }
};

/**
 * Middleware to require JWT authentication
 */
export const requireJwtAuth = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  const requestId = req.headers["x-request-id"] as string;

  logger.debug(
    { requestId, path: req.path },
    "Validating JWT-based authentication",
  );

  try {
    if (!req.user) {
      logger.warn(
        { requestId, path: req.path, ip: req.ip },
        "JWT authentication required but no user found",
      );

      const errorResponse = createAuthErrorResponse(
        AuthErrorType.AUTHENTICATION_REQUIRED,
        "Authentication required. Please log in to access this resource.",
        requestId,
      );

      res.status(401).json(errorResponse);
      return;
    }

    logger.debug(
      { requestId, path: req.path, userId: req.user.id },
      "JWT authentication successful",
    );

    next();
  } catch (error) {
    logger.error(
      { error, requestId, path: req.path },
      "Error during JWT authentication",
    );

    const errorResponse = createAuthErrorResponse(
      AuthErrorType.UNAUTHORIZED,
      "Authentication error occurred. Please try again.",
      requestId,
    );

    res.status(500).json(errorResponse);
  }
};

/**
 * Middleware for optional JWT authentication
 */
export const optionalJwtAuth = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  const requestId = req.headers["x-request-id"] as string;

  try {
    if (req.user) {
      logger.debug(
        { requestId, path: req.path, userId: req.user.id },
        "Optional JWT authentication found user",
      );
    } else {
      logger.debug(
        { requestId, path: req.path },
        "No JWT authentication provided for optional auth",
      );
    }

    next();
  } catch (error) {
    logger.error(
      { error, requestId, path: req.path },
      "Error during optional JWT authentication",
    );
    next(); // Continue without authentication on error
  }
};

/**
 * Get current user ID from JWT context
 */
export const getCurrentUserIdFromJwt = (req: Request): string | null => {
  return req.user?.id || null;
};

/**
 * Get current user from JWT context
 */
export const getCurrentUserFromJwt = (req: Request) => {
  return req.user || null;
};

/**
 * Utility function to check if request is authenticated via JWT
 */
export const isJwtAuthenticated = (req: Request): boolean => {
  return !!req.user;
};