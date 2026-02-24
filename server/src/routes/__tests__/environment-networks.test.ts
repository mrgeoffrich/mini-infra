import { jest } from "@jest/globals";
import request from "supertest";
import express from "express";
import { createId } from "@paralleldrive/cuid2";
import { EnvironmentNetwork } from "@mini-infra/types";

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
  environmentNetwork: {
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

describe("Environment Networks Routes", () => {
  let app: express.Application;

  beforeEach(() => {
    app = fullApp;

    // Reset all mocks
    jest.clearAllMocks();
  });

  describe("GET /api/environments/:id/networks", () => {
    it("should return networks for existing environment", async () => {
      const environmentId = createId();
      const mockNetworks: EnvironmentNetwork[] = [
        {
          id: createId(),
          environmentId,
          name: "test-network",
          driver: "bridge",
          options: {},
          dockerId: "docker-123",
          createdAt: new Date(),
        },
      ];

      const mockEnvironment = {
        id: environmentId,
        name: "test-env",
        networks: mockNetworks,
        services: [],
        volumes: [],
      };

      mockEnvironmentManager.getEnvironmentById.mockResolvedValue(mockEnvironment);

      const response = await request(app)
        .get(`/api/environments/${environmentId}/networks`)
        .expect(200);

      expect(response.body).toEqual({
        networks: mockNetworks.map(network => ({
          ...network,
          createdAt: network.createdAt.toISOString()
        })),
      });
      expect(mockEnvironmentManager.getEnvironmentById).toHaveBeenCalledWith(environmentId);
    });

    it("should return 404 for non-existent environment", async () => {
      const environmentId = createId();
      mockEnvironmentManager.getEnvironmentById.mockResolvedValue(null);

      const response = await request(app)
        .get(`/api/environments/${environmentId}/networks`)
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
        .get(`/api/environments/${environmentId}/networks`)
        .expect(500);

      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe("POST /api/environments/:id/networks", () => {
    it("should create a new network for existing environment", async () => {
      const environmentId = createId();
      const networkData = {
        name: "new-network",
        driver: "bridge",
        options: {},
      };

      const mockEnvironment = {
        id: environmentId,
        name: "test-env",
        networks: [],
        services: [],
        volumes: [],
      };

      const mockCreatedNetwork = {
        id: createId(),
        environmentId,
        ...networkData,
        createdAt: new Date(),
      };

      mockEnvironmentManager.getEnvironmentById.mockResolvedValue(mockEnvironment);
      mockPrisma.environmentNetwork.create.mockResolvedValue(mockCreatedNetwork);

      const response = await request(app)
        .post(`/api/environments/${environmentId}/networks`)
        .send(networkData)
        .expect(201);

      expect(response.body).toEqual({
        ...mockCreatedNetwork,
        createdAt: mockCreatedNetwork.createdAt.toISOString()
      });
      expect(mockPrisma.environmentNetwork.create).toHaveBeenCalledWith({
        data: {
          environmentId,
          name: networkData.name,
          driver: networkData.driver,
          options: networkData.options,
        },
      });
    });

    it("should return 409 for duplicate network name", async () => {
      const environmentId = createId();
      const networkData = {
        name: "existing-network",
        driver: "bridge",
      };

      const mockEnvironment = {
        id: environmentId,
        name: "test-env",
        networks: [
          {
            id: createId(),
            environmentId,
            name: "existing-network",
            driver: "bridge",
            options: {},
            createdAt: new Date(),
          },
        ],
        services: [],
        volumes: [],
      };

      mockEnvironmentManager.getEnvironmentById.mockResolvedValue(mockEnvironment);

      const response = await request(app)
        .post(`/api/environments/${environmentId}/networks`)
        .send(networkData)
        .expect(409);

      expect(response.body).toMatchObject({
        error: "Network name already exists",
        message: "A network with this name already exists in the environment",
      });
    });

    it("should validate network data", async () => {
      const environmentId = createId();
      const invalidNetworkData = {
        name: "", // Invalid: empty name
        driver: "bridge",
      };

      const response = await request(app)
        .post(`/api/environments/${environmentId}/networks`)
        .send(invalidNetworkData)
        .expect(400);

      expect(response.body).toMatchObject({
        error: "Invalid request data",
        message: "Validation failed",
      });
    });
  });

  describe("PUT /api/environments/:id/networks/:networkId", () => {
    it("should update an existing network", async () => {
      const environmentId = createId();
      const networkId = createId();
      const updateData = {
        name: "updated-network",
        driver: "host",
      };

      const mockExistingNetwork = {
        id: networkId,
        environmentId,
        name: "old-network",
        driver: "bridge",
        options: {},
        createdAt: new Date(),
      };

      const mockEnvironment = {
        id: environmentId,
        name: "test-env",
        networks: [mockExistingNetwork],
        services: [],
        volumes: [],
      };

      const mockUpdatedNetwork = {
        ...mockExistingNetwork,
        ...updateData,
      };

      mockEnvironmentManager.getEnvironmentById.mockResolvedValue(mockEnvironment);
      mockPrisma.environmentNetwork.update.mockResolvedValue(mockUpdatedNetwork);

      const response = await request(app)
        .put(`/api/environments/${environmentId}/networks/${networkId}`)
        .send(updateData)
        .expect(200);

      expect(response.body).toEqual({
        ...mockUpdatedNetwork,
        createdAt: mockUpdatedNetwork.createdAt.toISOString()
      });
      expect(mockPrisma.environmentNetwork.update).toHaveBeenCalledWith({
        where: { id: networkId },
        data: updateData,
      });
    });

    it("should return 404 for non-existent network", async () => {
      const environmentId = createId();
      const networkId = createId();
      const updateData = {
        name: "updated-network",
      };

      const mockEnvironment = {
        id: environmentId,
        name: "test-env",
        networks: [], // No networks
        services: [],
        volumes: [],
      };

      mockEnvironmentManager.getEnvironmentById.mockResolvedValue(mockEnvironment);

      const response = await request(app)
        .put(`/api/environments/${environmentId}/networks/${networkId}`)
        .send(updateData)
        .expect(404);

      expect(response.body).toMatchObject({
        error: "Network not found",
        message: `Network with ID ${networkId} does not exist in this environment`,
      });
    });
  });

  describe("DELETE /api/environments/:id/networks/:networkId", () => {
    it("should delete an unused network", async () => {
      const environmentId = createId();
      const networkId = createId();

      const mockExistingNetwork = {
        id: networkId,
        environmentId,
        name: "test-network",
        driver: "bridge",
        options: {},
        createdAt: new Date(),
      };

      const mockEnvironment = {
        id: environmentId,
        name: "test-env",
        networks: [mockExistingNetwork],
        services: [], // No services using the network
        volumes: [],
      };

      mockEnvironmentManager.getEnvironmentById.mockResolvedValue(mockEnvironment);
      mockPrisma.environmentNetwork.delete.mockResolvedValue(mockExistingNetwork);

      await request(app)
        .delete(`/api/environments/${environmentId}/networks/${networkId}`)
        .expect(204);

      expect(mockPrisma.environmentNetwork.delete).toHaveBeenCalledWith({
        where: { id: networkId },
      });
    });

    it("should prevent deletion of network in use by services", async () => {
      const environmentId = createId();
      const networkId = createId();

      const mockExistingNetwork = {
        id: networkId,
        environmentId,
        name: "test-network",
        driver: "bridge",
        options: {},
        createdAt: new Date(),
      };

      const mockService = {
        id: createId(),
        serviceName: "test-service",
        serviceType: "web-service",
      };

      const mockEnvironment = {
        id: environmentId,
        name: "test-env",
        networks: [mockExistingNetwork],
        services: [mockService],
        volumes: [],
      };

      // Mock service metadata that requires this network
      mockServiceRegistry.getServiceMetadata.mockReturnValue({
        requiredNetworks: [{ name: "test-network" }],
      });

      mockEnvironmentManager.getEnvironmentById.mockResolvedValue(mockEnvironment);

      const response = await request(app)
        .delete(`/api/environments/${environmentId}/networks/${networkId}`)
        .expect(400);

      expect(response.body).toMatchObject({
        error: "Network in use",
        message: "Cannot delete network that is required by services",
        details: {
          servicesUsingNetwork: ["test-service"],
        },
      });

      expect(mockPrisma.environmentNetwork.delete).not.toHaveBeenCalled();
    });

    it("should return 404 for non-existent network", async () => {
      const environmentId = createId();
      const networkId = createId();

      const mockEnvironment = {
        id: environmentId,
        name: "test-env",
        networks: [], // No networks
        services: [],
        volumes: [],
      };

      mockEnvironmentManager.getEnvironmentById.mockResolvedValue(mockEnvironment);

      const response = await request(app)
        .delete(`/api/environments/${environmentId}/networks/${networkId}`)
        .expect(404);

      expect(response.body).toMatchObject({
        error: "Network not found",
        message: `Network with ID ${networkId} does not exist in this environment`,
      });
    });
  });
});