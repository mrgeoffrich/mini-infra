import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals";
import supertest from "supertest";
import { testPrisma, createTestUser, createTestApiKey } from "./setup";
import express from "express";
import deploymentRoutes from "../routes/deployments";
import { DeploymentOrchestrator } from "../services/deployment-orchestrator";
import { DeploymentConfigurationManager } from "../services/deployment-config";
import {
  CreateDeploymentConfigRequest,
  DeploymentConfigResponse,
  DeploymentConfigListResponse,
  DeploymentResponse,
  DeploymentListResponse,
} from "@mini-infra/types";

// Mock the deployment orchestrator
jest.mock("../services/deployment-orchestrator", () => {
  const mockOrchestrator = {
    triggerDeployment: jest.fn(),
    rollbackDeployment: jest.fn(),
    getDeploymentStatus: jest.fn(),
    initialize: jest.fn().mockResolvedValue(undefined),
  };

  return {
    DeploymentOrchestrator: jest.fn().mockImplementation(() => mockOrchestrator),
    __mockOrchestrator: mockOrchestrator, // Export for test use
  };
});

// Get reference to the mocked orchestrator and service
const { __mockOrchestrator: mockOrchestrator } = require("../services/deployment-orchestrator");
const { __mockDeploymentConfigurationManager: mockDeploymentConfigurationManager } = require("../services/deployment-config");

// Mock the deployment config service
jest.mock("../services/deployment-config", () => {
  const mockService = {
    listDeploymentConfigs: jest.fn(),
    createDeploymentConfig: jest.fn(),
    getDeploymentConfig: jest.fn(),
    getDeploymentConfigByName: jest.fn(),
    updateDeploymentConfig: jest.fn(),
    deleteDeploymentConfig: jest.fn(),
  };
  return {
    DeploymentConfigurationManager: jest.fn().mockImplementation(() => mockService),
    __mockDeploymentConfigurationManager: mockService, // Export for test use
  };
});

// Mock logger factory
jest.mock("../lib/logger-factory.ts", () => ({
  servicesLogger: jest.fn(() => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  })),
  __esModule: true,
  default: jest.fn(() => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  })),
}));

// Mock prisma with full model methods
jest.mock("../lib/prisma", () => ({
  deploymentConfiguration: {
    count: jest.fn().mockResolvedValue(0),
    findMany: jest.fn().mockResolvedValue([]),
    findFirst: jest.fn().mockResolvedValue(null),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    deleteMany: jest.fn(),
  },
  deployment: {
    count: jest.fn().mockResolvedValue(0),
    findMany: jest.fn().mockResolvedValue([]),
    findFirst: jest.fn().mockResolvedValue(null),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    deleteMany: jest.fn(),
  },
  deploymentStep: {
    count: jest.fn().mockResolvedValue(0),
    findMany: jest.fn().mockResolvedValue([]),
    findFirst: jest.fn().mockResolvedValue(null),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    deleteMany: jest.fn(),
  },
  default: {
    deploymentConfiguration: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
    },
    deployment: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
    },
    deploymentStep: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
    },
  },
}));

// Mock middleware functions
jest.mock("../middleware/auth", () => ({
  requireSessionOrApiKey: (req: any, res: any, next: any) => {
    if (req.headers["x-api-key"] && req.headers["x-api-key"].startsWith("test-key")) {
      req.user = { id: req.headers["x-user-id"] || "test-user-id" };
      return next();
    }
    if (req.session?.user) {
      req.user = req.session.user;
      return next();
    }
    return res.status(401).json({ success: false, message: "Authentication required" });
  },
  getAuthenticatedUser: (req: any) => req.user,
}));

