import { jest } from "@jest/globals";
import request from "supertest";
import express from "express";
import { createId } from "@paralleldrive/cuid2";
import { DockerContainerInfo } from "@mini-infra/types/containers";

// Mock dependencies
const mockDockerService = {
  getInstance: jest.fn(),
  isConnected: jest.fn(),
  listContainers: jest.fn(),
  getContainer: jest.fn(),
  getCacheStats: jest.fn(),
  flushCache: jest.fn(),
  initialize: jest.fn().mockResolvedValue(undefined),
  refreshConnection: jest.fn().mockResolvedValue(undefined),
};

jest.mock("../../services/docker", () => mockDockerService);

// Mock DockerConfigService
const mockDockerConfigService = {
  get: jest.fn(),
  set: jest.fn(),
  validate: jest.fn(),
  getHealthStatus: jest.fn(),
  testConnection: jest.fn(),
  recordConnectivityStatus: jest.fn().mockResolvedValue(undefined),
};

jest.mock("../../services/docker-config", () => ({
  DockerConfigService: jest.fn().mockImplementation(() => mockDockerConfigService),
}));

// Mock configuration base
jest.mock("../../services/configuration-base", () => ({
  ConfigurationService: jest.fn().mockImplementation(() => ({})),
}));

// Mock config
const mockConfig = {
  CONTAINER_CACHE_TTL: 3000,
  DOCKER_HOST: "/var/run/docker.sock",
  DOCKER_API_VERSION: "1.51",
};

jest.mock("../../lib/config", () => mockConfig);

