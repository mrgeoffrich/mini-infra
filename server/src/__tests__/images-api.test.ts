import request from "supertest";
import type { Application } from "express";

// Mock logger factory first
vi.mock("../lib/logger-factory", () => {
  const mockLoggerInstance = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(function () { return mockLoggerInstance; }),
    level: "info",
    levels: { values: { fatal: 60, error: 50, warn: 40, info: 30, debug: 20, trace: 10 } },
    silent: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  };
  return {
    getLogger: vi.fn(() => mockLoggerInstance),
    buildPinoHttpOptions: vi.fn(() => ({ level: "silent" })),
    createLogger: vi.fn(() => mockLoggerInstance),
    appLogger: vi.fn(() => mockLoggerInstance),
    servicesLogger: vi.fn(() => mockLoggerInstance),
    httpLogger: vi.fn(() => mockLoggerInstance),
    prismaLogger: vi.fn(() => mockLoggerInstance),
    loadbalancerLogger: vi.fn(() => mockLoggerInstance),
    deploymentLogger: vi.fn(() => mockLoggerInstance),
    dockerExecutorLogger: vi.fn(() => mockLoggerInstance),
    selfBackupLogger: vi.fn(() => mockLoggerInstance),
    tlsLogger: vi.fn(() => mockLoggerInstance),
    agentLogger: vi.fn(() => mockLoggerInstance),
    clearLoggerCache: vi.fn(),
    createChildLogger: vi.fn(() => mockLoggerInstance),
    serializeError: (e: unknown) => e,
    default: vi.fn(() => mockLoggerInstance),
  };
});

vi.mock("../middleware/auth", () => ({
  requireSessionOrApiKey: (req: any, res: any, next: any) => {
    req.user = { id: "test-user-id" };
    next();
  },
  requirePermission: () => (req: any, res: any, next: any) => {
    req.user = { id: "test-user-id" };
    next();
  },
  getCurrentUserId: (req: any) => "test-user-id",
  requireAuth: (req: any, res: any, next: any) => next(),
  getAuthenticatedUser: (req: any) => ({ id: "test-user-id" }),
}));

// Mock ImageInspectService
const mockGetExposedPorts = vi.fn();
vi.mock("../services/image-inspect", () => ({
  ImageInspectService: vi.fn().mockImplementation(function () {
    return {
      getExposedPorts: mockGetExposedPorts,
    };
  }),
}));

// Mock self-backup services
vi.mock("../services/backup/self-backup-executor", () => ({
  SelfBackupExecutor: vi.fn(),
}));
vi.mock("../services/backup/self-backup-scheduler", () => ({
  SelfBackupScheduler: vi.fn(),
}));

import { createApp } from "../app-factory";
import createImagesRouter from "../routes/images";
import { NotFoundError, UnauthorizedError } from "../lib/errors";
import { ErrorCode } from "@mini-infra/types";

describe("GET /api/images/inspect-ports", () => {
  let app: Application;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp({
      includeRouteIds: ["images"],
      routeOverrides: {
        images: createImagesRouter({
          registryCredentialService: {
            getCredentialsForImage: vi.fn().mockResolvedValue(null),
          },
        }),
      },
      quiet: true,
    });
  });

  it("returns ports for a valid image", async () => {
    mockGetExposedPorts.mockResolvedValue([80, 443]);

    const res = await request(app)
      .get("/api/images/inspect-ports")
      .query({ image: "nginx", tag: "latest" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, ports: [80, 443] });
  });

  it("returns 400 when image is missing", async () => {
    const res = await request(app)
      .get("/api/images/inspect-ports")
      .query({ tag: "latest" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(ErrorCode.VALIDATION_FAILED);
  });

  it("returns 400 when tag is missing", async () => {
    const res = await request(app)
      .get("/api/images/inspect-ports")
      .query({ image: "nginx" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(ErrorCode.VALIDATION_FAILED);
  });

  // Canonical Phase 7 conflict/not-found envelope check (docs/planning/not-shipped/error-handling-overhaul-plan.md):
  // a taxonomy error thrown from the (mocked) ImageInspectService reaches
  // the central middleware and comes back as the one envelope shape, not a
  // route-level string-matched status.
  it("returns 404 with the taxonomy envelope when the image is not found", async () => {
    mockGetExposedPorts.mockRejectedValue(
      new NotFoundError(
        ErrorCode.IMAGE_NOT_FOUND,
        "Image 'nonexistent/image:latest' not found in registry",
        {
          resource: { type: "image", name: "nonexistent/image:latest" },
          action: "Check the image name and tag, then try again.",
        },
      ),
    );

    const res = await request(app)
      .get("/api/images/inspect-ports")
      .query({ image: "nonexistent/image", tag: "latest" });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({
      error: ErrorCode.IMAGE_NOT_FOUND,
      message: "Image 'nonexistent/image:latest' not found in registry",
      resource: { type: "image", name: "nonexistent/image:latest" },
      action: "Check the image name and tag, then try again.",
    });
    expect(res.body.requestId).toBeDefined();
  });

  it("returns 401 with the taxonomy envelope when auth fails", async () => {
    mockGetExposedPorts.mockRejectedValue(
      new UnauthorizedError(
        ErrorCode.IMAGE_AUTH_FAILED,
        "Authentication failed while inspecting image 'private/image:latest'",
        {
          resource: { type: "image", name: "private/image:latest" },
          action: "Check the registry credentials for this image in Settings.",
        },
      ),
    );

    const res = await request(app)
      .get("/api/images/inspect-ports")
      .query({ image: "private/image", tag: "latest" });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe(ErrorCode.IMAGE_AUTH_FAILED);
  });

  it("returns empty ports array when image has no EXPOSE", async () => {
    mockGetExposedPorts.mockResolvedValue([]);

    const res = await request(app)
      .get("/api/images/inspect-ports")
      .query({ image: "alpine", tag: "latest" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, ports: [] });
  });
});
