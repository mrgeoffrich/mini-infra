/**
 * HTTP-level contract test for POST /api/self-update/trigger (Phase 10).
 *
 * Done-when (docs/planning/not-shipped/error-handling-overhaul-plan.md, Phase 10):
 * triggering a self-update precondition failure — an update already in
 * progress, or a host that isn't running inside Docker — yields an
 * actionable, correctly-attributed envelope from the central error
 * middleware instead of the old bespoke `error.message.includes(...)`
 * status-mapping block that used to live in this route.
 */
import request from "supertest";
import express from "express";
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockAcquireLaunchLock,
  mockReleaseLaunchLock,
  mockIsUpdateInProgress,
  mockGetOwnContainerId,
  mockCreateUpdateRecord,
  mockUpdateUpdateRecordSidecarId,
  mockGetLatestUpdateRecord,
  mockRecoverStaleUpdate,
  mockLaunchSidecar,
} = vi.hoisted(() => ({
  mockAcquireLaunchLock: vi.fn(),
  mockReleaseLaunchLock: vi.fn(),
  mockIsUpdateInProgress: vi.fn(),
  mockGetOwnContainerId: vi.fn(),
  mockCreateUpdateRecord: vi.fn(),
  mockUpdateUpdateRecordSidecarId: vi.fn(),
  mockGetLatestUpdateRecord: vi.fn(),
  mockRecoverStaleUpdate: vi.fn(),
  mockLaunchSidecar: vi.fn(),
}));

vi.mock("../../lib/logger-factory", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("../../middleware/auth", () => ({
  requirePermission:
    () =>
    (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
      next(),
  getCurrentUserId: (req: express.Request) =>
    (req as unknown as { testUserId?: string | null }).testUserId ?? "test-user-id",
}));

vi.mock("../../lib/prisma", () => ({
  default: { selfUpdate: { update: vi.fn().mockResolvedValue({}) } },
}));
vi.mock("../../lib/socket", () => ({ emitToChannel: vi.fn() }));

vi.mock("../../services/self-update", () => ({
  acquireLaunchLock: mockAcquireLaunchLock,
  releaseLaunchLock: mockReleaseLaunchLock,
  isUpdateInProgress: mockIsUpdateInProgress,
  getOwnContainerId: mockGetOwnContainerId,
  createUpdateRecord: mockCreateUpdateRecord,
  updateUpdateRecordSidecarId: mockUpdateUpdateRecordSidecarId,
  getLatestUpdateRecord: mockGetLatestUpdateRecord,
  recoverStaleUpdate: mockRecoverStaleUpdate,
  launchSidecar: mockLaunchSidecar,
  SELF_UPDATE_LAUNCH_STEPS: [
    "Pull sidecar image",
    "Pull target image",
    "Pull agent sidecar image",
    "Pull egress fw-agent image",
    "Create sidecar container",
    "Start sidecar container",
  ],
}));

import selfUpdateRouter from "../self-update";
import { errorHandler } from "../../lib/error-handler";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/self-update", selfUpdateRouter);
  // The route now throws taxonomy errors and forwards via `next(err)` —
  // mount the real central error middleware for the standard envelope.
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAcquireLaunchLock.mockReturnValue(true);
  mockIsUpdateInProgress.mockResolvedValue(false);
  mockGetOwnContainerId.mockReturnValue("abc123def456");
  mockCreateUpdateRecord.mockResolvedValue("update-1");
  mockLaunchSidecar.mockResolvedValue("sidecar-container-id");
});

describe("POST /api/self-update/trigger", () => {
  it("returns 409 SELF_UPDATE_IN_PROGRESS when the launch lock is already held (canonical failure)", async () => {
    mockAcquireLaunchLock.mockReturnValue(false);

    const res = await request(buildApp())
      .post("/api/self-update/trigger")
      .send({ targetTag: "v2.1.0" });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: "SELF_UPDATE_IN_PROGRESS",
      message: "An update is already in progress",
      resource: { type: "selfUpdate" },
      action: "Wait for the current update to finish before starting another.",
    });
    expect(res.body.requestId).toBeDefined();
    expect(res.body.timestamp).toBeDefined();
    // Never acquired past the guard — no launch bookkeeping should run.
    expect(mockCreateUpdateRecord).not.toHaveBeenCalled();
  });

  it("returns 409 SELF_UPDATE_IN_PROGRESS on the post-lock double-check, and releases the lock", async () => {
    mockIsUpdateInProgress.mockResolvedValue(true);

    const res = await request(buildApp())
      .post("/api/self-update/trigger")
      .send({ targetTag: "v2.1.0" });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("SELF_UPDATE_IN_PROGRESS");
    expect(mockReleaseLaunchLock).toHaveBeenCalled();
    expect(mockCreateUpdateRecord).not.toHaveBeenCalled();
  });

  it("returns 409 SELF_UPDATE_CONTAINER_ID_UNKNOWN when not running inside Docker", async () => {
    mockGetOwnContainerId.mockReturnValue(null);

    const res = await request(buildApp())
      .post("/api/self-update/trigger")
      .send({ targetTag: "v2.1.0" });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("SELF_UPDATE_CONTAINER_ID_UNKNOWN");
    expect(res.body.action).toBe(
      "Self-update requires running inside a Docker container.",
    );
  });

  it("returns 400 VALIDATION_FAILED for a malformed target tag", async () => {
    const res = await request(buildApp())
      .post("/api/self-update/trigger")
      .send({ targetTag: "not a valid tag!!" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("VALIDATION_FAILED");
  });

  it("returns 202 with an operationId on success", async () => {
    const res = await request(buildApp())
      .post("/api/self-update/trigger")
      .send({ targetTag: "v2.1.0" });

    expect(res.status).toBe(202);
    expect(res.body.success).toBe(true);
    expect(res.body.updateId).toBe("update-1");
    expect(res.body.operationId).toBeDefined();
  });
});
