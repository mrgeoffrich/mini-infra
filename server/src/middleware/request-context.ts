import { randomUUID } from "crypto";
import { Request, Response, NextFunction } from "express";
import { runWithContext } from "../lib/logging-context";

const REQUEST_ID_HEADER = "x-request-id";

export function requestContextMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const incoming = req.headers[REQUEST_ID_HEADER];
  const requestId =
    (typeof incoming === "string" && incoming.length > 0 ? incoming : undefined) ??
    randomUUID();

  res.setHeader(REQUEST_ID_HEADER, requestId);

  runWithContext({ requestId }, () => {
    next();
  });
}
