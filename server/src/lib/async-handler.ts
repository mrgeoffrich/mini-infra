import {
  Request,
  Response,
  NextFunction,
  RequestHandler,
} from "express";

/**
 * Wraps an async route handler so rejected promises are forwarded to
 * Express's `next(error)` chain instead of becoming unhandled rejections.
 *
 * Handlers may return anything — `res.json(...)`, a value, or `undefined`.
 * The return is discarded; callers must still invoke `res.*` to respond.
 */
export function asyncHandler<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  T extends (req: Request, res: Response, next: NextFunction) => Promise<any>,
>(handler: T): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}
