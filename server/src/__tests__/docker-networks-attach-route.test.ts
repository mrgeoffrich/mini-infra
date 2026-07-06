import request from "supertest";
import express from "express";

/**
 * Route tests for the imperative container↔network attach/detach endpoints
 * (`POST /api/docker/networks/:id/connect` and `.../disconnect`) added for the
 * container detail page's Networks card. Exercises the real Express handlers
 * over supertest (per server/CLAUDE.md), with the Docker plumbing mocked, and
 * asserts they route through `NetworkManager.connect/disconnect` (the boundary
 * the network-api-boundary test enforces) with the right arguments and return
 * the `NetworkAttachmentResponse` shape.
 */

// ---------------------------------------------------------------------------
// Hoisted mocks — declared before any vi.mock() that references them
// ---------------------------------------------------------------------------
const {
  mockNetworkManager,
  mockCreateNetworkManager,
  mockLogger,
  mockRequirePermission,
  mockIsConnected,
} = vi.hoisted(() => {
  const mockNetworkManager = {
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  return {
    mockNetworkManager,
    mockCreateNetworkManager: vi.fn(() => mockNetworkManager),
    mockLogger: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
    mockRequirePermission: vi.fn(
      () => (_req: any, _res: any, next: any) => next(),
    ),
    mockIsConnected: vi.fn(() => true),
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
  default: { getInstance: () => ({ isConnected: mockIsConnected }) },
}));

vi.mock("../services/docker-executor", () => ({
  DockerExecutorService: class {
    async initialize() {}
  },
}));

// The volume services are imported by routes/docker.ts for the volume routes;
// stub them so importing the router doesn't pull in the real implementations.
vi.mock("../services/volume", () => ({
  VolumeInspectorService: class {},
  VolumeFileContentService: class {},
}));

vi.mock("../services/networks", () => ({
  createNetworkManager: mockCreateNetworkManager,
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

// Import the router AFTER the mocks are set up
import dockerRoutes from "../routes/docker";

describe("Docker container↔network attach/detach routes", () => {
  let app: express.Application;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use("/api/docker", dockerRoutes);
    app.use((err: any, _req: any, res: any, _next: any) => {
      res.status(500).json({ error: "Internal Server Error", message: err.message });
    });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsConnected.mockReturnValue(true);
    mockNetworkManager.connect.mockResolvedValue({
      connected: true,
      alreadyConnected: false,
    });
    mockNetworkManager.disconnect.mockResolvedValue(undefined);
  });

  // =========================================================================
  // POST /api/docker/networks/:id/connect
  // =========================================================================
  describe("POST /networks/:id/connect", () => {
    it("connects the container and returns a NetworkAttachmentResponse", async () => {
      const res = await request(app)
        .post("/api/docker/networks/net-abc/connect")
        .send({ containerId: "c-123" });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        success: true,
        networkId: "net-abc",
        containerId: "c-123",
        alreadyConnected: false,
      });
      expect(res.body.message).toContain("connected");
      // Routes through NetworkManager, not raw dockerode (boundary invariant).
      expect(mockNetworkManager.connect).toHaveBeenCalledWith("c-123", "net-abc");
    });

    it("surfaces an idempotent already-connected attach", async () => {
      mockNetworkManager.connect.mockResolvedValue({
        connected: true,
        alreadyConnected: true,
      });

      const res = await request(app)
        .post("/api/docker/networks/net-abc/connect")
        .send({ containerId: "c-123" });

      expect(res.status).toBe(200);
      expect(res.body.alreadyConnected).toBe(true);
      expect(res.body.message.toLowerCase()).toContain("already");
    });

    it("400s when containerId is missing", async () => {
      const res = await request(app)
        .post("/api/docker/networks/net-abc/connect")
        .send({});

      expect(res.status).toBe(400);
      expect(mockNetworkManager.connect).not.toHaveBeenCalled();
    });

    it("503s when Docker is not connected", async () => {
      mockIsConnected.mockReturnValue(false);

      const res = await request(app)
        .post("/api/docker/networks/net-abc/connect")
        .send({ containerId: "c-123" });

      expect(res.status).toBe(503);
      expect(mockNetworkManager.connect).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // POST /api/docker/networks/:id/disconnect
  // =========================================================================
  describe("POST /networks/:id/disconnect", () => {
    it("disconnects the container and returns a NetworkAttachmentResponse", async () => {
      const res = await request(app)
        .post("/api/docker/networks/net-abc/disconnect")
        .send({ containerId: "c-123" });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        success: true,
        networkId: "net-abc",
        containerId: "c-123",
      });
      expect(mockNetworkManager.disconnect).toHaveBeenCalledWith("c-123", "net-abc", {
        force: undefined,
      });
    });

    it("forwards force: true when requested", async () => {
      const res = await request(app)
        .post("/api/docker/networks/net-abc/disconnect")
        .send({ containerId: "c-123", force: true });

      expect(res.status).toBe(200);
      expect(mockNetworkManager.disconnect).toHaveBeenCalledWith("c-123", "net-abc", {
        force: true,
      });
    });

    it("400s when containerId is missing", async () => {
      const res = await request(app)
        .post("/api/docker/networks/net-abc/disconnect")
        .send({});

      expect(res.status).toBe(400);
      expect(mockNetworkManager.disconnect).not.toHaveBeenCalled();
    });
  });
});
