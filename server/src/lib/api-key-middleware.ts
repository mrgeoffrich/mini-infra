import { Request, Response, NextFunction } from "express";
import { validateApiKey } from "./api-key-service";
import { getLogger } from "./logger-factory";
import { getContext } from "./logging-context";

const logger = getLogger("auth", "api-key-middleware");
import type { ApiKeyValidationResult } from "@mini-infra/types";

/**
 * Middleware to require API key authentication
 * Looks for API key in Authorization header: "Bearer mk_..."
 * or in x-api-key header: "mk_..."
 */
export async function requireApiKey(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const requestId = getContext()?.requestId ?? "unknown";

  logger.debug(
    { requestId, path: req.path },
    "Validating API key authentication",
  );

  try {
    // Extract API key from headers
    const apiKey = extractApiKeyFromRequest(req);

    if (!apiKey) {
      logger.warn(
        { requestId, path: req.path, ip: req.ip },
        "API key authentication failed: no key provided",
      );
      res.status(401).json({
        error: "API key required",
        message:
          "Provide API key in Authorization header (Bearer token) or x-api-key header",
      });
      return;
    }

    // Validate the API key
    const validationResult: ApiKeyValidationResult =
      await validateApiKey(apiKey);

    if (!validationResult.valid) {
      logger.warn(
        { requestId, path: req.path, ip: req.ip },
        "API key authentication failed: invalid key",
      );
      res.status(401).json({
        error: "Invalid API key",
        message: "The provided API key is invalid or inactive",
      });
      return;
    }

    // Add API key info to request object for downstream middleware.
    // System keys (agent sidecar etc.) have no associated user.
    req.apiKey = {
      id: validationResult.keyId!,
      userId: validationResult.userId ?? null,
      user: validationResult.user ?? null,
      permissions: validationResult.permissions ?? null,
    };

    logger.debug(
      {
        requestId,
        path: req.path,
        userId: validationResult.userId,
        keyId: validationResult.keyId,
      },
      "API key authentication successful",
    );

    next();
  } catch (error) {
    logger.error(
      { error, requestId, path: req.path },
      "Error during API key authentication",
    );
    res.status(500).json({
      error: "Authentication error",
      message: "Internal server error during authentication",
    });
  }
}

/**
 * Middleware for optional API key authentication
 * Validates API key if present, but allows request to continue if not
 */
export async function optionalApiKey(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const requestId = getContext()?.requestId ?? "unknown";

  try {
    // Extract API key from headers
    const apiKey = extractApiKeyFromRequest(req);

    if (!apiKey) {
      // No API key provided, continue without authentication
      logger.debug(
        { requestId, path: req.path },
        "No API key provided for optional auth",
      );
      next();
      return;
    }

    // Validate the API key if provided
    const validationResult: ApiKeyValidationResult =
      await validateApiKey(apiKey);

    if (validationResult.valid) {
      // Add API key info to request object
      req.apiKey = {
        id: validationResult.keyId!,
        userId: validationResult.userId ?? null,
        user: validationResult.user ?? null,
        permissions: validationResult.permissions ?? null,
      };

      logger.debug(
        {
          requestId,
          path: req.path,
          userId: validationResult.userId,
          keyId: validationResult.keyId,
        },
        "Optional API key authentication successful",
      );
    } else {
      logger.warn(
        { requestId, path: req.path },
        "Invalid API key provided for optional auth",
      );
    }

    next();
  } catch (error) {
    logger.error(
      { error, requestId, path: req.path },
      "Error during optional API key authentication",
    );
    // Continue without authentication on error for optional middleware
    next();
  }
}

/**
 * Middleware that accepts both session-based and API key authentication
 * Useful for endpoints that can be accessed by both web users and API clients
 */
export async function requireSessionOrApiKey(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const requestId = getContext()?.requestId ?? "unknown";


  try {
    // Check if user is authenticated via session
    if (req.user) {
      next();
      return;
    }

    // If no session, try API key authentication
    const apiKey = extractApiKeyFromRequest(req);

    if (!apiKey) {
      logger.warn(
        { requestId, path: req.path, ip: req.ip },
        "Authentication failed: no session or API key",
      );
      res.status(401).json({
        error: "Authentication required",
        message: "Login required or provide valid API key",
      });
      return;
    }

    // Validate the API key
    const validationResult: ApiKeyValidationResult =
      await validateApiKey(apiKey);

    if (!validationResult.valid) {
      logger.warn(
        { requestId, path: req.path, ip: req.ip },
        "Authentication failed: invalid API key and no session",
      );
      res.status(401).json({
        error: "Authentication failed",
        message: "Invalid API key and no valid session",
      });
      return;
    }

    // Add API key info to request object
    req.apiKey = {
      id: validationResult.keyId!,
      userId: validationResult.userId ?? null,
      user: validationResult.user ?? null,
      permissions: validationResult.permissions ?? null,
    };

    logger.debug(
      {
        requestId,
        path: req.path,
        userId: validationResult.userId,
        keyId: validationResult.keyId,
      },
      "API key authentication successful (no session)",
    );

    next();
  } catch (error) {
    logger.error(
      { error, requestId, path: req.path },
      "Error during session/API key authentication",
    );
    res.status(500).json({
      error: "Authentication error",
      message: "Internal server error during authentication",
    });
  }
}

/**
 * Extract API key from request headers
 * Checks both Authorization header (Bearer token) and x-api-key header
 */
function extractApiKeyFromRequest(req: Request): string | null {
  // Check Authorization header first (Bearer token format)
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.substring(7); // Remove "Bearer " prefix
    if (token.startsWith("mk_")) {
      return token;
    }
  }

  // Check x-api-key header
  const apiKeyHeader = req.headers["x-api-key"] as string;
  if (apiKeyHeader && apiKeyHeader.startsWith("mk_")) {
    return apiKeyHeader;
  }

  return null;
}

/**
 * Sentinel actor id used for requests authenticated via a system-scoped API
 * key (e.g. the built-in agent sidecar). Stored in audit fields like
 * `createdBy` / `updatedBy` when no human user is driving the request.
 */
export const SYSTEM_ACTOR_ID = "system";

/**
 * Utility function to get the current user from either session or API key.
 * Returns the user object regardless of authentication method, or null when
 * the request is authed via a system API key (no user attached).
 */
export function getCurrentUser(req: Request) {
  // Return session user if available
  if (req.user) {
    return req.user;
  }

  // Return API key user if available
  if (req.apiKey && req.apiKey.user) {
    return req.apiKey.user;
  }

  return null;
}

/**
 * Utility function to get the current actor ID for audit fields.
 *
 * - Session user → user id
 * - User-bound API key → user id
 * - System API key (agent sidecar) → `SYSTEM_ACTOR_ID`
 * - Unauthenticated → null
 */
export function getCurrentUserId(req: Request): string | null {
  const user = getCurrentUser(req);
  if (user) return user.id;
  // System API key authenticated with no associated user.
  if (req.apiKey) return SYSTEM_ACTOR_ID;
  return null;
}
