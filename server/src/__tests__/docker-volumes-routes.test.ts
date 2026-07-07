import request from "supertest";
import express from "express";

/**
 * Route tests for the Docker volume endpoints in `routes/docker.ts`
 * (`GET/DELETE /api/docker/volumes*`), pinning Phase 7 of
 * docs/planning/not-shipped/error-handling-overhaul-plan.md: the routes no
 * longer build bespoke `{ success: false, message }` JSON bodies for
 * connectivity/not-found/conflict cases — they throw taxonomy errors that
 * reach the real central error middleware (`server/src/lib/error-handler.ts`),
 * mounted here (unlike the older `docker-networks-attach-route.test.ts`
 * sibling, which predates this migration and still uses a stand-in
 * always-500 handler) so these tests exercise the actual envelope.
 */

// ---------------------------------------------------------------------------
// Hoisted mocks — declared before any vi.mock() that references them
// ---------------------------------------------------------------------------
const {
  mockLogger,
  mockRequirePermission,
  mockIsConnected,
  mockListVolumes,
  mockRemoveVolume,
  mockVolumeInspectorInstance,
  mockVolumeFileContentInstance,
} = vi.hoisted(() => {
  return {
    mockLogger: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
    mockRequirePermission: vi.fn(() => (_req: any, _res: any, next: any) => next()),
    mockIsConnected: vi.fn(() => true),
    mockListVolumes: vi.fn(),
    mockRemoveVolume: vi.fn(),
    mockVolumeInspectorInstance: {
      initialize: vi.fn().mockResolvedValue(undefined),
      startInspection: vi.fn().mockResolvedValue(undefined),
      getInspection: vi.fn().mockResolvedValue(null),
    },
    mockVolumeFileContentInstance: {
      initialize: vi.fn().mockResolvedValue(undefined),
      fetchFileContents: vi.fn(),
      getFileContent: vi.fn(),
    },
  };
});

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
vi.mock("../lib/prisma", () => ({ default: {} }));

vi.mock("../lib/logger-factory", () => ({
  getLogger: vi.fn(() => mockLogger),
  clearLoggerCache: vi.fn(),
}));

vi.mock("../middleware/auth", () => ({
  requirePermission: mockRequirePermission,
}));

vi.mock("../services/docker", () => ({
  default: {
    getInstance: () => ({
      isConnected: mockIsConnected,
      listVolumes: mockListVolumes,
      removeVolume: mockRemoveVolume,
    }),
  },
}));

vi.mock("../services/docker-executor", () => ({
  DockerExecutorService: class {
    async initialize() {}
  },
}));

vi.mock("../services/volume", () => ({
  VolumeInspectorService: class {
    initialize = mockVolumeInspectorInstance.initialize;
    startInspection = mockVolumeInspectorInstance.startInspection;
    getInspection = mockVolumeInspectorInstance.getInspection;
  },
  VolumeFileContentService: class {
    initialize = mockVolumeFileContentInstance.initialize;
    fetchFileContents = mockVolumeFileContentInstance.fetchFileContents;
    getFileContent = mockVolumeFileContentInstance.getFileContent;
  },
}));

// routes/docker.ts imports the network-management barrel at module scope for
// its (untouched-by-Phase-7) network routes — stub it so importing the
// router doesn't pull in the real implementations.
vi.mock("../services/networks", () => ({
  createNetworkManager: vi.fn(),
  runNetworkGc: vi.fn(),
  backfillNetworkMemberships: vi.fn(),
  reconcileStack: vi.fn(),
  reconcileEnvironment: vi.fn(),
  reconcileAll: vi.fn(),
  convergeStack: vi.fn(),
  convergeEnvironment: vi.fn(),
  convergeAll: vi.fn(),
  listManagedNetworks: vi.fn(),
}));

// Import the router and the REAL central error middleware after mocks are set up.
import dockerRoutes from "../routes/docker";
import { errorHandler } from "../lib/error-handler";
import { ConflictError } from "../lib/errors";
import { ErrorCode } from "@mini-infra/types";

