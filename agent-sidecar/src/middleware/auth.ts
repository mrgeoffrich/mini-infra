import { Request, Response, NextFunction } from "express";
import { logger } from "../logger";

const AUTH_TOKEN = process.env.SIDECAR_AUTH_TOKEN;

/**
 * Validates Bearer token authentication.
 * If SIDECAR_AUTH_TOKEN is not set (development), auth is skipped.
 */
export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!AUTH_TOKEN) {
    next();
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    logger.warn({ path: req.path }, "Missing or invalid Authorization header");
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const token = authHeader.slice(7);
  if (token !== AUTH_TOKEN) {
    logger.warn({ path: req.path }, "Invalid auth token");
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  next();
}
