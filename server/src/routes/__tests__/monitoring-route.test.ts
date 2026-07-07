/**
 * HTTP-level contract test for the monitoring routes (Phase 10).
 *
 * Covers the domain's canonical failures: stopping a monitoring stack that
 * doesn't exist (404) and querying Prometheus without a required parameter
 * (400) — both now produced by the central error middleware's standard
 * envelope instead of the old bespoke `res.status().json()` bodies.
 */
import request from "supertest";
import express from "express";
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockFindFirst } = vi.hoisted(() => ({
  mockFindFirst: vi.fn(),
}));

vi.mock("../../lib/logger-factory", () => {
  const mk = (): Record<string, unknown> => {
    const l: Record<string, unknown> = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      trace: vi.fn(),
      silent: vi.fn(),
    };
    l.child = vi.fn(() => l);
    return l;
  };
  return { getLogger: vi.fn(() => mk()) };
});

vi.mock("../../middleware/auth", () => ({
  requirePermission:
    () =>
    (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
      next(),
}));

vi.mock("../../lib/prisma", () => ({
  default: { stack: { findFirst: mockFindFirst } },
}));

import monitoringRouter from "../monitoring";
import { errorHandler } from "../../lib/error-handler";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/monitoring", monitoringRouter);
  // Routes now throw taxonomy errors and forward via `next(err)` — mount
  // the real central error middleware for the standard envelope.
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/monitoring/stop", () => {
  it("returns 404 MONITORING_STACK_NOT_FOUND when no monitoring stack exists", async () => {
    mockFindFirst.mockResolvedValue(null);

    const res = await request(buildApp()).post("/api/monitoring/stop");

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({
      error: "MONITORING_STACK_NOT_FOUND",
      message: "Monitoring stack not found",
      resource: { type: "stack", name: "monitoring" },
    });
    expect(res.body.requestId).toBeDefined();
  });
});

describe("GET /api/monitoring/query", () => {
  it("returns 400 MONITORING_QUERY_PARAM_MISSING when query is omitted", async () => {
    const res = await request(buildApp()).get("/api/monitoring/query");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("MONITORING_QUERY_PARAM_MISSING");
    expect(res.body.message).toBe("query parameter is required");
  });
});

describe("GET /api/monitoring/query_range", () => {
  it("returns 400 MONITORING_QUERY_PARAM_MISSING when start/end are omitted", async () => {
    const res = await request(buildApp()).get(
      "/api/monitoring/query_range?query=up",
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("MONITORING_QUERY_PARAM_MISSING");
    expect(res.body.message).toBe("start parameter is required");
  });
});
