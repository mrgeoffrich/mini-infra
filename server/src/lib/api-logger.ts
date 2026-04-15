import { Request, Response } from "express";
import { getLogger } from "./logger-factory";
import { getRequestId } from "./request-id";

// Types imported for future use

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
    userId: req.user?.id,
    startTime: Date.now(),
  };

  const requestLogger = getLogger("platform", "api-logger").child({
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
  requestLogger: ReturnType<typeof getLogger>,
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
  requestLogger: ReturnType<typeof getLogger>,
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
  requestLogger: ReturnType<typeof getLogger>,
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