describe("Docker volume routes (Phase 7 taxonomy envelope)", () => {
  let app: express.Application;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use("/api/docker", dockerRoutes);
    app.use(errorHandler);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsConnected.mockReturnValue(true);
  });

  describe("GET /volumes", () => {
    it("returns 503 DOCKER_NOT_CONNECTED via requireDockerConnected() when Docker is unreachable", async () => {
      mockIsConnected.mockReturnValue(false);

      const res = await request(app).get("/api/docker/volumes");

      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({
        error: ErrorCode.DOCKER_NOT_CONNECTED,
        message: "Docker service is not available. Please try again later.",
      });
      expect(res.body.requestId).toBeDefined();
      expect(res.body.timestamp).toBeDefined();
      // Not the old bespoke `{ success: false, message }` shape.
      expect(res.body.success).toBeUndefined();
    });

    it("returns the volume list on success", async () => {
      mockListVolumes.mockResolvedValue([
        { name: "pgdata", driver: "local", mountpoint: "/var/lib/docker/volumes/pgdata/_data", createdAt: new Date().toISOString(), scope: "local", labels: {}, options: null, inUse: true, containerCount: 1 },
      ]);

      const res = await request(app).get("/api/docker/volumes");

      expect(res.status).toBe(200);
      expect(res.body.data.volumes).toHaveLength(1);
      expect(res.body.data.volumes[0].name).toBe("pgdata");
    });
  });

  describe("DELETE /volumes/:name — canonical conflict", () => {
    // Canonical Phase 7 conflict case: a volume still attached to a
    // container. `DockerService.removeVolume()` (unit-tested directly in
    // services/__tests__/docker.test.ts) already throws this ConflictError;
    // this test pins that it reaches the client as the one taxonomy
    // envelope, not the old `error.message.includes("Cannot remove volume")`
    // route-level string match.
    it("returns 409 VOLUME_IN_USE when the volume is in use", async () => {
      mockRemoveVolume.mockRejectedValue(
        new ConflictError(
          ErrorCode.VOLUME_IN_USE,
          "Cannot remove volume 'pgdata': volume is in use by one or more containers",
          {
            resource: { type: "volume", name: "pgdata" },
            action: "Stop and remove the containers using this volume, then try again.",
          },
        ),
      );

      const res = await request(app).delete("/api/docker/volumes/pgdata");

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        error: ErrorCode.VOLUME_IN_USE,
        message: "Cannot remove volume 'pgdata': volume is in use by one or more containers",
        resource: { type: "volume", name: "pgdata" },
        action: "Stop and remove the containers using this volume, then try again.",
      });
      expect(res.body.requestId).toBeDefined();
    });

    it("removes the volume successfully when not in use", async () => {
      mockRemoveVolume.mockResolvedValue(undefined);

      const res = await request(app).delete("/api/docker/volumes/pgdata");

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true, volumeName: "pgdata" });
    });
  });

  describe("POST /volumes/:name/inspect — canonical not-found", () => {
    it("returns 404 VOLUME_NOT_FOUND for a volume that doesn't exist", async () => {
      mockListVolumes.mockResolvedValue([]);

      const res = await request(app).post("/api/docker/volumes/missing-volume/inspect");

      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({
        error: ErrorCode.VOLUME_NOT_FOUND,
        message: "Volume 'missing-volume' not found",
        resource: { type: "volume", name: "missing-volume" },
      });
    });

    it("starts inspection for an existing volume", async () => {
      mockListVolumes.mockResolvedValue([
        { name: "pgdata", driver: "local", mountpoint: "/x", createdAt: new Date().toISOString(), scope: "local", labels: {}, options: null, inUse: true, containerCount: 1 },
      ]);

      const res = await request(app).post("/api/docker/volumes/pgdata/inspect");

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        success: true,
        data: { volumeName: "pgdata", status: "running" },
      });
      expect(mockVolumeInspectorInstance.startInspection).toHaveBeenCalledWith("pgdata");
    });
  });

  describe("GET /volumes/:name/files — validation", () => {
    it("returns 400 VALIDATION_FAILED when the path query parameter is missing", async () => {
      const res = await request(app).get("/api/docker/volumes/pgdata/files");

      expect(res.status).toBe(400);
      expect(res.body.error).toBe(ErrorCode.VALIDATION_FAILED);
      expect(res.body.message).toBe("path query parameter is required");
    });

    it("returns 404 VOLUME_FILE_NOT_FOUND when the file has no fetched content", async () => {
      mockVolumeFileContentInstance.getFileContent.mockResolvedValue(null);

      const res = await request(app)
        .get("/api/docker/volumes/pgdata/files")
        .query({ path: "/etc/hosts" });

      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({
        error: ErrorCode.VOLUME_FILE_NOT_FOUND,
        resource: { type: "volumeFile", name: "pgdata:/etc/hosts" },
      });
    });
  });
});