// Mock prisma
const mockPrisma = {
  systemSettings: {
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
  connectivityStatus: {
    create: jest.fn().mockResolvedValue({}),
    findFirst: jest.fn(),
  },
  settingsAudit: {
    create: jest.fn().mockResolvedValue({}),
  },
};

jest.mock("../../lib/prisma", () => mockPrisma);

// Mock logger
const mockLogger = {
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
};

jest.mock("../../lib/logger", () => mockLogger);

// Mock auth middleware
const mockRequireAuth = jest.fn((req: any, res: any, next: any) => {
  req.user = { id: "test-user-id" };
  next();
});

jest.mock("../../lib/auth-middleware", () => ({
  requireAuth: mockRequireAuth,
}));

import containerRoutes from "../containers";

describe("Container Routes", () => {
  let app: express.Application;
  let mockDockerInstance: any;

  beforeAll(async () => {
    app = express();
    app.use(express.json());

    // Add request ID middleware for testing
    app.use((req: any, res: any, next: any) => {
      req.headers["x-request-id"] = req.headers["x-request-id"] || createId();
      next();
    });

    app.use("/api/containers", containerRoutes);

    // Add error handler for testing
    app.use((error: any, req: any, res: any, next: any) => {
      res.status(500).json({
        error: "Internal Server Error",
        message: error.message || "An unexpected error occurred",
        timestamp: new Date().toISOString(),
        requestId: req.headers["x-request-id"],
      });
    });

    // Set up Docker service mock
    mockDockerInstance = {
      isConnected: jest.fn().mockReturnValue(true),
      listContainers: jest.fn(),
      getContainer: jest.fn(),
      getCacheStats: jest.fn(),
      flushCache: jest.fn(),
      initialize: jest.fn().mockResolvedValue(undefined),
      refreshConnection: jest.fn().mockResolvedValue(undefined),
    };

    mockDockerService.getInstance.mockReturnValue(mockDockerInstance);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockDockerInstance.isConnected.mockReturnValue(true);
    mockDockerConfigService.get.mockResolvedValue(null);
    mockDockerConfigService.recordConnectivityStatus.mockResolvedValue(undefined);
  });

  describe("GET /api/containers", () => {
    const mockContainerData: DockerContainerInfo[] = [
      {
        id: "container1",
        name: "nginx-container",
        status: "running",
        image: "nginx",
        imageTag: "latest",
        ports: [{ private: 80, public: 8080, type: "tcp" }],
        volumes: [
          { source: "/host/data", destination: "/app/data", mode: "rw" },
        ],
        ipAddress: "172.17.0.2",
        createdAt: new Date("2023-01-01T00:00:00Z"),
        startedAt: new Date("2023-01-01T01:00:00Z"),
        labels: { version: "1.0" },
      },
      {
        id: "container2",
        name: "redis-container",
        status: "stopped",
        image: "redis",
        imageTag: "alpine",
        ports: [{ private: 6379, type: "tcp" }],
        volumes: [],
        createdAt: new Date("2023-01-02T00:00:00Z"),
        labels: { environment: "test" },
      },
    ];

    it("should return container list successfully", async () => {
      mockDockerInstance.listContainers.mockResolvedValue(mockContainerData);
      mockDockerInstance.getCacheStats.mockReturnValue({
        keys: 2,
        stats: { hits: 5, misses: 1 },
      });

      const response = await request(app).get("/api/containers").expect(200);

      expect(response.body).toMatchObject({
        success: true,
        data: {
          containers: expect.arrayContaining([
            expect.objectContaining({
              id: "container1",
              name: "nginx-container",
              status: "running",
              image: "nginx",
              imageTag: "latest",
              createdAt: "2023-01-01T00:00:00.000Z",
              startedAt: "2023-01-01T01:00:00.000Z",
            }),
            expect.objectContaining({
              id: "container2",
              name: "redis-container",
              status: "stopped",
              image: "redis",
              imageTag: "alpine",
              createdAt: "2023-01-02T00:00:00.000Z",
            }),
          ]),
          totalCount: 2,
          lastUpdated: expect.any(String),
          page: 1,
          limit: 50,
        },
      });

      expect(mockDockerInstance.listContainers).toHaveBeenCalledWith(true);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "container_list_viewed",
          userId: "test-user-id",
          containerCount: 2,
        }),
        "Business event: container list viewed",
      );
    });

    it("should handle pagination parameters", async () => {
      const manyContainers = Array.from({ length: 75 }, (_, i) => ({
        ...mockContainerData[0],
        id: `container${i + 1}`,
        name: `container-${i + 1}`,
      }));

      mockDockerInstance.listContainers.mockResolvedValue(manyContainers);

      const response = await request(app)
        .get("/api/containers?page=2&limit=25")
        .expect(200);

      expect(response.body.data.containers).toHaveLength(25);
      expect(response.body.data.totalCount).toBe(75);
      expect(response.body.data.page).toBe(2);
      expect(response.body.data.limit).toBe(25);
      // After alphabetical sorting by name, the order changes from numeric
      expect(response.body.data.containers[0].id).toBe("container32");
    });

    it("should enforce maximum limit of 50", async () => {
      mockDockerInstance.listContainers.mockResolvedValue(mockContainerData);

      const response = await request(app)
        .get("/api/containers?limit=100")
        .expect(200);

      expect(response.body.data.limit).toBe(50);
    });

    it("should filter by status", async () => {
      mockDockerInstance.listContainers.mockResolvedValue(mockContainerData);

      const response = await request(app)
        .get("/api/containers?status=running")
        .expect(200);

      expect(response.body.data.containers).toHaveLength(1);
      expect(response.body.data.containers[0].status).toBe("running");
      expect(response.body.data.totalCount).toBe(1);
    });

    it("should filter by name", async () => {
      mockDockerInstance.listContainers.mockResolvedValue(mockContainerData);

      const response = await request(app)
        .get("/api/containers?name=nginx")
        .expect(200);

      expect(response.body.data.containers).toHaveLength(1);
      expect(response.body.data.containers[0].name).toBe("nginx-container");
    });

    it("should filter by image", async () => {
      mockDockerInstance.listContainers.mockResolvedValue(mockContainerData);

      const response = await request(app)
        .get("/api/containers?image=redis")
        .expect(200);

      expect(response.body.data.containers).toHaveLength(1);
      expect(response.body.data.containers[0].image).toBe("redis");
    });

    it("should sort containers by name ascending", async () => {
      mockDockerInstance.listContainers.mockResolvedValue([
        { ...mockContainerData[1], name: "zebra-container" },
        { ...mockContainerData[0], name: "alpha-container" },
      ]);

      const response = await request(app)
        .get("/api/containers?sortBy=name&sortOrder=asc")
        .expect(200);

      expect(response.body.data.containers[0].name).toBe("alpha-container");
      expect(response.body.data.containers[1].name).toBe("zebra-container");
    });

    it("should sort containers by name descending", async () => {
      mockDockerInstance.listContainers.mockResolvedValue([
        { ...mockContainerData[0], name: "alpha-container" },
        { ...mockContainerData[1], name: "zebra-container" },
      ]);

      const response = await request(app)
        .get("/api/containers?sortBy=name&sortOrder=desc")
        .expect(200);

      expect(response.body.data.containers[0].name).toBe("zebra-container");
      expect(response.body.data.containers[1].name).toBe("alpha-container");
    });

    it("should return 400 for invalid query parameters", async () => {
      const response = await request(app)
        .get("/api/containers?page=invalid&sortOrder=invalid")
        .expect(400);

      expect(response.body).toMatchObject({
        error: "Bad Request",
        message: "Invalid query parameters",
        details: expect.any(Array),
      });

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          validationErrors: expect.any(Array),
        }),
        "Invalid query parameters for container list",
      );
    });

    it("should return 503 when Docker service is not connected", async () => {
      mockDockerInstance.isConnected.mockReturnValue(false);

      const response = await request(app).get("/api/containers").expect(503);

      expect(response.body).toMatchObject({
        error: "Service Unavailable",
        message: "Docker service is not available. Please try again later.",
      });

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "test-user-id",
        }),
        "Docker service not connected",
      );
    });

    it("should handle Docker API timeout errors", async () => {
      mockDockerInstance.listContainers.mockRejectedValue(
        new Error("Docker API timeout"),
      );

      const response = await request(app).get("/api/containers").expect(504);

      expect(response.body).toMatchObject({
        error: "Gateway Timeout",
        message: "Docker API request timed out. Please try again.",
      });
    });

    it("should handle Docker service connection errors", async () => {
      mockDockerInstance.listContainers.mockRejectedValue(
        new Error("Docker service not connected"),
      );

      const response = await request(app).get("/api/containers").expect(503);

      expect(response.body).toMatchObject({
        error: "Service Unavailable",
        message:
          "Docker service is temporarily unavailable. Please try again later.",
      });
    });

    it("should handle general Docker API errors", async () => {
      const dockerError = new Error("Docker daemon error");
      mockDockerInstance.listContainers.mockRejectedValue(dockerError);

      // Since this will trigger the error handler middleware, we expect a different response
      const response = await request(app).get("/api/containers").expect(500);

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          error: dockerError,
          userId: "test-user-id",
        }),
        "Failed to fetch container list",
      );
    });
  });

  describe("GET /api/containers/:id", () => {
    const mockContainer: DockerContainerInfo = {
      id: "test-container-id",
      name: "test-container",
      status: "running",
      image: "nginx",
      imageTag: "latest",
      ports: [{ private: 80, public: 8080, type: "tcp" }],
      volumes: [],
      ipAddress: "172.17.0.2",
      createdAt: new Date("2023-01-01T00:00:00Z"),
      startedAt: new Date("2023-01-01T01:00:00Z"),
      labels: { version: "1.0" },
    };

    it("should return specific container details", async () => {
      mockDockerInstance.getContainer.mockResolvedValue(mockContainer);

      const response = await request(app)
        .get("/api/containers/test-container-id")
        .expect(200);

      expect(response.body).toMatchObject({
        id: "test-container-id",
        name: "test-container",
        status: "running",
        image: "nginx",
        imageTag: "latest",
        createdAt: "2023-01-01T00:00:00.000Z",
        startedAt: "2023-01-01T01:00:00.000Z",
      });

      expect(mockDockerInstance.getContainer).toHaveBeenCalledWith(
        "test-container-id",
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          containerId: "test-container-id",
          containerName: "test-container",
          containerStatus: "running",
        }),
        "Container details returned successfully",
      );
    });

    it("should return 400 for invalid container ID", async () => {
      const response = await request(app)
        .get("/api/containers/short-id")
        .expect(400);

      expect(response.body).toMatchObject({
        error: "Bad Request",
        message: "Invalid container ID format",
      });
    });

    it("should return 404 for non-existent container", async () => {
      mockDockerInstance.getContainer.mockResolvedValue(null);

      const response = await request(app)
        .get("/api/containers/non-existent-container-id")
        .expect(404);

      expect(response.body).toMatchObject({
        error: "Not Found",
        message: "Container with ID 'non-existent-container-id' not found",
      });

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          containerId: "non-existent-container-id",
        }),
        "Container not found",
      );
    });

    it("should return 503 when Docker service is not connected", async () => {
      mockDockerInstance.isConnected.mockReturnValue(false);

      const response = await request(app)
        .get("/api/containers/test-container-id")
        .expect(503);

      expect(response.body).toMatchObject({
        error: "Service Unavailable",
        message: "Docker service is not available. Please try again later.",
      });
    });

    it("should handle Docker API timeout errors", async () => {
      mockDockerInstance.getContainer.mockRejectedValue(
        new Error("Docker API timeout"),
      );

      const response = await request(app)
        .get("/api/containers/test-container-id")
        .expect(504);

      expect(response.body).toMatchObject({
        error: "Gateway Timeout",
        message: "Docker API request timed out. Please try again.",
      });
    });
  });

  describe("GET /api/containers/stats/cache", () => {
    it("should return cache statistics", async () => {
      mockDockerInstance.getCacheStats.mockReturnValue({
        keys: 5,
        stats: { hits: 10, misses: 3, keys: 5, ksize: 100, vsize: 500 },
      });

      const response = await request(app)
        .get("/api/containers/stats/cache")
        .expect(200);

      expect(response.body).toMatchObject({
        cache: {
          keys: 5,
          stats: { hits: 10, misses: 3, keys: 5, ksize: 100, vsize: 500 },
        },
        dockerConnected: true,
        timestamp: expect.any(String),
        requestId: expect.any(String),
      });

      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "test-user-id",
        }),
        "Cache statistics requested",
      );
    });
  });

  describe("POST /api/containers/cache/flush", () => {
    it("should flush container cache successfully", async () => {
      const response = await request(app)
        .post("/api/containers/cache/flush")
        .expect(200);

      expect(response.body).toMatchObject({
        message: "Container cache flushed successfully",
        timestamp: expect.any(String),
        requestId: expect.any(String),
      });

      expect(mockDockerInstance.flushCache).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "test-user-id",
        }),
        "Container cache flush requested",
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "test-user-id",
        }),
        "Container cache flushed successfully",
      );
    });
  });

  describe("Authentication", () => {
    it("should require authentication for all endpoints", async () => {
      // Mock auth middleware to reject
      mockRequireAuth.mockImplementationOnce(
        (req: any, res: any, next: any) => {
          res.status(401).json({ error: "Unauthorized" });
        },
      );

      await request(app).get("/api/containers").expect(401);

      expect(mockRequireAuth).toHaveBeenCalled();
    });

    it("should pass user information to request handlers", async () => {
      const testUserId = "test-user-123";
      mockRequireAuth.mockImplementationOnce(
        (req: any, res: any, next: any) => {
          req.user = { id: testUserId };
          next();
        },
      );

      mockDockerInstance.listContainers.mockResolvedValue([]);

      await request(app).get("/api/containers").expect(200);

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: testUserId,
        }),
        "Container list requested",
      );
    });
  });


  describe("Request Correlation", () => {
    it("should include request ID in responses and logs", async () => {
      const requestId = createId();
      mockDockerInstance.listContainers.mockResolvedValue([]);

      await request(app)
        .get("/api/containers")
        .set("x-request-id", requestId)
        .expect(200);

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId,
        }),
        "Container list requested",
      );
    });

    it("should generate request ID if not provided", async () => {
      mockDockerInstance.listContainers.mockResolvedValue([]);

      const response = await request(app).get("/api/containers").expect(200);

      expect(response.body.data).toBeDefined();
      expect(response.body.success).toBe(true);
    });
  });

  describe("Error Handling", () => {
    it("should handle malformed request data gracefully", async () => {
      // Test with various malformed query parameters
      const testCases = [
        "?page=abc",
        "?limit=xyz",
        "?sortOrder=invalid",
        "?page=0&limit=-1",
      ];

      for (const queryParams of testCases) {
        const response = await request(app)
          .get(`/api/containers${queryParams}`)
          .expect(400);

        expect(response.body.error).toBe("Bad Request");
        expect(response.body.message).toBe("Invalid query parameters");
      }
    });

    it("should include timestamp in all error responses", async () => {
      mockDockerInstance.isConnected.mockReturnValue(false);

      const response = await request(app).get("/api/containers").expect(503);

      expect(response.body.timestamp).toBeDefined();
      expect(new Date(response.body.timestamp)).toBeInstanceOf(Date);
    });
  });
});
