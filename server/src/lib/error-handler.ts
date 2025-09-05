import { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { appLogger } from "./logger-factory";

// Use app logger for error handling
const logger = appLogger();
import { getRequestId } from "./request-id";
import config from "./config";

export interface AppError extends Error {
  statusCode?: number;
  isOperational?: boolean;
}

export class CustomError extends Error implements AppError {
  public statusCode: number;
  public isOperational: boolean;

  constructor(
    message: string,
    statusCode: number = 500,
    isOperational: boolean = true,
  ) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;

    Error.captureStackTrace(this, this.constructor);
  }
}

// Error handling middleware
export const errorHandler = (
  error: AppError | ZodError,
  req: Request,
  res: Response,
  _next: NextFunction,
) => {
  const requestId = getRequestId(req);

  // Handle Zod validation errors
  if (error instanceof ZodError) {
    logger.warn(
      {
        requestId,
        method: req.method,
        path: req.path,
        validationErrors: error.issues,
      },
      "Validation error",
    );

    return res.status(400).json({
      error: "Validation failed",
      details: error.issues,
      requestId,
    });
  }

  // Handle operational errors (expected errors)
  if (error.isOperational) {
    logger.warn(
      {
        requestId,
        method: req.method,
        path: req.path,
        error: {
          name: error.name,
          message: error.message,
        },
      },
      "Operational error",
    );

    return res.status(error.statusCode || 500).json({
      error: error.message,
      requestId,
    });
  }

  // Handle unexpected errors (programming errors)
  logger.error(
    {
      requestId,
      method: req.method,
      path: req.path,
      ip: req.ip,
      userAgent: req.headers["user-agent"],
      error: {
        name: error.name,
        message: error.message,
        stack: error.stack,
      },
    },
    "Unexpected server error",
  );

  // Don't leak error details in production
  const message =
    config.NODE_ENV === "production" ? "Internal server error" : error.message;

  return res.status(500).json({
    error: message,
    requestId,
  });
};

// Async error wrapper
export const asyncHandler = (
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void> | void,
) => {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

// 404 handler
export const notFoundHandler = (req: Request, res: Response) => {
  const requestId = getRequestId(req);

  logger.warn(
    {
      requestId,
      method: req.method,
      path: req.path,
      ip: req.ip,
    },
    "Route not found",
  );

  res.status(404).json({
    error: "Route not found",
    requestId,
  });
};
