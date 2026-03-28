import request from "supertest";
import express from "express";
import { createId } from "@paralleldrive/cuid2";
import { EnvironmentVolume } from "@mini-infra/types";

// Hoist mock variables that are used inside vi.mock() factory functions
const {
  mockLogger,
  mockEnvironmentManager,
  mockPrisma,
} = vi.hoisted(() => ({
  mockLogger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(), // Required for pino-http
    level: "info",
    levels: {
      values: {
        fatal: 60,
        error: 50,
        warn: 40,
        info: 30,
        debug: 20,
        trace: 10,
      },
    },
    silent: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  },
  mockEnvironmentManager: {
    getInstance: vi.fn(),
    getEnvironmentById: vi.fn(),
  },
  mockPrisma: {
    environmentVolume: {
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

// Mock logger factory first (before other imports)
vi.mock("../../lib/logger-factory", () => ({
  appLogger: vi.fn(function() { return mockLogger; }),
  servicesLogger: vi.fn(function() { return mockLogger; }),
  httpLogger: vi.fn(function() { return mockLogger; }),
  prismaLogger: vi.fn(function() { return mockLogger; }),
  dockerExecutorLogger: vi.fn(function() { return mockLogger; }),
  deploymentLogger: vi.fn(function() { return mockLogger; }),
  loadbalancerLogger: vi.fn(function() { return mockLogger; }),
  selfBackupLogger: vi.fn(function() { return mockLogger; }),
  tlsLogger: vi.fn(function() { return mockLogger; }),
  agentLogger: vi.fn(function() { return mockLogger; }),
  default: vi.fn(function() { return mockLogger; }),
}));

// Mock dependencies
vi.mock("../../services/environment/environment-manager", () => ({
  EnvironmentManager: {
    getInstance: () => mockEnvironmentManager
  }
}));

vi.mock("../../lib/prisma", () => ({ default: mockPrisma }));

// Mock authentication middleware
vi.mock("../../middleware/auth", () => ({
  requireSessionOrApiKey: (req: any, res: any, next: any) => next(),
  requirePermission: () => (req: any, res: any, next: any) => next(),
}));

// Import the router after mocking
import environmentVolumesRouter from "../environment-volumes";

describe("Environment Volumes Routes", () => {
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    // Mount the sub-router with mergeParams support at the correct path
    app.use("/api/environments/:id/volumes", environmentVolumesRouter);

    // Reset all mocks
    vi.clearAllMocks();
  });

  describe("GET /api/environments/:id/volumes", () => {
    it("should return volumes for existing environment", async () => {
      const environmentId = createId();
      const mockVolumes: EnvironmentVolume[] = [
        {
          id: createId(),
          environmentId,
          name: "test-volume",
          driver: "local",
          options: {},
          dockerId: "docker-vol-123",
          createdAt: new Date(),
        },
      ];

      const mockEnvironment = {
        id: environmentId,
        name: "test-env",
        networks: [],
        services: [],
        volumes: mockVolumes,
      };

      mockEnvironmentManager.getEnvironmentById.mockResolvedValue(mockEnvironment);

      const response = await request(app)
        .get(`/api/environments/${environmentId}/volumes`)
        .expect(200);

      expect(response.body).toEqual({
        volumes: mockVolumes.map(volume => ({
          ...volume,
          createdAt: volume.createdAt.toISOString()
        })),
      });
      expect(mockEnvironmentManager.getEnvironmentById).toHaveBeenCalledWith(environmentId);
    });

    it("should return 404 for non-existent environment", async () => {
      const environmentId = createId();
      mockEnvironmentManager.getEnvironmentById.mockResolvedValue(null);

      const response = await request(app)
        .get(`/api/environments/${environmentId}/volumes`)
        .expect(404);

      expect(response.body).toMatchObject({
        error: "Environment not found",
        message: `Environment with ID ${environmentId} does not exist`,
      });
    });

    it("should handle server errors gracefully", async () => {
      const environmentId = createId();
      mockEnvironmentManager.getEnvironmentById.mockRejectedValue(new Error("Database error"));

      await request(app)
        .get(`/api/environments/${environmentId}/volumes`)
        .expect(500);

      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe("POST /api/environments/:id/volumes", () => {
    it("should create a new volume for existing environment", async () => {
      const environmentId = createId();
      const volumeData = {
        name: "new-volume",
        driver: "local",
        options: { type: "tmpfs" },
      };

      const mockEnvironment = {
        id: environmentId,
        name: "test-env",
        networks: [],
        services: [],
        volumes: [],
      };

      const mockCreatedVolume = {
        id: createId(),
        environmentId,
        ...volumeData,
        createdAt: new Date(),
      };

      mockEnvironmentManager.getEnvironmentById.mockResolvedValue(mockEnvironment);
      mockPrisma.environmentVolume.create.mockResolvedValue(mockCreatedVolume);

      const response = await request(app)
        .post(`/api/environments/${environmentId}/volumes`)
        .send(volumeData)
        .expect(201);

      expect(response.body).toEqual({
      ...mockCreatedVolume,
      createdAt: mockCreatedVolume.createdAt.toISOString()
    });
      expect(mockPrisma.environmentVolume.create).toHaveBeenCalledWith({
        data: {
          environmentId,
          name: `test-env-${volumeData.name}`,
          driver: volumeData.driver,
          options: volumeData.options,
        },
      });
    });

    it("should return 409 for duplicate volume name", async () => {
      const environmentId = createId();
      const volumeData = {
        name: "existing-volume",
        driver: "local",
      };

      const mockEnvironment = {
        id: environmentId,
        name: "test-env",
        networks: [],
        services: [],
        volumes: [
          {
            id: createId(),
            environmentId,
            name: "test-env-existing-volume",
            driver: "local",
            options: {},
            createdAt: new Date(),
          },
        ],
      };

      mockEnvironmentManager.getEnvironmentById.mockResolvedValue(mockEnvironment);

      const response = await request(app)
        .post(`/api/environments/${environmentId}/volumes`)
        .send(volumeData)
        .expect(409);

      expect(response.body).toMatchObject({
        error: "Volume name already exists",
        message: "A volume with this name already exists in the environment",
      });
    });

    it("should validate volume data", async () => {
      const environmentId = createId();
      const invalidVolumeData = {
        name: "", // Invalid: empty name
        driver: "local",
      };

      const response = await request(app)
        .post(`/api/environments/${environmentId}/volumes`)
        .send(invalidVolumeData)
        .expect(400);

      expect(response.body).toMatchObject({
        error: "Invalid request data",
        message: "Validation failed",
      });
    });

    it("should use default driver when not specified", async () => {
      const environmentId = createId();
      const volumeData = {
        name: "new-volume",
        // No driver specified - should default to "local"
      };

      const mockEnvironment = {
        id: environmentId,
        name: "test-env",
        networks: [],
        services: [],
        volumes: [],
      };

      const mockCreatedVolume = {
        id: createId(),
        environmentId,
        name: volumeData.name,
        driver: "local", // Default driver
        options: {},
        createdAt: new Date(),
      };

      mockEnvironmentManager.getEnvironmentById.mockResolvedValue(mockEnvironment);
      mockPrisma.environmentVolume.create.mockResolvedValue(mockCreatedVolume);

      const response = await request(app)
        .post(`/api/environments/${environmentId}/volumes`)
        .send(volumeData)
        .expect(201);

      expect(response.body).toEqual({
      ...mockCreatedVolume,
      createdAt: mockCreatedVolume.createdAt.toISOString()
    });
      expect(mockPrisma.environmentVolume.create).toHaveBeenCalledWith({
        data: {
          environmentId,
          name: `test-env-${volumeData.name}`,
          driver: "local",
          options: {},
        },
      });
    });
  });

  describe("PUT /api/environments/:id/volumes/:volumeId", () => {
    it("should update an existing volume", async () => {
      const environmentId = createId();
      const volumeId = createId();
      const updateData = {
        driver: "nfs",
        options: { server: "192.168.1.100" },
      };

      const mockExistingVolume = {
        id: volumeId,
        environmentId,
        name: "old-volume",
        driver: "local",
        options: {},
        createdAt: new Date(),
      };

      const mockEnvironment = {
        id: environmentId,
        name: "test-env",
        networks: [],
        services: [],
        volumes: [mockExistingVolume],
      };

      const mockUpdatedVolume = {
        ...mockExistingVolume,
        ...updateData,
      };

      mockEnvironmentManager.getEnvironmentById.mockResolvedValue(mockEnvironment);
      mockPrisma.environmentVolume.update.mockResolvedValue(mockUpdatedVolume);

      const response = await request(app)
        .put(`/api/environments/${environmentId}/volumes/${volumeId}`)
        .send(updateData)
        .expect(200);

      expect(response.body).toEqual({
      ...mockUpdatedVolume,
      createdAt: mockUpdatedVolume.createdAt.toISOString()
    });
      expect(mockPrisma.environmentVolume.update).toHaveBeenCalledWith({
        where: { id: volumeId },
        data: updateData,
      });
    });

    it("should return 404 for non-existent volume", async () => {
      const environmentId = createId();
      const volumeId = createId();
      const updateData = {
        driver: "nfs",
      };

      const mockEnvironment = {
        id: environmentId,
        name: "test-env",
        networks: [],
        services: [],
        volumes: [], // No volumes
      };

      mockEnvironmentManager.getEnvironmentById.mockResolvedValue(mockEnvironment);

      const response = await request(app)
        .put(`/api/environments/${environmentId}/volumes/${volumeId}`)
        .send(updateData)
        .expect(404);

      expect(response.body).toMatchObject({
        error: "Volume not found",
        message: `Volume with ID ${volumeId} does not exist in this environment`,
      });
    });

    it("should ignore name field in update (name is immutable)", async () => {
      const environmentId = createId();
      const volumeId = createId();
      const updateData = {
        driver: "nfs",
      };

      const mockExistingVolume = {
        id: volumeId,
        environmentId,
        name: "original-volume",
        driver: "local",
        options: {},
        createdAt: new Date(),
      };

      const mockEnvironment = {
        id: environmentId,
        name: "test-env",
        networks: [],
        services: [],
        volumes: [mockExistingVolume],
      };

      const mockUpdatedVolume = {
        ...mockExistingVolume,
        driver: "nfs",
      };

      mockEnvironmentManager.getEnvironmentById.mockResolvedValue(mockEnvironment);
      mockPrisma.environmentVolume.update.mockResolvedValue(mockUpdatedVolume);

      const response = await request(app)
        .put(`/api/environments/${environmentId}/volumes/${volumeId}`)
        .send(updateData)
        .expect(200);

      // Name should remain unchanged
      expect(response.body.name).toBe("original-volume");
      expect(response.body.driver).toBe("nfs");
    });
  });

  describe("DELETE /api/environments/:id/volumes/:volumeId", () => {
    it("should delete an unused volume", async () => {
      const environmentId = createId();
      const volumeId = createId();

      const mockExistingVolume = {
        id: volumeId,
        environmentId,
        name: "test-volume",
        driver: "local",
        options: {},
        createdAt: new Date(),
      };

      const mockEnvironment = {
        id: environmentId,
        name: "test-env",
        networks: [],
        services: [], // No services using the volume
        volumes: [mockExistingVolume],
      };

      mockEnvironmentManager.getEnvironmentById.mockResolvedValue(mockEnvironment);
      mockPrisma.environmentVolume.delete.mockResolvedValue(mockExistingVolume);

      await request(app)
        .delete(`/api/environments/${environmentId}/volumes/${volumeId}`)
        .expect(204);

      expect(mockPrisma.environmentVolume.delete).toHaveBeenCalledWith({
        where: { id: volumeId },
      });
    });

    it("should return 404 for non-existent volume", async () => {
      const environmentId = createId();
      const volumeId = createId();

      const mockEnvironment = {
        id: environmentId,
        name: "test-env",
        networks: [],
        services: [],
        volumes: [], // No volumes
      };

      mockEnvironmentManager.getEnvironmentById.mockResolvedValue(mockEnvironment);

      const response = await request(app)
        .delete(`/api/environments/${environmentId}/volumes/${volumeId}`)
        .expect(404);

      expect(response.body).toMatchObject({
        error: "Volume not found",
        message: `Volume with ID ${volumeId} does not exist in this environment`,
      });
    });
  });
});