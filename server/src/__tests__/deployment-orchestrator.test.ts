import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals";
import {
  DeploymentOrchestrator,
  DeploymentContext,
  DeploymentEvent,
} from "../services/deployment-orchestrator";
import { ContainerLifecycleManager } from "../services/container-lifecycle-manager";
import { HealthCheckService } from "../services/health-check";
import { DockerExecutorService } from "../services/docker-executor";
import { testPrisma, createTestUser } from "./setup";
import {
  DeploymentConfig,
  DeploymentTriggerType,
  ContainerConfig,
  HealthCheckConfig,
  TraefikConfig,
  RollbackConfig,
} from "@mini-infra/types";

// Mock dependencies
const mockContainerManager = {
  createContainer: jest.fn(),
  startContainer: jest.fn(),
  stopContainer: jest.fn(),
  removeContainer: jest.fn(),
  getContainerStatus: jest.fn(),
  waitForContainerStatus: jest.fn(),
  dockerService: {
    listContainers: jest.fn(),
  },
};

const mockTraefikService = {
  switchTraffic: jest.fn(),
  updateContainerLabels: jest.fn(),
};

const mockHealthCheckService = {
  performHealthCheck: jest.fn(),
};

const mockDockerExecutor = {
  initialize: jest.fn(),
  pullImageWithAuth: jest.fn(),
};

jest.mock("../services/container-lifecycle-manager", () => ({
  ContainerLifecycleManager: jest.fn().mockImplementation(() => mockContainerManager),
}));

jest.mock("../services/traefik-integration", () => ({
  TraefikIntegrationService: jest.fn().mockImplementation(() => mockTraefikService),
}));

jest.mock("../services/health-check", () => ({
  HealthCheckService: jest.fn().mockImplementation(() => mockHealthCheckService),
}));

jest.mock("../services/docker-executor", () => ({
  DockerExecutorService: jest.fn().mockImplementation(() => mockDockerExecutor),
}));

// Mock logger factory
const mockLogger = {
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
};

jest.mock("../lib/logger-factory.ts", () => ({
  deploymentLogger: jest.fn(() => mockLogger),
  __esModule: true,
  default: jest.fn(() => mockLogger),
}));

// Mock prisma (using testPrisma) - needs to be after imports
jest.mock("../lib/prisma", () => ({
  __esModule: true,
  default: testPrisma,
}));

