import { Request, Response, NextFunction } from "express";
import { randomBytes, timingSafeEqual } from "crypto";
import logger from "./logger.js";

// CSRF token configuration
const CSRF_TOKEN_LENGTH = 32;
const CSRF_HEADER_NAME = "x-csrf-token";
const CSRF_FORM_FIELD_NAME = "_csrf";

// Generate a random CSRF token
export const generateCSRFToken = (): string => {
  return randomBytes(CSRF_TOKEN_LENGTH).toString("hex");
};

// CSRF protection middleware
export const csrfProtection = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  // Skip CSRF protection for safe methods
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    return next();
  }

  // Skip CSRF protection for auth routes (OAuth callback)
  if (req.path.startsWith("/auth/google")) {
    return next();
  }

  // Skip CSRF protection for health check
  if (req.path === "/health") {
    return next();
  }

  // Skip CSRF protection if no session
  if (!req.session) {
    logger.debug({ path: req.path }, "No session for CSRF protection");
    return next();
  }

  // Initialize CSRF token in session if not present
  if (!req.session.csrfToken) {
    req.session.csrfToken = generateCSRFToken();
    logger.debug({ sessionId: req.sessionID }, "Generated new CSRF token");
  }

  // Get token from header or form data
  const clientToken =
    req.headers[CSRF_HEADER_NAME] || req.body[CSRF_FORM_FIELD_NAME];
  const sessionToken = req.session.csrfToken;

  if (!clientToken || typeof clientToken !== "string") {
    logger.warn(
      {
        path: req.path,
        method: req.method,
        sessionId: req.sessionID,
        userAgent: req.headers["user-agent"],
      },
      "CSRF token missing from request",
    );
    res.status(403).json({
      error: "CSRF token missing",
      code: "CSRF_MISSING",
    });
    return;
  }

  // Compare tokens using timing-safe comparison
  if (
    !timingSafeEqual(
      Buffer.from(clientToken, "hex"),
      Buffer.from(sessionToken, "hex"),
    )
  ) {
    logger.warn(
      {
        path: req.path,
        method: req.method,
        sessionId: req.sessionID,
        userAgent: req.headers["user-agent"],
      },
      "CSRF token mismatch",
    );
    res.status(403).json({
      error: "Invalid CSRF token",
      code: "CSRF_INVALID",
    });
    return;
  }

  logger.debug(
    { path: req.path, sessionId: req.sessionID },
    "CSRF token validated",
  );
  next();
};

// Middleware to add CSRF token to response
export const addCSRFToken = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  // Add CSRF token to session if not present
  if (req.session && !req.session.csrfToken) {
    req.session.csrfToken = generateCSRFToken();
  }

  // Add CSRF token getter to response locals
  res.locals.csrfToken = req.session?.csrfToken || null;

  next();
};

// Endpoint to get CSRF token
export const getCSRFToken = (req: Request, res: Response): void => {
  if (!req.session) {
    res.status(400).json({
      error: "No session available",
      code: "NO_SESSION",
    });
    return;
  }

  // Generate token if not present
  if (!req.session.csrfToken) {
    req.session.csrfToken = generateCSRFToken();
  }

  logger.debug({ sessionId: req.sessionID }, "CSRF token requested");

  res.json({
    csrfToken: req.session.csrfToken,
  });
};
