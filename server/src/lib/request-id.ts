import { randomUUID } from "crypto";
import { Request, Response, NextFunction } from "express";

export const generateRequestId = (): string => {
  return randomUUID();
};

// Extend the Request interface to include requestId
interface RequestWithId extends Request {
  requestId?: string;
}

export const requestIdMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  // Check if request ID already exists (from proxy, load balancer, etc.)
  const existingId = req.headers["x-request-id"] as string;
  const requestId = existingId || generateRequestId();

  // Add request ID to request object
  (req as RequestWithId).requestId = requestId;

  // Add request ID to response headers
  res.setHeader("x-request-id", requestId);

  next();
};

// Utility to get request ID from request object
export const getRequestId = (req: Request): string => {
  return (req as RequestWithId).requestId || "unknown";
};
