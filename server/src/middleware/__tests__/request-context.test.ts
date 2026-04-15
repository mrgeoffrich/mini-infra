import { describe, it, expect, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { requestContextMiddleware } from "../request-context";
import { getContext } from "../../lib/logging-context";

vi.unmock("../../lib/logging-context");

function makeReq(headers: Record<string, string> = {}): Request {
  return { headers } as unknown as Request;
}

function makeRes(): Response & { headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  return {
    headers,
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
    },
  } as unknown as Response & { headers: Record<string, string> };
}

describe("requestContextMiddleware", () => {
  it("generates a new request id when the header is absent and opens the ALS scope", () => {
    const req = makeReq();
    const res = makeRes();
    const next: NextFunction = vi.fn(() => {
      const ctx = getContext();
      expect(ctx?.requestId).toBeDefined();
      expect(ctx?.requestId?.length).toBeGreaterThan(0);
      expect(res.headers["x-request-id"]).toBe(ctx?.requestId);
    });

    requestContextMiddleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("reuses the incoming x-request-id header", () => {
    const req = makeReq({ "x-request-id": "incoming-42" });
    const res = makeRes();
    const next: NextFunction = vi.fn(() => {
      expect(getContext()?.requestId).toBe("incoming-42");
    });

    requestContextMiddleware(req, res, next);
    expect(res.headers["x-request-id"]).toBe("incoming-42");
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("also populates req.requestId for back-compat with lib/request-id.getRequestId", () => {
    const req = makeReq({ "x-request-id": "legacy-compat" });
    const res = makeRes();
    const next: NextFunction = vi.fn();

    requestContextMiddleware(req, res, next);
    expect((req as unknown as { requestId?: string }).requestId).toBe(
      "legacy-compat",
    );
  });

  it("falls through to a fresh id when the incoming header is an empty string", () => {
    const req = makeReq({ "x-request-id": "" });
    const res = makeRes();
    const next: NextFunction = vi.fn(() => {
      const id = getContext()?.requestId;
      expect(id).toBeDefined();
      expect(id).not.toBe("");
    });

    requestContextMiddleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
