import { Request, Response, NextFunction, ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { ErrorCode } from "@mini-infra/types";
import { getLogger } from "./logger-factory";

// Use app logger for error handling
const logger = getLogger("platform", "error-handler");
import { getContext } from "./logging-context";
import { serverConfig } from "./config-new";

const getRequestId = () => getContext()?.requestId ?? "unknown";

/**
 * A reference to the domain entity an error is about — e.g. the postgres
 * database or backup config a conflict/not-found error concerns. Rendered
 * verbatim in the response envelope (see `ErrorResponseBody`).
 */
export interface AppErrorResource {
  type: string;
  id?: string;
  name?: string;
}

/** Optional extras a taxonomy error can carry, on top of code/message/status. */
export interface AppErrorOptions {
  resource?: AppErrorResource;
  action?: string;
  details?: unknown;
}

export interface AppError extends Error {
  statusCode?: number;
  isOperational?: boolean;
  /** Machine-readable code, set by taxonomy errors (see `server/src/lib/errors.ts`). */
  code?: ErrorCode;
  resource?: AppErrorResource;
  action?: string;
  details?: unknown;
}

/**
 * Fallback machine code for legacy operational errors (`CustomError`/
 * `ServiceError` instances constructed without a taxonomy `code`) so the
 * envelope's `error` field is always a stable, non-message string. Not part
 * of `ErrorCode` because it's a transitional value — it disappears from a
 * domain's responses as soon as that domain migrates onto the taxonomy.
 */
const LEGACY_OPERATIONAL_ERROR_CODE = "OPERATIONAL_ERROR";

export class CustomError extends Error implements AppError {
  public statusCode: number;
  public isOperational: boolean;
  public code?: ErrorCode;
  public resource?: AppErrorResource;
  public action?: string;
  public details?: unknown;

  constructor(
    message: string,
    statusCode: number = 500,
    isOperational: boolean = true,
    code?: ErrorCode,
    opts: AppErrorOptions = {},
  ) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    this.code = code;
    this.resource = opts.resource;
    this.action = opts.action;
    this.details = opts.details;

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

/** The single JSON shape every error response shares (§4.3 of the error-handling-overhaul plan). */
interface ErrorResponseBody {
  /** Machine-readable code — a stable `ErrorCode` for taxonomy errors, a fallback string otherwise. */
  error: string;
  /** Human-readable text, always present. */
  message: string;
  resource?: AppErrorResource;
  action?: string;
  details?: unknown;
  requestId: string;
  timestamp: string;
}

function buildErrorBody(params: {
  code: string;
  message: string;
  requestId: string;
  resource?: AppErrorResource;
  action?: string;
  details?: unknown;
}): ErrorResponseBody {
  const body: ErrorResponseBody = {
    error: params.code,
    message: params.message,
    requestId: params.requestId,
    timestamp: new Date().toISOString(),
  };

  if (params.resource !== undefined) body.resource = params.resource;
  if (params.action !== undefined) body.action = params.action;
  if (params.details !== undefined) body.details = params.details;

  return body;
}

// Error handling middleware - Express 5 compliant with ErrorRequestHandler type
export const errorHandler: ErrorRequestHandler = (
  error: AppError | ZodError,
  req: Request,
  res: Response,
  _next: NextFunction,
) => {
  const requestId = getRequestId();

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

    return res.status(400).json(
      buildErrorBody({
        code: ErrorCode.VALIDATION_FAILED,
        message: "Validation failed",
        requestId,
        details: error.issues,
      }),
    );
  }

  // Handle operational errors (expected errors) — both taxonomy errors
  // (carry a `code`) and legacy CustomError/ServiceError instances (don't).
  if (error.isOperational) {
    const serviceName =
      error instanceof ServiceError ? error.serviceName : undefined;
    logger.warn(
      {
        requestId,
        method: req.method,
        path: req.path,
        ...(serviceName && { serviceName }),
        ...(error.code && { code: error.code }),
        ...(error.resource && { resource: error.resource }),
        error: {
          name: error.name,
          message: error.message,
        },
      },
      serviceName
        ? `${serviceName} service error: ${error.message}`
        : "Operational error",
    );

    return res.status(error.statusCode || 500).json(
      buildErrorBody({
        code: error.code ?? LEGACY_OPERATIONAL_ERROR_CODE,
        message: error.message,
        requestId,
        resource: error.resource,
        action: error.action,
        details: error.details,
      }),
    );
  }

  // Handle unexpected errors (programming errors) — always a 500, never
  // laundered into a 4xx just because the middleware understands taxonomy
  // errors now.
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

  return res.status(500).json(
    buildErrorBody({
      code: ErrorCode.INTERNAL,
      message,
      requestId,
    }),
  );
};

// 404 handler
export const notFoundHandler = (req: Request, res: Response) => {
  const requestId = getRequestId();

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
