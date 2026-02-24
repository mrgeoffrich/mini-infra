import { jest } from "@jest/globals";
import request from "supertest";
import express from "express";
import { createId } from "@paralleldrive/cuid2";
import { EnvironmentVolume } from "@mini-infra/types";

// Mock logger
const mockLogger = {
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
  child: jest.fn().mockReturnThis(), // Required for pino-http
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
  silent: jest.fn(),
  fatal: jest.fn(),
  trace: jest.fn(),
};

// Mock logger factory first (before other imports)
jest.mock("../../lib/logger-factory", () => ({
  appLogger: jest.fn(() => mockLogger),
  servicesLogger: jest.fn(() => mockLogger),
  httpLogger: jest.fn(() => mockLogger),
  prismaLogger: jest.fn(() => mockLogger),
  __esModule: true,
  default: jest.fn(() => mockLogger),
}));

// Mock dependencies
const mockEnvironmentManager = {
  getInstance: jest.fn(),
  getEnvironmentById: jest.fn(),
};

const mockServiceRegistry = {
  getInstance: jest.fn(),
  getServiceMetadata: jest.fn(),
};

const mockPrisma = {
  environmentVolume: {
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
};

jest.mock("../../services/environment/environment-manager", () => ({
  EnvironmentManager: {
    getInstance: () => mockEnvironmentManager
  }
}));

jest.mock("../../services/environment/service-registry", () => ({
  ServiceRegistry: {
    getInstance: () => mockServiceRegistry
  }
}));

jest.mock("../../lib/prisma", () => mockPrisma);

// Mock authentication middleware
jest.mock("../../middleware/auth", () => ({
  requireSessionOrApiKey: (req: any, res: any, next: any) => next(),
}));

// Import the router after mocking
// Import the full app after mocking
import fullApp from "../../app";

describe("Environment Volumes Routes", () => {
  let app: express.Application;

  beforeEach(() => {
    app = fullApp;

    // Reset all mocks
    jest.clearAllMocks();
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
          name: volumeData.name,
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
            name: "existing-volume",
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
          name: volumeData.name,
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
        name: "updated-volume",
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
        name: "updated-volume",
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

    it("should prevent name conflicts when updating", async () => {
      const environmentId = createId();
      const volumeId = createId();
      const anotherVolumeId = createId();
      const updateData = {
        name: "conflicting-name",
      };

      const mockExistingVolume = {
        id: volumeId,
        environmentId,
        name: "original-volume",
        driver: "local",
        options: {},
        createdAt: new Date(),
      };

      const mockConflictingVolume = {
        id: anotherVolumeId,
        environmentId,
        name: "conflicting-name", // Same name as update
        driver: "local",
        options: {},
        createdAt: new Date(),
      };

      const mockEnvironment = {
        id: environmentId,
        name: "test-env",
        networks: [],
        services: [],
        volumes: [mockExistingVolume, mockConflictingVolume],
      };

      mockEnvironmentManager.getEnvironmentById.mockResolvedValue(mockEnvironment);

      const response = await request(app)
        .put(`/api/environments/${environmentId}/volumes/${volumeId}`)
        .send(updateData)
        .expect(409);

      expect(response.body).toMatchObject({
        error: "Volume name already exists",
        message: "A volume with this name already exists in the environment",
      });
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

    it("should prevent deletion of volume in use by services", async () => {
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

      const mockService = {
        id: createId(),
        serviceName: "database-service",
        serviceType: "postgres",
      };

      const mockEnvironment = {
        id: environmentId,
        name: "test-env",
        networks: [],
        services: [mockService],
        volumes: [mockExistingVolume],
      };

      // Mock service metadata that requires this volume
      mockServiceRegistry.getServiceMetadata.mockReturnValue({
        requiredVolumes: [{ name: "test-volume" }],
      });

      mockEnvironmentManager.getEnvironmentById.mockResolvedValue(mockEnvironment);

      const response = await request(app)
        .delete(`/api/environments/${environmentId}/volumes/${volumeId}`)
        .expect(400);

      expect(response.body).toMatchObject({
        error: "Volume in use",
        message: "Cannot delete volume that is required by services",
        details: {
          servicesUsingVolume: ["database-service"],
        },
      });

      expect(mockPrisma.environmentVolume.delete).not.toHaveBeenCalled();
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