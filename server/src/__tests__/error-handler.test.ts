import { describe, it, expect, vi, beforeEach } from "vitest";
import { ServiceError, errorHandler } from "../lib/error-handler";
import { ConflictError } from "../lib/errors";
import { ErrorCode } from "@mini-infra/types";
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

describe("errorHandler with ServiceError (legacy operational error, no taxonomy code)", () => {
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
    res = { status: statusMock, headersSent: false } as unknown as Response;
    next = vi.fn();
  });

  it("puts the human message in `message` and a fallback code in `error`, and returns the ServiceError's status code", () => {
    const err = new ServiceError(
      "API token does not have permission to manage tunnels",
      403,
      "cloudflare",
    );
    errorHandler(err, req as Request, res as Response, next);
    expect(statusMock).toHaveBeenCalledWith(403);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "OPERATIONAL_ERROR",
        message: "API token does not have permission to manage tunnels",
      }),
    );
  });

  it("returns 502 for ServiceError with default status", () => {
    const err = new ServiceError("Upstream timeout", undefined, "azure");
    errorHandler(err, req as Request, res as Response, next);
    expect(statusMock).toHaveBeenCalledWith(502);
  });
});

describe("errorHandler with a taxonomy error (has a code)", () => {
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
    res = { status: statusMock, headersSent: false } as unknown as Response;
    next = vi.fn();
  });

  it("emits the machine code in `error`, the human text in `message`, and passes through resource/action", () => {
    const err = new ConflictError(
      ErrorCode.POSTGRES_BACKUP_CONFIG_EXISTS,
      "kumiko already has a backup configuration.",
      {
        resource: { type: "postgresBackupConfig", name: "kumiko" },
        action: "Edit the existing backup config instead of creating a new one.",
      },
    );

    errorHandler(err, req as Request, res as Response, next);

    expect(statusMock).toHaveBeenCalledWith(409);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "POSTGRES_BACKUP_CONFIG_EXISTS",
        message: "kumiko already has a backup configuration.",
        resource: { type: "postgresBackupConfig", name: "kumiko" },
        action: "Edit the existing backup config instead of creating a new one.",
      }),
    );
  });
});

describe("errorHandler with a non-operational raw Error", () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let next: NextFunction;
  let jsonMock: ReturnType<typeof vi.fn>;
  let statusMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    jsonMock = vi.fn();
    statusMock = vi.fn().mockReturnValue({ json: jsonMock });
    req = {
      method: "GET",
      path: "/api/test",
      ip: "127.0.0.1",
      headers: { "user-agent": "test" },
    };
    res = { status: statusMock, headersSent: false } as unknown as Response;
    next = vi.fn();
  });

  it("stays a 500 with the INTERNAL code — genuine invariants are never laundered into 4xx", () => {
    const err = new Error("something programmer-error-shaped broke");

    errorHandler(err, req as Request, res as Response, next);

    expect(statusMock).toHaveBeenCalledWith(500);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "INTERNAL",
      }),
    );
  });
});
