import { Request, Response, NextFunction, ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { getLogger } from "./logger-factory";

// Use app logger for error handling
const logger = getLogger("platform", "error-handler");
import { getRequestId } from "./request-id";
import { serverConfig } from "./config-new";

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

/**
 * Error from an external service API (Cloudflare, Azure, Docker, GitHub).
 * Always treated as operational — the message is shown to the user.
 * Uses 502 (Bad Gateway) by default since the upstream service returned the error.
 */
export class ServiceError extends CustomError {
  public serviceName: string;

  constructor(
    message: string,
    statusCode: number = 502,
    serviceName: string = "external",
  ) {
    super(message, statusCode, true);
    this.serviceName = serviceName;
  }
}

// Error handling middleware - Express 5 compliant with ErrorRequestHandler type
export const errorHandler: ErrorRequestHandler = (
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
    const serviceName =
      error instanceof ServiceError ? error.serviceName : undefined;
    logger.warn(
      {
        requestId,
        method: req.method,
        path: req.path,
        ...(serviceName && { serviceName }),
        error: {
          name: error.name,
          message: error.message,
        },
      },
      serviceName
        ? `${serviceName} service error: ${error.message}`
        : "Operational error",
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
      // Add the full error object for better debugging
      err: error,
    },
    `Unexpected server error: ${error.message}`,
  );

  // Don't leak error details in production
  const message =
    serverConfig.nodeEnv === "production"
      ? "Internal server error"
      : error.message;

  return res.status(500).json({
    error: message,
    requestId,
  });
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
