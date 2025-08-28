import { Request, Response } from "express";
import logger from "./logger.js";
import { getRequestId } from "./request-id.js";

// Extend Request interface to include user
interface RequestWithUser extends Request {
  user?: {
    id: string;
    [key: string]: unknown;
  };
}

export interface ApiContext {
  requestId: string;
  method: string;
  path: string;
  ip: string;
  userAgent: string;
  userId?: string;
  startTime: number;
}

export interface TimingContext extends ApiContext {
  startTime: number;
}

export const createApiLogger = (req: Request) => {
  const context: ApiContext = {
    requestId: getRequestId(req),
    method: req.method,
    path: req.path,
    ip: req.ip || req.socket.remoteAddress || "unknown",
    userAgent: req.headers["user-agent"] || "unknown",
    userId: (req as RequestWithUser).user?.id,
    startTime: Date.now(),
  };

  const requestLogger = logger.child({
    requestId: context.requestId,
    userId: context.userId,
    method: context.method,
    path: context.path,
  });

  return { logger: requestLogger, context };
};

export const startApiTiming = (context: ApiContext): TimingContext => {
  return {
    ...context,
    startTime: Date.now(),
  };
};

export const logApiCompletion = (
  timingContext: TimingContext,
  res: Response,
  requestLogger: typeof logger,
) => {
  const duration = Date.now() - timingContext.startTime;

  requestLogger.info(
    {
      statusCode: res.statusCode,
      duration,
      method: timingContext.method,
      path: timingContext.path,
    },
    `${timingContext.method} ${timingContext.path} ${res.statusCode} - ${duration}ms`,
  );
};

export const logApiBusinessEvent = (
  requestLogger: typeof logger,
  event: string,
  data: Record<string, unknown> = {},
) => {
  requestLogger.info(
    {
      event,
      ...data,
    },
    `Business event: ${event}`,
  );
};

export const logError = (
  requestLogger: typeof logger,
  error: Error,
  message: string,
  context: Record<string, unknown> = {},
) => {
  requestLogger.error(
    {
      error: {
        name: error.name,
        message: error.message,
        stack: error.stack,
      },
      ...context,
    },
    message,
  );
};
