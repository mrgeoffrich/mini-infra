import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals";
import { testPrisma, createTestUser } from "./setup";
import { DeploymentConfigService } from "../services/deployment-config";
import {
  CreateDeploymentConfigRequest,
  UpdateDeploymentConfigRequest,
} from "@mini-infra/types";

// Mock logger factory
jest.mock("../lib/logger-factory.ts", () => ({
  servicesLogger: jest.fn(() => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  })),
  prismaLogger: jest.fn(() => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  })),
  appLogger: jest.fn(() => ({
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

describe("DeploymentConfigService", () => {
  let deploymentConfigService: DeploymentConfigService;
  let testEnvironmentId: string;

  beforeEach(async () => {
    // Clean up database
    await testPrisma.deployment.deleteMany();
    await testPrisma.deploymentStep.deleteMany();
    await testPrisma.deploymentConfiguration.deleteMany();
    await testPrisma.connectivityStatus.deleteMany();
    await testPrisma.environment.deleteMany();
    await testPrisma.user.deleteMany();

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

    // Create service instance
    deploymentConfigService = new DeploymentConfigService(testPrisma);
  });

  afterEach(async () => {
    // Clean up database
    await testPrisma.deployment.deleteMany();
    await testPrisma.deploymentStep.deleteMany();
    await testPrisma.deploymentConfiguration.deleteMany();
    await testPrisma.connectivityStatus.deleteMany();
    await testPrisma.environment.deleteMany();
    await testPrisma.user.deleteMany();
  });

  // Helper function to create valid deployment config request
  const createValidDeploymentConfig = (): CreateDeploymentConfigRequest => ({
    applicationName: "test-app",
    dockerImage: "nginx:latest",
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

  describe("Service Validation", () => {
    it("should validate service successfully", async () => {
      const result = await deploymentConfigService.validate();

      expect(result.isValid).toBe(true);
      expect(result.message).toContain("Deployment service connected successfully");
      expect(result.metadata).toHaveProperty("configurationsCount");
    });

    it("should return health status", async () => {
      await deploymentConfigService.validate(); // Create connectivity status

      const health = await deploymentConfigService.getHealthStatus();

      expect(health.service).toBe("deployments");
      expect(health.status).toBe("connected");
      expect(health.lastChecked).toBeInstanceOf(Date);
    });
  });

  describe("Create Deployment Configuration", () => {
    it("should create deployment configuration successfully", async () => {
      const request = createValidDeploymentConfig();

      const result = await deploymentConfigService.createDeploymentConfig(
        request
      );

      expect(result).toMatchObject({
        applicationName: request.applicationName,
        dockerImage: request.dockerImage,
        dockerRegistry: request.dockerRegistry,
        containerConfig: request.containerConfig,
        healthCheckConfig: request.healthCheckConfig,
        rollbackConfig: request.rollbackConfig,
        isActive: true,
        environmentId: testEnvironmentId,
      });
      expect(result.id).toBeTruthy();
      expect(result.createdAt).toBeTruthy();
      expect(result.updatedAt).toBeTruthy();
    });

    it("should prevent duplicate application names", async () => {
      const request = createValidDeploymentConfig();

      // Create first configuration
      await deploymentConfigService.createDeploymentConfig(request);

      // Try to create duplicate - should fail
      await expect(
        deploymentConfigService.createDeploymentConfig(request)
      ).rejects.toThrow(
        "Deployment configuration for application 'test-app' already exists"
      );
    });


    it("should validate required fields", async () => {
      const invalidRequest = {
        ...createValidDeploymentConfig(),
        applicationName: "",
      };

      await expect(
        deploymentConfigService.createDeploymentConfig(invalidRequest)
      ).rejects.toThrow("Validation failed");
    });

    it("should validate application name format", async () => {
      const invalidRequest = {
        ...createValidDeploymentConfig(),
        applicationName: "invalid app name!",
      };
      
      await expect(
        deploymentConfigService.createDeploymentConfig(invalidRequest)
      ).rejects.toThrow("Validation failed");
    });

    it("should validate port ranges", async () => {
      const invalidRequest = {
        ...createValidDeploymentConfig(),
        containerConfig: {
          ...createValidDeploymentConfig().containerConfig,
          ports: [
            {
              containerPort: 70000, // Invalid port
              hostPort: 8080,
              protocol: "tcp",
            },
          ],
        },
      };
      
      await expect(
        deploymentConfigService.createDeploymentConfig(invalidRequest)
      ).rejects.toThrow("Validation failed");
    });

    it("should validate health check configuration", async () => {
      const invalidRequest = {
        ...createValidDeploymentConfig(),
        healthCheckConfig: {
          ...createValidDeploymentConfig().healthCheckConfig,
          timeout: 500, // Too low
        },
      };
      
      await expect(
        deploymentConfigService.createDeploymentConfig(invalidRequest)
      ).rejects.toThrow("Validation failed");
    });
  });

  describe("Get Deployment Configuration", () => {
    let configId: string;
    
    beforeEach(async () => {
      const request = createValidDeploymentConfig();
      const config = await deploymentConfigService.createDeploymentConfig(
        request
      );
      configId = config.id;
    });

    it("should get deployment configuration by ID", async () => {
      const result = await deploymentConfigService.getDeploymentConfig(
        configId
      );
      
      expect(result).toBeTruthy();
      expect(result!.id).toBe(configId);
      expect(result!.applicationName).toBe("test-app");
    });

    it("should return null for non-existent configuration", async () => {
      const result = await deploymentConfigService.getDeploymentConfig(
        "non-existent-id"
      );
      
      expect(result).toBeNull();
    });


    it("should get deployment configuration by name", async () => {
      const result = await deploymentConfigService.getDeploymentConfigByName(
        "test-app"
      );
      
      expect(result).toBeTruthy();
      expect(result!.applicationName).toBe("test-app");
    });

    it("should use cache for repeated requests", async () => {
      // First request
      const result1 = await deploymentConfigService.getDeploymentConfig(
        configId
      );
      
      // Second request should use cache
      const result2 = await deploymentConfigService.getDeploymentConfig(
        configId
      );
      
      expect(result1).toEqual(result2);
    });
  });

  describe("Update Deployment Configuration", () => {
    let configId: string;
    
    beforeEach(async () => {
      const request = createValidDeploymentConfig();
      const config = await deploymentConfigService.createDeploymentConfig(
        request
      );
      configId = config.id;
    });

    it("should update deployment configuration successfully", async () => {
      const updateRequest: UpdateDeploymentConfigRequest = {
        dockerImage: "nginx:1.21",
        isActive: false,
      };
      
      const result = await deploymentConfigService.updateDeploymentConfig(
        configId,
        updateRequest
      );
      
      expect(result.dockerImage).toBe("nginx:1.21");
      expect(result.isActive).toBe(false);
      expect(result.applicationName).toBe("test-app"); // Unchanged
    });

    it("should prevent updating to duplicate application name", async () => {
      // Create second configuration
      const secondRequest = {
        ...createValidDeploymentConfig(),
        applicationName: "test-app-2",
      };
      await deploymentConfigService.createDeploymentConfig(
        secondRequest
      );
      
      // Try to update first config to use second config's name
      const updateRequest: UpdateDeploymentConfigRequest = {
        applicationName: "test-app-2",
      };
      
      await expect(
        deploymentConfigService.updateDeploymentConfig(
          configId,
          updateRequest
        )
      ).rejects.toThrow(
        "Deployment configuration for application 'test-app-2' already exists"
      );
    });


    it("should update container configuration", async () => {
      const updateRequest: UpdateDeploymentConfigRequest = {
        containerConfig: {
          ...createValidDeploymentConfig().containerConfig,
          ports: [
            {
              containerPort: 3000,
              hostPort: 3000,
              protocol: "tcp",
            },
          ],
        },
      };
      
      const result = await deploymentConfigService.updateDeploymentConfig(
        configId,
        updateRequest
      );
      
      expect(result.containerConfig.ports[0].containerPort).toBe(3000);
    });
  });

  describe("List Deployment Configurations", () => {
    beforeEach(async () => {
      // Create multiple configurations
      const configs = [];
      for (let i = 1; i <= 3; i++) {
        const request = {
          ...createValidDeploymentConfig(),
          applicationName: `test-app-${i}`,
          dockerImage: i === 2 ? "redis:latest" : "nginx:latest",
        };
        const config = await deploymentConfigService.createDeploymentConfig(request);
        configs.push(config);
      }
      
      // Make the third configuration inactive (test-app-3)
      await deploymentConfigService.updateDeploymentConfig(
        configs[2].id,
        { isActive: false }
      );
    });

    it("should list all deployment configurations", async () => {
      const result = await deploymentConfigService.listDeploymentConfigs();
      
      expect(result).toHaveLength(3);
      expect(result[0].applicationName).toBe("test-app-3"); // Most recent first
    });

    it("should filter by application name", async () => {
      const result = await deploymentConfigService.listDeploymentConfigs(
        { applicationName: "test-app-2" }
      );
      
      expect(result).toHaveLength(1);
      expect(result[0].applicationName).toBe("test-app-2");
    });

    it("should filter by docker image", async () => {
      const result = await deploymentConfigService.listDeploymentConfigs(
        { dockerImage: "redis" }
      );
      
      expect(result).toHaveLength(1);
      expect(result[0].dockerImage).toBe("redis:latest");
    });

    it("should filter by active status", async () => {
      const result = await deploymentConfigService.listDeploymentConfigs(
        { isActive: true }
      );
      
      expect(result).toHaveLength(2);
      expect(result.every(config => config.isActive)).toBe(true);
    });

    it("should sort by different fields", async () => {
      const result = await deploymentConfigService.listDeploymentConfigs(
        undefined,
        { field: "applicationName", order: "asc" }
      );
      
      expect(result[0].applicationName).toBe("test-app-1");
      expect(result[1].applicationName).toBe("test-app-2");
      expect(result[2].applicationName).toBe("test-app-3");
    });

    it("should support pagination", async () => {
      const result = await deploymentConfigService.listDeploymentConfigs(
        undefined,
        undefined,
        2, // limit
        1  // offset
      );
      
      expect(result).toHaveLength(2);
    });

    it("should use cache for repeated requests", async () => {
      // First request
      const result1 = await deploymentConfigService.listDeploymentConfigs();
      
      // Second request should use cache
      const result2 = await deploymentConfigService.listDeploymentConfigs();
      
      expect(result1).toEqual(result2);
    });
  });

  describe("Delete Deployment Configuration", () => {
    let configId: string;
    
    beforeEach(async () => {
      const request = createValidDeploymentConfig();
      const config = await deploymentConfigService.createDeploymentConfig(
        request
      );
      configId = config.id;
    });

    it("should delete deployment configuration successfully", async () => {
      await deploymentConfigService.deleteDeploymentConfig(configId);
      
      // Verify deletion
      const result = await deploymentConfigService.getDeploymentConfig(
        configId
      );
      expect(result).toBeNull();
    });


    it("should throw error for non-existent configuration", async () => {
      await expect(
        deploymentConfigService.deleteDeploymentConfig("non-existent-id")
      ).rejects.toThrow("Deployment configuration not found");
    });
  });

  describe("Configuration Activation", () => {
    let configId: string;
    
    beforeEach(async () => {
      const request = createValidDeploymentConfig();
      const config = await deploymentConfigService.createDeploymentConfig(
        request
      );
      configId = config.id;
    });

    it("should activate deployment configuration", async () => {
      // First deactivate
      await deploymentConfigService.setConfigurationActive(configId, false);
      
      // Then activate
      const result = await deploymentConfigService.setConfigurationActive(
        configId,
        true
      );
      
      expect(result.isActive).toBe(true);
    });

    it("should deactivate deployment configuration", async () => {
      const result = await deploymentConfigService.setConfigurationActive(
        configId,
        false
      );
      
      expect(result.isActive).toBe(false);
    });
  });

  describe("Validation", () => {
    it("should validate valid configuration", () => {
      const config = createValidDeploymentConfig();
      
      const result = deploymentConfigService.validateDeploymentConfiguration(config);
      
      expect(result.isValid).toBe(true);
      expect(result.message).toBe("Configuration is valid");
      expect(result.errors).toBeUndefined();
    });

    it("should validate invalid configuration", () => {
      const config = {
        ...createValidDeploymentConfig(),
        applicationName: "",
        dockerImage: "",
      };
      
      const result = deploymentConfigService.validateDeploymentConfiguration(config);
      
      expect(result.isValid).toBe(false);
      expect(result.message).toBe("Configuration has validation errors");
      expect(result.errors).toBeDefined();
      expect(result.errors!.some(e => e.field === "applicationName")).toBe(true);
      expect(result.errors!.some(e => e.field === "dockerImage")).toBe(true);
    });

    it("should validate with Zod schema", () => {
      const config = createValidDeploymentConfig();
      
      const result = deploymentConfigService.validateWithZod(config);
      
      expect(result.isValid).toBe(true);
      expect(result.errors).toBeUndefined();
    });

    it("should validate invalid data with Zod schema", () => {
      const config = {
        ...createValidDeploymentConfig(),
        applicationName: "invalid name!",
      };
      
      const result = deploymentConfigService.validateWithZod(config);
      
      expect(result.isValid).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors!.some(error => 
        error.includes("Application name can only contain")
      )).toBe(true);
    });

    it("should validate update requests with Zod schema", () => {
      const updateRequest: UpdateDeploymentConfigRequest = {
        dockerImage: "nginx:1.21",
        isActive: false,
      };
      
      const result = deploymentConfigService.validateUpdateWithZod(updateRequest);
      
      expect(result.isValid).toBe(true);
      expect(result.errors).toBeUndefined();
    });
  });
});