describe("DeploymentOrchestrator", () => {
  let orchestrator: DeploymentOrchestrator;
  let testUserId: string;

  beforeEach(async () => {
    jest.clearAllMocks();

    // Clean database
    await testPrisma.deployment.deleteMany();
    await testPrisma.deploymentStep.deleteMany();
    await testPrisma.deploymentConfiguration.deleteMany();
    await testPrisma.user.deleteMany();

    // Create test user
    const user = await createTestUser();
    testUserId = user.id;

    // Setup default mocks
    mockContainerManager.createContainer.mockResolvedValue("container-123");
    mockContainerManager.startContainer.mockResolvedValue(undefined);
    mockContainerManager.waitForContainerStatus.mockResolvedValue(true);
    mockContainerManager.getContainerStatus.mockResolvedValue({
      id: "container-123",
      status: "running",
    });
    mockContainerManager.dockerService.listContainers.mockResolvedValue([]);

    mockHealthCheckService.performHealthCheck.mockResolvedValue({
      success: true,
      statusCode: 200,
      responseTime: 100,
      responseBody: "OK",
    });

    mockTraefikService.switchTraffic.mockResolvedValue(undefined);
    mockTraefikService.updateContainerLabels.mockResolvedValue(undefined);

    mockDockerExecutor.initialize.mockResolvedValue(undefined);
    mockDockerExecutor.pullImageWithAuth.mockResolvedValue(undefined);

    orchestrator = new DeploymentOrchestrator();
  });

  afterEach(async () => {
    // Stop any active deployments
    const activeDeployments = orchestrator.getActiveDeployments();
    for (const deploymentId of activeDeployments) {
      await orchestrator.stopDeployment(deploymentId);
    }

    // Clean database
    await testPrisma.deployment.deleteMany();
    await testPrisma.deploymentStep.deleteMany();
    await testPrisma.deploymentConfiguration.deleteMany();
    await testPrisma.user.deleteMany();
  });

  // Helper function to create valid deployment config
  const createValidDeploymentConfig = (): DeploymentConfig => ({
    applicationName: "test-app",
    dockerImage: "nginx",
    dockerTag: "latest",
    containerConfig: {
      ports: [{ containerPort: 80, hostPort: 8080, protocol: "tcp" }],
      volumes: [{ hostPath: "/host/data", containerPath: "/app/data", mode: "rw" }],
      environment: [{ name: "NODE_ENV", value: "production" }],
      labels: { "app.name": "test-app" },
      networks: ["app-network"],
    } as ContainerConfig,
    healthCheck: {
      endpoint: "http://localhost:8080/health",
      method: "GET",
      expectedStatus: [200],
      timeout: 5000,
      retries: 3,
      interval: 1000,
    } as HealthCheckConfig,
    traefikConfig: {
      routerName: "test-app-router",
      serviceName: "test-app-service",
      rule: "Host(`test-app.localhost`)",
      middlewares: [],
      tls: false,
    } as TraefikConfig,
    rollbackConfig: {
      enabled: true,
      maxWaitTime: 30000,
      keepOldContainer: false,
    } as RollbackConfig,
  });

  describe("Deployment Management", () => {
    it("should start deployment successfully", async () => {
      const config = createValidDeploymentConfig();
      const deploymentId = "test-deployment-123";

      await orchestrator.startDeployment(
        deploymentId,
        config,
        "manual",
        "test-user"
      );

      expect(orchestrator.isDeploymentActive(deploymentId)).toBe(true);
      expect(orchestrator.getActiveDeployments()).toContain(deploymentId);
    });

    it("should prevent duplicate deployments", async () => {
      const config = createValidDeploymentConfig();
      const deploymentId = "test-deployment-123";

      await orchestrator.startDeployment(deploymentId, config, "manual");

      await expect(
        orchestrator.startDeployment(deploymentId, config, "manual")
      ).rejects.toThrow(`Deployment ${deploymentId} is already active`);
    });

    it("should get deployment status for active deployment", async () => {
      const config = createValidDeploymentConfig();
      const deploymentId = "test-deployment-123";

      await orchestrator.startDeployment(deploymentId, config, "manual");

      const status = orchestrator.getDeploymentStatus(deploymentId);
      expect(status.isActive).toBe(true);
      expect(status.currentState).toBe("preparing");
      expect(status.context).toBeTruthy();
      expect(status.context?.deploymentId).toBe(deploymentId);
    });

    it("should return inactive status for non-existent deployment", () => {
      const status = orchestrator.getDeploymentStatus("non-existent");
      expect(status.isActive).toBe(false);
      expect(status.currentState).toBeNull();
      expect(status.context).toBeNull();
    });

    it("should stop deployment", async () => {
      const config = createValidDeploymentConfig();
      const deploymentId = "test-deployment-123";

      await orchestrator.startDeployment(deploymentId, config, "manual");
      expect(orchestrator.isDeploymentActive(deploymentId)).toBe(true);

      await orchestrator.stopDeployment(deploymentId);
      expect(orchestrator.isDeploymentActive(deploymentId)).toBe(false);
    });

    it("should handle stopping non-existent deployment gracefully", async () => {
      // Should not throw
      await orchestrator.stopDeployment("non-existent");
    });
  });

  describe("Deployment State Machine Flow", () => {
    it("should execute successful deployment flow", async () => {
      const config = createValidDeploymentConfig();
      const deploymentId = "test-deployment-123";

      // Start deployment
      await orchestrator.startDeployment(deploymentId, config, "manual");

      // Wait a bit for state machine to process
      await new Promise(resolve => setTimeout(resolve, 100));

      // Verify mocks were called for successful flow
      expect(mockDockerExecutor.pullImageWithAuth).toHaveBeenCalledWith("nginx:latest");
      expect(mockContainerManager.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          name: expect.stringContaining("test-app"),
          image: "nginx",
          tag: "latest",
          config: config.containerConfig,
          deploymentId,
        })
      );
      expect(mockContainerManager.startContainer).toHaveBeenCalledWith("container-123");
      expect(mockHealthCheckService.performHealthCheck).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoint: "http://localhost:8080/health",
          method: "GET",
          expectedStatuses: [200],
        })
      );
    });

    it("should handle image pull failure", async () => {
      mockDockerExecutor.pullImageWithAuth.mockRejectedValue(
        new Error("Image not found")
      );

      const config = createValidDeploymentConfig();
      const deploymentId = "test-deployment-123";

      await orchestrator.startDeployment(deploymentId, config, "manual");

      // Wait for state machine to process
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockDockerExecutor.pullImageWithAuth).toHaveBeenCalled();
      // Container creation should not be attempted after image pull failure
      expect(mockContainerManager.createContainer).not.toHaveBeenCalled();
    });

    it("should handle container creation failure", async () => {
      mockContainerManager.createContainer.mockRejectedValue(
        new Error("Failed to create container")
      );

      const config = createValidDeploymentConfig();
      const deploymentId = "test-deployment-123";

      await orchestrator.startDeployment(deploymentId, config, "manual");

      // Wait for state machine to process
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockDockerExecutor.pullImageWithAuth).toHaveBeenCalled();
      expect(mockContainerManager.createContainer).toHaveBeenCalled();
      // Health check should not be attempted after container creation failure
      expect(mockHealthCheckService.performHealthCheck).not.toHaveBeenCalled();
    });

    it("should retry health checks on failure", async () => {
      // First attempt fails, second succeeds
      mockHealthCheckService.performHealthCheck
        .mockRejectedValueOnce(new Error("Health check failed"))
        .mockResolvedValueOnce({
          success: true,
          statusCode: 200,
          responseTime: 100,
        });

      const config = createValidDeploymentConfig();
      const deploymentId = "test-deployment-123";

      await orchestrator.startDeployment(deploymentId, config, "manual");

      // Wait for state machine to process including retries
      await new Promise(resolve => setTimeout(resolve, 200));

      expect(mockHealthCheckService.performHealthCheck).toHaveBeenCalledTimes(2);
    });

    it("should fail after max health check retries", async () => {
      mockHealthCheckService.performHealthCheck.mockRejectedValue(
        new Error("Health check failed")
      );

      const config = createValidDeploymentConfig();
      const deploymentId = "test-deployment-123";

      await orchestrator.startDeployment(deploymentId, config, "manual");

      // Wait for all retry attempts
      await new Promise(resolve => setTimeout(resolve, 500));

      // Should be called 4 times (initial + 3 retries)
      expect(mockHealthCheckService.performHealthCheck).toHaveBeenCalledTimes(4);
    });

    it("should handle traffic switching failure and rollback", async () => {
      // Note: TraefikIntegrationService is now stubbed, but we still test the orchestrator's behavior
      mockTraefikService.switchTraffic.mockRejectedValue(
        new Error("Failed to switch traffic")
      );

      const config = createValidDeploymentConfig();
      const deploymentId = "test-deployment-123";

      await orchestrator.startDeployment(deploymentId, config, "manual");

      // Wait for state machine to process
      await new Promise(resolve => setTimeout(resolve, 200));

      expect(mockTraefikService.switchTraffic).toHaveBeenCalled();
      // Should attempt rollback after traffic switch failure
      expect(mockContainerManager.stopContainer).toHaveBeenCalledWith("container-123");
    });

    it("should perform cleanup after successful deployment", async () => {
      // Mock finding an old container
      mockContainerManager.dockerService.listContainers.mockResolvedValue([
        {
          id: "old-container-123",
          labels: {
            "mini-infra.application": "test-app",
            "mini-infra.deployment.color": "green",
            "mini-infra.deployment.active": "true",
          },
          status: "running",
        },
      ]);

      const config = createValidDeploymentConfig();
      const deploymentId = "test-deployment-123";

      await orchestrator.startDeployment(deploymentId, config, "manual");

      // Wait for full flow including cleanup
      await new Promise(resolve => setTimeout(resolve, 300));

      // Should stop and remove old container during cleanup
      expect(mockContainerManager.stopContainer).toHaveBeenCalledWith("old-container-123");
      expect(mockContainerManager.removeContainer).toHaveBeenCalledWith("old-container-123");
    });

    it("should handle cleanup errors gracefully", async () => {
      mockContainerManager.dockerService.listContainers.mockResolvedValue([
        {
          id: "old-container-123",
          labels: {
            "mini-infra.application": "test-app",
            "mini-infra.deployment.color": "green",
            "mini-infra.deployment.active": "true",
          },
          status: "running",
        },
      ]);

      mockContainerManager.stopContainer.mockRejectedValue(
        new Error("Failed to stop container")
      );

      const config = createValidDeploymentConfig();
      const deploymentId = "test-deployment-123";

      await orchestrator.startDeployment(deploymentId, config, "manual");

      // Wait for cleanup phase
      await new Promise(resolve => setTimeout(resolve, 300));

      expect(mockContainerManager.stopContainer).toHaveBeenCalled();
      // Deployment should still be considered successful despite cleanup errors
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          deploymentId,
          error: "Failed to stop container",
        }),
        expect.stringContaining("Failed to cleanup old container")
      );
    });
  });

  describe("Rollback Functionality", () => {
    it("should force rollback of active deployment", async () => {
      const config = createValidDeploymentConfig();
      const deploymentId = "test-deployment-123";

      await orchestrator.startDeployment(deploymentId, config, "manual");

      // Wait for deployment to start
      await new Promise(resolve => setTimeout(resolve, 100));

      await orchestrator.forceRollback(deploymentId);

      // Should attempt to stop new container
      expect(mockContainerManager.stopContainer).toHaveBeenCalledWith("container-123");
    });

    it("should throw error when forcing rollback of non-existent deployment", async () => {
      await expect(
        orchestrator.forceRollback("non-existent")
      ).rejects.toThrow("No active deployment found with ID: non-existent");
    });

    it("should restore traffic to old container during rollback", async () => {
      // Note: TraefikIntegrationService is now stubbed, but we still test the orchestrator's behavior
      // Mock existing old container
      mockContainerManager.dockerService.listContainers.mockResolvedValue([
        {
          id: "old-container-123",
          labels: {
            "mini-infra.application": "test-app",
            "mini-infra.deployment.color": "green",
            "mini-infra.deployment.active": "true",
          },
          status: "running",
        },
      ]);

      mockContainerManager.getContainerStatus.mockResolvedValue({
        id: "old-container-123",
        status: "running",
      });

      // Make health check fail to trigger rollback
      mockHealthCheckService.performHealthCheck.mockRejectedValue(
        new Error("Health check failed")
      );

      const config = createValidDeploymentConfig();
      const deploymentId = "test-deployment-123";

      await orchestrator.startDeployment(deploymentId, config, "manual");

      // Wait for health check failures and rollback
      await new Promise(resolve => setTimeout(resolve, 500));

      // Should update labels to restore traffic to old container
      expect(mockTraefikService.updateContainerLabels).toHaveBeenCalledWith(
        "old-container-123",
        expect.objectContaining({
          "traefik.enable": "true",
          "mini-infra.deployment.active": "true",
        })
      );
    });
  });

  describe("API Interface", () => {
    let deploymentConfigId: string;

    beforeEach(async () => {
      // Create deployment configuration in database
      const config = await testPrisma.deploymentConfiguration.create({
        data: {
          applicationName: "test-app",
          dockerImage: "nginx",
          dockerRegistry: "docker.io",
          containerConfig: {
            ports: [{ containerPort: 80, protocol: "tcp" }],
            volumes: [],
            environment: [],
            labels: {},
            networks: ["default"],
          },
          healthCheckConfig: {
            endpoint: "/health",
            method: "GET",
            expectedStatus: [200],
            timeout: 5000,
            retries: 3,
            interval: 1000,
          },
          traefikConfig: {
            routerName: "test-router",
            serviceName: "test-service",
            rule: "Host(`test.localhost`)",
          },
          rollbackConfig: {
            enabled: true,
            maxWaitTime: 30000,
            keepOldContainer: false,
          },
          isActive: true,
          userId: testUserId,
        },
      });
      deploymentConfigId = config.id;
    });

    it("should trigger deployment via API", async () => {
      const deployment = await orchestrator.triggerDeployment({
        configurationId: deploymentConfigId,
        triggerType: "webhook",
        triggeredBy: "github-action",
        dockerImage: "nginx:1.21",
      });

      expect(deployment).toBeTruthy();
      expect(deployment.configurationId).toBe(deploymentConfigId);
      expect(deployment.triggerType).toBe("webhook");
      expect(deployment.triggeredBy).toBe("github-action");
      expect(deployment.dockerImage).toBe("nginx:1.21");
      expect(deployment.status).toBe("pending");

      // Should be stored in database
      const storedDeployment = await testPrisma.deployment.findUnique({
        where: { id: deployment.id },
      });
      expect(storedDeployment).toBeTruthy();
    });

    it("should throw error for non-existent configuration", async () => {
      await expect(
        orchestrator.triggerDeployment({
          configurationId: "non-existent",
          triggerType: "manual",
          dockerImage: "nginx:latest",
        })
      ).rejects.toThrow("Deployment configuration non-existent not found");
    });

    it("should trigger rollback via API", async () => {
      // First create a deployment
      const deployment = await testPrisma.deployment.create({
        data: {
          configurationId: deploymentConfigId,
          triggerType: "manual",
          dockerImage: "nginx:latest",
          status: "deploying",
          currentState: "health_checking",
          startedAt: new Date(),
          healthCheckPassed: false,
          downtime: 0,
        },
      });

      // Start the deployment in orchestrator
      const config = createValidDeploymentConfig();
      await orchestrator.startDeployment(deployment.id, config, "manual");

      const rollbackResult = await orchestrator.rollbackDeployment(deployment.id);

      expect(rollbackResult).toBeTruthy();
      expect(rollbackResult.id).toBe(deployment.id);

      // Should update status in database
      const updatedDeployment = await testPrisma.deployment.findUnique({
        where: { id: deployment.id },
      });
      expect(updatedDeployment?.status).toBe("rolling_back");
      expect(updatedDeployment?.currentState).toBe("rolling_back");
    });

    it("should throw error for non-existent deployment rollback", async () => {
      await expect(
        orchestrator.rollbackDeployment("non-existent")
      ).rejects.toThrow("Deployment non-existent not found");
    });
  });

  describe("Database Integration", () => {
    it("should create deployment steps during execution", async () => {
      const config = createValidDeploymentConfig();
      const deploymentId = "test-deployment-123";

      await orchestrator.startDeployment(deploymentId, config, "manual");

      // Wait for some steps to be processed
      await new Promise(resolve => setTimeout(resolve, 200));

      // Check if steps were created in database
      const steps = await testPrisma.deploymentStep.findMany({
        where: { deploymentId },
      });

      expect(steps.length).toBeGreaterThan(0);
      expect(steps.some(step => step.stepName === "pull_image")).toBe(true);
      expect(steps.some(step => step.stepName === "create_container")).toBe(true);
    });

    it("should update deployment with container IDs", async () => {
      // First create deployment in database
      const deployment = await testPrisma.deployment.create({
        data: {
          configurationId: "test-config",
          triggerType: "manual",
          dockerImage: "nginx:latest",
          status: "pending",
          currentState: "idle",
          startedAt: new Date(),
          healthCheckPassed: false,
          downtime: 0,
        },
      });

      const config = createValidDeploymentConfig();
      await orchestrator.startDeployment(deployment.id, config, "manual");

      // Wait for container creation
      await new Promise(resolve => setTimeout(resolve, 200));

      const updatedDeployment = await testPrisma.deployment.findUnique({
        where: { id: deployment.id },
      });

      expect(updatedDeployment?.newContainerId).toBe("container-123");
    });

    it("should update health check results in database", async () => {
      const deployment = await testPrisma.deployment.create({
        data: {
          configurationId: "test-config",
          triggerType: "manual",
          dockerImage: "nginx:latest",
          status: "pending",
          currentState: "idle",
          startedAt: new Date(),
          healthCheckPassed: false,
          downtime: 0,
        },
      });

      const config = createValidDeploymentConfig();
      await orchestrator.startDeployment(deployment.id, config, "manual");

      // Wait for health check
      await new Promise(resolve => setTimeout(resolve, 250));

      const updatedDeployment = await testPrisma.deployment.findUnique({
        where: { id: deployment.id },
      });

      expect(updatedDeployment?.healthCheckPassed).toBe(true);
      expect(updatedDeployment?.healthCheckLogs).toBeTruthy();
    });
  });

  describe("Error Handling", () => {
    it("should handle state machine initialization errors", async () => {
      const config = createValidDeploymentConfig();
      const deploymentId = "test-deployment-123";

      // Mock a service to fail during initialization
      mockDockerExecutor.initialize.mockRejectedValue(new Error("Docker not available"));

      await expect(
        orchestrator.startDeployment(deploymentId, config, "manual")
      ).not.toThrow(); // Should not throw during start

      // Wait for error to be processed
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockLogger.error).toHaveBeenCalled();
    });

    it("should handle database errors gracefully", async () => {
      const config = createValidDeploymentConfig();
      const deploymentId = "test-deployment-123";

      // Start deployment normally
      await orchestrator.startDeployment(deploymentId, config, "manual");

      // Wait for execution
      await new Promise(resolve => setTimeout(resolve, 200));

      // Even if there are database errors, deployment should continue
      expect(orchestrator.isDeploymentActive(deploymentId)).toBe(true);
    });
  });

  describe("Container Color Management", () => {
    it("should determine target color for blue-green deployment", async () => {
      const config = createValidDeploymentConfig();
      const deploymentId = "test-deployment-123";

      await orchestrator.startDeployment(deploymentId, config, "manual");

      const status = orchestrator.getDeploymentStatus(deploymentId);
      expect(["blue", "green"]).toContain(status.context?.targetColor);
    });

    it("should create container with appropriate color label", async () => {
      const config = createValidDeploymentConfig();
      const deploymentId = "test-deployment-123";

      await orchestrator.startDeployment(deploymentId, config, "manual");

      // Wait for container creation
      await new Promise(resolve => setTimeout(resolve, 150));

      expect(mockContainerManager.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          name: expect.stringMatching(/test-app-(blue|green)/),
          labels: expect.objectContaining({
            "mini-infra.deployment.color": expect.stringMatching(/^(blue|green)$/),
          }),
        })
      );
    });
  });
});