describe("Deployment API Integration Tests", () => {
  let app: express.Application;
  let testUserId: string;
  let testEnvironmentId: string;
  let apiKey: string;

  beforeEach(async () => {
    jest.clearAllMocks();

    // Set environment variable for encryption key
    process.env.ENCRYPTION_KEY = "test-encryption-key-12345678901234567890123456";

    // Clean database
    await testPrisma.deployment.deleteMany();
    await testPrisma.deploymentStep.deleteMany();
    await testPrisma.deploymentConfiguration.deleteMany();
    await testPrisma.environment.deleteMany();
    await testPrisma.apiKey.deleteMany();
    await testPrisma.user.deleteMany();

    // Create test user and API key
    const user = await createTestUser();
    testUserId = user.id;
    const key = await createTestApiKey(testUserId, "Test API Key");
    apiKey = `test-key-${key.id}`;

    // Create test environment
    const environment = await testPrisma.environment.create({
      data: {
        name: "test-env",
        description: "Test environment",
        type: "nonproduction",
        status: "initialized",
        isActive: true,
      },
    });
    testEnvironmentId = environment.id;

    // Setup Express app with routes
    app = express();
    app.use(express.json());
    app.use("/api/deployments", deploymentRoutes);

    // Setup default mocks
    mockDeploymentConfigurationManager.listDeploymentConfigs.mockResolvedValue([]);
    mockOrchestrator.triggerDeployment.mockResolvedValue({
      id: "deployment-123",
      status: "pending",
      startedAt: new Date(),
    });

  });

  afterEach(async () => {
    // Clean database
    await testPrisma.deployment.deleteMany();
    await testPrisma.deploymentStep.deleteMany();
    await testPrisma.deploymentConfiguration.deleteMany();
    await testPrisma.environment.deleteMany();
    await testPrisma.apiKey.deleteMany();
    await testPrisma.user.deleteMany();
  });

  // Helper function to create valid deployment config request
  const createValidDeploymentConfigRequest = (): CreateDeploymentConfigRequest => ({
    applicationName: "test-app",
    dockerImage: "nginx",
    dockerRegistry: "docker.io",
    containerConfig: {
      ports: [
        {
          containerPort: 80,
          hostPort: 8080,
          protocol: "tcp",
        },
      ],
      volumes: [
        {
          hostPath: "/host/data",
          containerPath: "/app/data",
          mode: "rw",
        },
      ],
      environment: [
        {
          name: "NODE_ENV",
          value: "production",
        },
      ],
      labels: {
        "app.name": "test-app",
        "app.version": "1.0.0",
      },
      networks: ["app-network"],
    },
    healthCheckConfig: {
      endpoint: "/health",
      method: "GET",
      expectedStatus: [200, 204],
      responseValidation: "OK",
      timeout: 5000,
      retries: 3,
      interval: 10000,
    },
    rollbackConfig: {
      enabled: true,
      maxWaitTime: 30000,
      keepOldContainer: false,
    },
    environmentId: testEnvironmentId,
  });

  describe("Deployment Configuration Routes", () => {
    describe("GET /api/deployments/configs", () => {
      it("should list deployment configurations with valid API key", async () => {
        const mockConfigs = [
          {
            id: "config-1",
            ...createValidDeploymentConfigRequest(),
            applicationName: "test-app-1",
            dockerImage: "nginx:latest",
            isActive: true,
            environmentId: testEnvironmentId,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ];

        mockDeploymentConfigurationManager.listDeploymentConfigs.mockResolvedValue(mockConfigs);

        const response = await supertest(app)
          .get("/api/deployments/configs")
          .set("x-api-key", apiKey)
          .set("x-user-id", testUserId)
          .expect(200);

        const body = response.body as DeploymentConfigListResponse;
        expect(body.success).toBe(true);
        expect(body.data).toHaveLength(1);
        expect(body.data[0].applicationName).toBe("test-app-1");
        expect(body.pagination).toBeDefined();
      });

      it("should handle query parameters correctly", async () => {
        mockDeploymentConfigurationManager.listDeploymentConfigs.mockResolvedValue([]);

        await supertest(app)
          .get("/api/deployments/configs")
          .query({
            page: "2",
            limit: "10",
            applicationName: "test-app",
            isActive: "true",
          })
          .set("x-api-key", apiKey)
          .set("x-user-id", testUserId)
          .expect(200);

        expect(mockDeploymentConfigurationManager.listDeploymentConfigs).toHaveBeenCalledWith(
          { applicationName: "test-app", isActive: true },
          { field: "createdAt", order: "desc" },
          10,
          10
        );
      });

      it("should return 400 for invalid query parameters", async () => {
        await supertest(app)
          .get("/api/deployments/configs")
          .query({ page: "0", limit: "101" })
          .set("x-api-key", apiKey)
          .set("x-user-id", testUserId)
          .expect(400);
      });

      it("should return 401 without authentication", async () => {
        await supertest(app)
          .get("/api/deployments/configs")
          .expect(401);
      });
    });

    describe("POST /api/deployments/configs", () => {
      it("should create deployment configuration successfully", async () => {
        const configRequest = createValidDeploymentConfigRequest();
        const mockCreatedConfig = {
          id: "config-123",
          ...configRequest,
          isActive: true,
          environmentId: testEnvironmentId,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        mockDeploymentConfigurationManager.createDeploymentConfig.mockResolvedValue(mockCreatedConfig);

        const response = await supertest(app)
          .post("/api/deployments/configs")
          .set("x-api-key", apiKey)
          .set("x-user-id", testUserId)
          .send(configRequest)
          .expect(201);

        const body = response.body as DeploymentConfigResponse;
        expect(body.success).toBe(true);
        expect(body.data.applicationName).toBe("test-app");
        expect(body.message).toContain("created successfully");

        expect(mockDeploymentConfigurationManager.createDeploymentConfig).toHaveBeenCalledWith(
          configRequest
        );
      });

      it("should return 400 for invalid configuration data", async () => {
        const invalidConfig = {
          applicationName: "", // Invalid: empty
          dockerImage: "nginx",
          // Missing required fields
        };

        const response = await supertest(app)
          .post("/api/deployments/configs")
          .set("x-api-key", apiKey)
          .set("x-user-id", testUserId)
          .send(invalidConfig)
          .expect(400);

        expect(response.body.success).toBe(false);
        expect(response.body.errors).toBeDefined();
      });

      it("should return 409 for duplicate application name", async () => {
        const configRequest = createValidDeploymentConfigRequest();
        mockDeploymentConfigurationManager.createDeploymentConfig.mockRejectedValue(
          new Error("Deployment configuration for application 'test-app' already exists")
        );

        const response = await supertest(app)
          .post("/api/deployments/configs")
          .set("x-api-key", apiKey)
          .set("x-user-id", testUserId)
          .send(configRequest)
          .expect(409);

        expect(response.body.success).toBe(false);
        expect(response.body.message).toContain("already exists");
      });

      it("should validate port ranges", async () => {
        const configRequest = {
          ...createValidDeploymentConfigRequest(),
          containerConfig: {
            ...createValidDeploymentConfigRequest().containerConfig,
            ports: [
              {
                containerPort: 70000, // Invalid: too high
                hostPort: 8080,
                protocol: "tcp" as const,
              },
            ],
          },
        };

        await supertest(app)
          .post("/api/deployments/configs")
          .set("x-api-key", apiKey)
          .set("x-user-id", testUserId)
          .send(configRequest)
          .expect(400);
      });

      it("should validate application name format", async () => {
        const configRequest = {
          ...createValidDeploymentConfigRequest(),
          applicationName: "invalid app name!", // Invalid characters
        };

        await supertest(app)
          .post("/api/deployments/configs")
          .set("x-api-key", apiKey)
          .set("x-user-id", testUserId)
          .send(configRequest)
          .expect(400);
      });
    });

    describe("GET /api/deployments/configs/:id", () => {
      it("should get deployment configuration by ID", async () => {
        const mockConfig = {
          id: "config-123",
          ...createValidDeploymentConfigRequest(),
          isActive: true,
          environmentId: testEnvironmentId,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        mockDeploymentConfigurationManager.getDeploymentConfig.mockResolvedValue(mockConfig);

        const response = await supertest(app)
          .get("/api/deployments/configs/config-123")
          .set("x-api-key", apiKey)
          .set("x-user-id", testUserId)
          .expect(200);

        const body = response.body as DeploymentConfigResponse;
        expect(body.success).toBe(true);
        expect(body.data.id).toBe("config-123");

        expect(mockDeploymentConfigurationManager.getDeploymentConfig).toHaveBeenCalledWith(
          "config-123"
        );
      });

      it("should return 404 for non-existent configuration", async () => {
        mockDeploymentConfigurationManager.getDeploymentConfig.mockResolvedValue(null);

        const response = await supertest(app)
          .get("/api/deployments/configs/non-existent")
          .set("x-api-key", apiKey)
          .set("x-user-id", testUserId)
          .expect(404);

        expect(response.body.success).toBe(false);
        expect(response.body.message).toContain("not found");
      });
    });

    describe("PUT /api/deployments/configs/:id", () => {
      it("should update deployment configuration successfully", async () => {
        const updateData = {
          dockerImage: "nginx:1.21",
          isActive: false,
        };

        const mockUpdatedConfig = {
          id: "config-123",
          ...createValidDeploymentConfigRequest(),
          ...updateData,
          environmentId: testEnvironmentId,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        mockDeploymentConfigurationManager.updateDeploymentConfig.mockResolvedValue(mockUpdatedConfig);

        const response = await supertest(app)
          .put("/api/deployments/configs/config-123")
          .set("x-api-key", apiKey)
          .set("x-user-id", testUserId)
          .send(updateData)
          .expect(200);

        const body = response.body as DeploymentConfigResponse;
        expect(body.success).toBe(true);
        expect(body.data.dockerImage).toBe("nginx:1.21");
        expect(body.data.isActive).toBe(false);
        expect(body.message).toContain("updated successfully");

        expect(mockDeploymentConfigurationManager.updateDeploymentConfig).toHaveBeenCalledWith(
          "config-123",
          updateData
        );
      });

      it("should return 404 for non-existent configuration", async () => {
        mockDeploymentConfigurationManager.updateDeploymentConfig.mockRejectedValue(
          new Error("Deployment configuration not found or access denied")
        );

        const response = await supertest(app)
          .put("/api/deployments/configs/non-existent")
          .set("x-api-key", apiKey)
          .set("x-user-id", testUserId)
          .send({ dockerImage: "nginx:latest" })
          .expect(404);

        expect(response.body.success).toBe(false);
        expect(response.body.message).toContain("not found");
      });

      it("should return 400 for invalid update data", async () => {
        const invalidUpdate = {
          applicationName: "invalid name!",
        };

        await supertest(app)
          .put("/api/deployments/configs/config-123")
          .set("x-api-key", apiKey)
          .set("x-user-id", testUserId)
          .send(invalidUpdate)
          .expect(400);
      });
    });

    describe("DELETE /api/deployments/configs/:id", () => {
      it("should delete deployment configuration successfully", async () => {
        mockDeploymentConfigurationManager.deleteDeploymentConfig.mockResolvedValue(undefined);

        const response = await supertest(app)
          .delete("/api/deployments/configs/config-123")
          .set("x-api-key", apiKey)
          .set("x-user-id", testUserId)
          .expect(200);

        expect(response.body.success).toBe(true);
        expect(response.body.message).toContain("deleted successfully");

        expect(mockDeploymentConfigurationManager.deleteDeploymentConfig).toHaveBeenCalledWith(
          "config-123"
        );
      });

      it("should return 404 for non-existent configuration", async () => {
        mockDeploymentConfigurationManager.deleteDeploymentConfig.mockRejectedValue(
          new Error("Deployment configuration not found or access denied")
        );

        const response = await supertest(app)
          .delete("/api/deployments/configs/non-existent")
          .set("x-api-key", apiKey)
          .set("x-user-id", testUserId)
          .expect(404);

        expect(response.body.success).toBe(false);
      });
    });
  });

  describe("Deployment Operation Routes", () => {
    describe("POST /api/deployments/trigger", () => {
      it("should trigger deployment successfully", async () => {
        const mockConfig = {
          id: "config-123",
          applicationName: "test-app",
          dockerImage: "nginx",
          isActive: true,
          ...createValidDeploymentConfigRequest(),
        };

        const mockDeployment = {
          id: "deployment-123",
          configurationId: "config-123",
          triggerType: "manual",
          triggeredBy: testUserId,
          dockerImage: "nginx:latest",
          status: "pending",
          startedAt: new Date(),
        };

        mockDeploymentConfigurationManager.getDeploymentConfigByName.mockResolvedValue(mockConfig);
        mockOrchestrator.triggerDeployment.mockResolvedValue(mockDeployment);

        const response = await supertest(app)
          .post("/api/deployments/trigger")
          .set("x-api-key", apiKey)
          .set("x-user-id", testUserId)
          .send({
            applicationName: "test-app",
            tag: "latest",
            force: false,
          })
          .expect(202);

        const body = response.body as DeploymentResponse;
        expect(body.success).toBe(true);
        expect(body.data.id).toBe("deployment-123");
        expect(body.message).toContain("triggered successfully");

        expect(mockOrchestrator.triggerDeployment).toHaveBeenCalledWith({
          configurationId: "config-123",
          triggerType: "manual",
          triggeredBy: testUserId,
          dockerImage: "nginx:latest",
          force: false,
        });
      });

      it("should return 404 for non-existent application", async () => {
        mockDeploymentConfigurationManager.getDeploymentConfigByName.mockResolvedValue(null);

        const response = await supertest(app)
          .post("/api/deployments/trigger")
          .set("x-api-key", apiKey)
          .set("x-user-id", testUserId)
          .send({
            applicationName: "non-existent-app",
          })
          .expect(404);

        expect(response.body.success).toBe(false);
        expect(response.body.message).toContain("not found");
      });

      it("should return 400 for inactive configuration", async () => {
        const mockConfig = {
          id: "config-123",
          applicationName: "test-app",
          dockerImage: "nginx",
          isActive: false, // Inactive
          ...createValidDeploymentConfigRequest(),
        };

        mockDeploymentConfigurationManager.getDeploymentConfigByName.mockResolvedValue(mockConfig);

        const response = await supertest(app)
          .post("/api/deployments/trigger")
          .set("x-api-key", apiKey)
          .set("x-user-id", testUserId)
          .send({
            applicationName: "test-app",
          })
          .expect(400);

        expect(response.body.success).toBe(false);
        expect(response.body.message).toContain("not active");
      });

      it("should return 400 for invalid trigger data", async () => {
        await supertest(app)
          .post("/api/deployments/trigger")
          .set("x-api-key", apiKey)
          .set("x-user-id", testUserId)
          .send({
            // Missing applicationName
            tag: "latest",
          })
          .expect(400);
      });

      it("should use dockerImage from config when no tag provided", async () => {
        const baseConfig = createValidDeploymentConfigRequest();
        const mockConfig = {
          id: "config-123",
          applicationName: "test-app",
          dockerImage: "nginx:1.20", // Already has tag
          isActive: true,
          ...baseConfig,
          dockerImage: "nginx:1.20", // Override to ensure correct image
        };

        mockDeploymentConfigurationManager.getDeploymentConfigByName.mockResolvedValue(mockConfig);
        mockOrchestrator.triggerDeployment.mockResolvedValue({
          id: "deployment-123",
          startedAt: new Date(),
        });

        await supertest(app)
          .post("/api/deployments/trigger")
          .set("x-api-key", apiKey)
          .set("x-user-id", testUserId)
          .send({
            applicationName: "test-app",
            // No tag provided
          })
          .expect(202);

        expect(mockOrchestrator.triggerDeployment).toHaveBeenCalledWith(
          expect.objectContaining({
            dockerImage: "nginx:1.20", // Should use image from config
          })
        );
      });
    });

    describe("GET /api/deployments/:id/status", () => {
      it("should get deployment status successfully", async () => {
        const mockDeployment = {
          id: "deployment-123",
          status: "deploying",
          startedAt: new Date("2023-01-01T10:00:00Z"),
          completedAt: null,
          configuration: { userId: testUserId },
          deploymentSteps: [
            {
              id: "step-1",
              deploymentId: "deployment-123",
              stepName: "pull_image",
              status: "completed",
              startedAt: new Date("2023-01-01T10:00:00Z"),
              completedAt: new Date("2023-01-01T10:01:00Z"),
              duration: 60000,
              output: "Image pulled successfully",
              errorMessage: null,
            },
            {
              id: "step-2",
              deploymentId: "deployment-123",
              stepName: "create_container",
              status: "running",
              startedAt: new Date("2023-01-01T10:01:00Z"),
              completedAt: null,
              duration: null,
              output: "Creating container...",
              errorMessage: null,
            },
          ],
        };

        // Mock the prisma query
        const mockPrisma = require("../lib/prisma");
        mockPrisma.deployment.findFirst.mockResolvedValue(mockDeployment);
        mockPrisma.default.deployment.findFirst.mockResolvedValue(mockDeployment);

        const response = await supertest(app)
          .get("/api/deployments/deployment-123/status")
          .set("x-api-key", apiKey)
          .set("x-user-id", testUserId)
          .expect(200);

        expect(response.body.success).toBe(true);
        expect(response.body.data.id).toBe("deployment-123");
        expect(response.body.data.progress).toBe(50); // 1 of 2 steps completed
        expect(response.body.data.steps).toHaveLength(2);
        expect(response.body.data.logs).toBeDefined();
      });

      it("should return 404 for non-existent deployment", async () => {
        const mockPrisma = require("../lib/prisma");
        mockPrisma.deployment.findFirst.mockResolvedValue(null);
        mockPrisma.default.deployment.findFirst.mockResolvedValue(null);

        const response = await supertest(app)
          .get("/api/deployments/non-existent/status")
          .set("x-api-key", apiKey)
          .set("x-user-id", testUserId)
          .expect(404);

        expect(response.body.success).toBe(false);
        expect(response.body.message).toContain("not found");
      });

      it("should calculate progress correctly", async () => {
        const mockDeployment = {
          id: "deployment-123",
          status: "completed",
          startedAt: new Date(),
          completedAt: new Date(),
          configuration: { userId: testUserId },
          deploymentSteps: [
            { status: "completed", output: "Step 1 done" },
            { status: "completed", output: "Step 2 done" },
            { status: "completed", output: "Step 3 done" },
          ].map((step, i) => ({
            id: `step-${i + 1}`,
            deploymentId: "deployment-123",
            stepName: `step_${i + 1}`,
            startedAt: new Date(),
            completedAt: new Date(),
            duration: 1000,
            errorMessage: null,
            ...step,
          })),
        };

        const mockPrisma = require("../lib/prisma");
        mockPrisma.deployment.findFirst.mockResolvedValue(mockDeployment);
        mockPrisma.default.deployment.findFirst.mockResolvedValue(mockDeployment);

        const response = await supertest(app)
          .get("/api/deployments/deployment-123/status")
          .set("x-api-key", apiKey)
          .set("x-user-id", testUserId)
          .expect(200);

        expect(response.body.data.progress).toBe(100); // All steps completed
      });
    });

    describe("POST /api/deployments/:id/rollback", () => {
      it("should rollback deployment successfully", async () => {
        const mockDeployment = {
          id: "deployment-123",
          status: "completed",
          configurationId: "config-123",
          configuration: {
            environmentId: testEnvironmentId,
            applicationName: "test-app",
          },
          startedAt: new Date(),
          completedAt: new Date(),
        };

        const mockRolledBackDeployment = {
          ...mockDeployment,
          status: "rolling_back",
        };

        const mockPrisma = require("../lib/prisma");
        mockPrisma.deployment.findFirst.mockResolvedValue(mockDeployment);
        mockPrisma.default.deployment.findFirst.mockResolvedValue(mockDeployment);
        mockOrchestrator.rollbackDeployment.mockResolvedValue(mockRolledBackDeployment);

        const response = await supertest(app)
          .post("/api/deployments/deployment-123/rollback")
          .set("x-api-key", apiKey)
          .set("x-user-id", testUserId)
          .expect(200);

        const body = response.body as DeploymentResponse;
        expect(body.success).toBe(true);
        expect(body.data.id).toBe("deployment-123");
        expect(body.message).toContain("rollback initiated");

        expect(mockOrchestrator.rollbackDeployment).toHaveBeenCalledWith("deployment-123");
      });

      it("should return 404 for non-existent deployment", async () => {
        const mockPrisma = require("../lib/prisma");
        mockPrisma.deployment.findFirst.mockResolvedValue(null);
        mockPrisma.default.deployment.findFirst.mockResolvedValue(null);

        const response = await supertest(app)
          .post("/api/deployments/non-existent/rollback")
          .set("x-api-key", apiKey)
          .set("x-user-id", testUserId)
          .expect(404);

        expect(response.body.success).toBe(false);
        expect(response.body.message).toContain("not found");
      });

      it("should return 400 for deployment in non-rollbackable state", async () => {
        const mockDeployment = {
          id: "deployment-123",
          status: "pending", // Cannot rollback pending deployment
          configuration: { userId: testUserId },
          startedAt: new Date(),
        };

        const mockPrisma = require("../lib/prisma");
        mockPrisma.deployment.findFirst.mockResolvedValue(mockDeployment);
        mockPrisma.default.deployment.findFirst.mockResolvedValue(mockDeployment);

        const response = await supertest(app)
          .post("/api/deployments/deployment-123/rollback")
          .set("x-api-key", apiKey)
          .set("x-user-id", testUserId)
          .expect(400);

        expect(response.body.success).toBe(false);
        expect(response.body.message).toContain("cannot be rolled back");
      });
    });

    describe("GET /api/deployments/history", () => {
      it("should get deployment history successfully", async () => {
        const mockDeployments = [
          {
            id: "deployment-2",
            status: "completed",
            startedAt: new Date("2023-01-02T10:00:00Z"),
            completedAt: new Date("2023-01-02T10:05:00Z"),
            configuration: {
              applicationName: "test-app-2",
              dockerImage: "redis:latest",
            },
          },
          {
            id: "deployment-1",
            status: "failed",
            startedAt: new Date("2023-01-01T10:00:00Z"),
            completedAt: new Date("2023-01-01T10:03:00Z"),
            configuration: {
              applicationName: "test-app-1",
              dockerImage: "nginx:latest",
            },
          },
        ];

        const mockPrisma = require("../lib/prisma");
        mockPrisma.deployment.findMany.mockResolvedValue(mockDeployments);
        mockPrisma.default.deployment.findMany.mockResolvedValue(mockDeployments);
        mockPrisma.deployment.count.mockResolvedValue(2);
        mockPrisma.default.deployment.count.mockResolvedValue(2);

        const response = await supertest(app)
          .get("/api/deployments/history")
          .set("x-api-key", apiKey)
          .set("x-user-id", testUserId)
          .expect(200);

        const body = response.body as DeploymentListResponse;
        expect(body.success).toBe(true);
        expect(body.data).toHaveLength(2);
        expect(body.data[0].applicationName).toBe("test-app-2");
        expect(body.pagination.totalCount).toBe(2);
      });

      it("should handle pagination correctly", async () => {
        const mockPrisma = require("../lib/prisma");
        mockPrisma.deployment.findMany.mockResolvedValue([]);
        mockPrisma.default.deployment.findMany.mockResolvedValue([]);
        mockPrisma.deployment.count.mockResolvedValue(0);
        mockPrisma.default.deployment.count.mockResolvedValue(0);

        await supertest(app)
          .get("/api/deployments/history")
          .query({ page: "2", limit: "10" })
          .set("x-api-key", apiKey)
          .set("x-user-id", testUserId)
          .expect(200);

        expect(mockPrisma.deployment.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            take: 10,
            skip: 10, // (page - 1) * limit
          })
        );
      });

      it("should return 400 for invalid query parameters", async () => {
        await supertest(app)
          .get("/api/deployments/history")
          .query({ page: "0", limit: "200" })
          .set("x-api-key", apiKey)
          .set("x-user-id", testUserId)
          .expect(400);
      });
    });
  });

  describe("Authentication and Authorization", () => {
    it("should require authentication for all routes", async () => {
      const routes = [
        { method: "get", path: "/api/deployments/configs" },
        { method: "post", path: "/api/deployments/configs" },
        { method: "get", path: "/api/deployments/configs/test-id" },
        { method: "put", path: "/api/deployments/configs/test-id" },
        { method: "delete", path: "/api/deployments/configs/test-id" },
        { method: "post", path: "/api/deployments/trigger" },
        { method: "get", path: "/api/deployments/test-id/status" },
        { method: "post", path: "/api/deployments/test-id/rollback" },
        { method: "get", path: "/api/deployments/history" },
      ];

      for (const route of routes) {
        const response = await supertest(app)[route.method](route.path);
        expect(response.status).toBe(401);
        expect(response.body.message).toContain("Authentication required");
      }
    });

    it("should work with session authentication", async () => {
      // Mock session-based authentication
      const sessionApp = express();
      sessionApp.use(express.json());
      sessionApp.use((req, res, next) => {
        req.session = { user: { id: testUserId } };
        next();
      });
      sessionApp.use("/api/deployments", deploymentRoutes);

      mockDeploymentConfigurationManager.listDeploymentConfigs.mockResolvedValue([]);

      await supertest(sessionApp)
        .get("/api/deployments/configs")
        .expect(200);
    });

  });

  describe("Error Handling", () => {
    it("should handle service errors gracefully", async () => {
      mockDeploymentConfigurationManager.listDeploymentConfigs.mockRejectedValue(
        new Error("Database connection failed")
      );

      const response = await supertest(app)
        .get("/api/deployments/configs")
        .set("x-api-key", apiKey)
        .set("x-user-id", testUserId)
        .expect(500);

      expect(response.body).toBeDefined();
    });

    it("should handle JSON parsing errors", async () => {
      const response = await supertest(app)
        .post("/api/deployments/configs")
        .set("x-api-key", apiKey)
        .set("x-user-id", testUserId)
        .set("Content-Type", "application/json")
        .send("invalid json")
        .expect(400);

      expect(response.body).toBeDefined();
    });

    it("should handle large payloads appropriately", async () => {
      const largePayload = {
        ...createValidDeploymentConfigRequest(),
        containerConfig: {
          ...createValidDeploymentConfigRequest().containerConfig,
          environment: Array.from({ length: 50 }, (_, i) => ({
            name: `VAR_${i}`,
            value: "x".repeat(50), // Smaller values to avoid 413
          })),
        },
      };

      // Should still work with reasonable large payloads
      mockDeploymentConfigurationManager.createDeploymentConfig.mockResolvedValue({
        id: "config-123",
        ...largePayload,
        isActive: true,
        environmentId: testEnvironmentId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const response = await supertest(app)
        .post("/api/deployments/configs")
        .set("x-api-key", apiKey)
        .set("x-user-id", testUserId)
        .send(largePayload)
        .expect(201);

      expect(response.body.success).toBe(true);
    });
  });
});