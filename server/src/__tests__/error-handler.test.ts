import { describe, it, expect, vi, beforeEach } from "vitest";
import { ServiceError, errorHandler } from "../lib/error-handler";
import type { Request, Response, NextFunction } from "express";

describe("ServiceError", () => {
  it("creates error with message, status code, and service name", () => {
    const err = new ServiceError(
      "API token does not have permission to manage tunnels",
      403,
      "cloudflare",
    );
    expect(err.message).toBe(
      "API token does not have permission to manage tunnels",
    );
    expect(err.statusCode).toBe(403);
    expect(err.isOperational).toBe(true);
    expect(err.serviceName).toBe("cloudflare");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ServiceError);
  });

  it("defaults to 502 status code", () => {
    const err = new ServiceError("Something failed", undefined, "azure");
    expect(err.statusCode).toBe(502);
  });
});

describe("errorHandler with ServiceError", () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let next: NextFunction;
  let jsonMock: ReturnType<typeof vi.fn>;
  let statusMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    jsonMock = vi.fn();
    statusMock = vi.fn().mockReturnValue({ json: jsonMock });
    req = {
      method: "POST",
      path: "/api/test",
      ip: "127.0.0.1",
      headers: { "user-agent": "test" },
    };
    res = { status: statusMock, headersSent: false } as any;
    next = vi.fn();
  });

  it("returns the ServiceError message and status code to the client", () => {
    const err = new ServiceError(
      "API token does not have permission to manage tunnels",
      403,
      "cloudflare",
    );
    errorHandler(err, req as Request, res as Response, next);
    expect(statusMock).toHaveBeenCalledWith(403);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "API token does not have permission to manage tunnels",
      }),
    );
  });

  it("returns 502 for ServiceError with default status", () => {
    const err = new ServiceError("Upstream timeout", undefined, "azure");
    errorHandler(err, req as Request, res as Response, next);
    expect(statusMock).toHaveBeenCalledWith(502);
  });
});
