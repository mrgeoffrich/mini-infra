import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals";
import {
  ContainerLifecycleManager,
  ContainerCreateOptions,
} from "../services/container-lifecycle-manager";
import DockerService from "../services/docker";
import {
  ContainerConfig,
  TraefikConfig,
  DeploymentPort,
  DeploymentVolume,
  ContainerEnvVar,
} from "@mini-infra/types";

// Mock DockerService
const mockDockerService = {
  getInstance: jest.fn(),
  isConnected: jest.fn(),
  docker: {
    createContainer: jest.fn(),
    getContainer: jest.fn(),
    listContainers: jest.fn(),
  },
};

// Mock the container object
const mockContainer = {
  id: "mock-container-id",
  start: jest.fn(),
  stop: jest.fn(),
  remove: jest.fn(),
  inspect: jest.fn(),
};

// Mock ContainerLabelManager
const mockLabelManager = {
  generateDeploymentLabels: jest.fn(),
  parseContainerLabels: jest.fn(),
  shouldCleanupContainer: jest.fn(),
};

jest.mock('../services/container-label-manager', () => ({
  __esModule: true,
  default: jest.fn(() => mockLabelManager),
}));

jest.mock("../services/docker", () => ({
  __esModule: true,
  default: {
    getInstance: () => mockDockerService,
  },
}));

// Mock logger factory
jest.mock("../lib/logger-factory", () => {
  const mockLoggerInstance = {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  };

  return {
    servicesLogger: jest.fn(() => mockLoggerInstance),
    prismaLogger: jest.fn(() => mockLoggerInstance),
    appLogger: jest.fn(() => mockLoggerInstance),
    httpLogger: jest.fn(() => mockLoggerInstance),
    __esModule: true,
    default: jest.fn(() => mockLoggerInstance),
  };
});

// Mock prisma module
jest.mock("../lib/prisma", () => {
  const mockPrisma = {
    deployment: {
      create: jest.fn(),
      update: jest.fn(),
      findUnique: jest.fn(),
    },
  };
  return {
    __esModule: true,
    default: mockPrisma,
  };
});

describe("ContainerLifecycleManager", () => {
  let containerManager: ContainerLifecycleManager;

  beforeEach(() => {
    jest.clearAllMocks();

    // Setup default mocks
    mockDockerService.getInstance.mockReturnValue(mockDockerService);
    mockDockerService.isConnected.mockReturnValue(true);
    mockDockerService.docker.createContainer.mockResolvedValue(mockContainer);
    mockDockerService.docker.getContainer.mockReturnValue(mockContainer);
    mockDockerService.docker.listContainers.mockResolvedValue([]);

    // Setup label manager mock
    mockLabelManager.generateDeploymentLabels.mockReturnValue({
      "mini-infra.managed": "true",
      "mini-infra.deployment.id": "deploy-123",
      "app.name": "test-app",
      "app.version": "1.0.0",
      "mini-infra.created": new Date().toISOString(),
      "mini-infra.version": "1.0",
      "com.docker.compose.service": "test-container",
      "mini-infra.application": "test",
      "mini-infra.is-active": "true",
      "mini-infra.purpose": "deployment",
      "mini-infra.service": "test-container"
    });

    mockLabelManager.parseContainerLabels.mockReturnValue({
      isMiniInfraManaged: false,
      containerPurpose: undefined,
      isTemporary: false,
      deploymentId: undefined,
      traefikEnabled: false
    });

    mockLabelManager.shouldCleanupContainer.mockReturnValue({
      shouldCleanup: false
    });

    containerManager = new ContainerLifecycleManager();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // Helper function to create valid container config
  const createValidContainerConfig = (): ContainerConfig => ({
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
      {
        name: "PORT",
        value: "80",
      },
    ],
    labels: {
      "app.name": "test-app",
      "app.version": "1.0.0",
    },
    networks: ["app-network"],
  });

  // Helper function to create valid Traefik config
  const createValidTraefikConfig = (): TraefikConfig => ({
    routerName: "test-app-router",
    serviceName: "test-app-service",
    rule: "Host(`test-app.localhost`)",
    middlewares: ["auth-middleware"],
    tls: false,
  });

  describe("Container Creation", () => {
    it("should create container with basic configuration", async () => {
      const options: ContainerCreateOptions = {
        name: "test-container",
        image: "nginx",
        tag: "latest",
        config: createValidContainerConfig(),
        deploymentId: "deploy-123",
      };

      const containerId = await containerManager.createContainer(options);

      expect(containerId).toBe("mock-container-id");
      expect(mockDockerService.docker.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          Image: "nginx:latest",
          name: "test-container",
          Labels: expect.objectContaining({
            "mini-infra.managed": "true",
            "mini-infra.deployment.id": "deploy-123",
            "app.name": "test-app",
            "app.version": "1.0.0",
          }),
          Env: ["NODE_ENV=production", "PORT=80"],
          ExposedPorts: {
            "80/tcp": {},
          },
          HostConfig: expect.objectContaining({
            PortBindings: {
              "80/tcp": [{ HostPort: "8080" }],
            },
            Binds: ["/host/data:/app/data:rw"],
            NetworkMode: "app-network",
            RestartPolicy: { Name: "unless-stopped" },
          }),
        })
      );
    });




    it("should create container with multiple ports", async () => {
      const config = {
        ...createValidContainerConfig(),
        ports: [
          { containerPort: 80, hostPort: 8080, protocol: "tcp" as const },
          { containerPort: 443, hostPort: 8443, protocol: "tcp" as const },
          { containerPort: 9090, protocol: "udp" as const }, // No host port
        ],
      };

      const options: ContainerCreateOptions = {
        name: "test-container",
        image: "nginx",
        config,
      };

      await containerManager.createContainer(options);

      expect(mockDockerService.docker.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          ExposedPorts: {
            "80/tcp": {},
            "443/tcp": {},
            "9090/udp": {},
          },
          HostConfig: expect.objectContaining({
            PortBindings: {
              "80/tcp": [{ HostPort: "8080" }],
              "443/tcp": [{ HostPort: "8443" }],
              "9090/udp": [{}], // Random port assignment
            },
          }),
        })
      );
    });

    it("should create container with multiple volumes", async () => {
      const config = {
        ...createValidContainerConfig(),
        volumes: [
          { hostPath: "/host/data", containerPath: "/app/data", mode: "rw" as const },
          { hostPath: "/host/config", containerPath: "/app/config", mode: "ro" as const },
          { hostPath: "/host/logs", containerPath: "/app/logs" }, // No mode specified
        ],
      };

      const options: ContainerCreateOptions = {
        name: "test-container",
        image: "nginx",
        config,
      };

      await containerManager.createContainer(options);

      expect(mockDockerService.docker.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          HostConfig: expect.objectContaining({
            Binds: [
              "/host/data:/app/data:rw",
              "/host/config:/app/config:ro",
              "/host/logs:/app/logs:rw",
            ],
          }),
        })
      );
    });

    it("should create container with network configuration", async () => {
      const config = {
        ...createValidContainerConfig(),
        networks: ["network-1", "network-2"],
      };

      const options: ContainerCreateOptions = {
        name: "test-container",
        image: "nginx",
        config,
      };

      await containerManager.createContainer(options);

      expect(mockDockerService.docker.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          HostConfig: expect.objectContaining({
            NetworkMode: "network-1", // First network becomes network mode
          }),
          NetworkingConfig: {
            EndpointsConfig: {
              "network-1": {},
              "network-2": {},
            },
          },
        })
      );
    });

    it("should default to latest tag if not specified", async () => {
      const options: ContainerCreateOptions = {
        name: "test-container",
        image: "nginx",
        // No tag specified
        config: createValidContainerConfig(),
      };

      await containerManager.createContainer(options);

      expect(mockDockerService.docker.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          Image: "nginx:latest",
        })
      );
    });

    it("should throw error when Docker service is not connected", async () => {
      mockDockerService.isConnected.mockReturnValue(false);

      const options: ContainerCreateOptions = {
        name: "test-container",
        image: "nginx",
        config: createValidContainerConfig(),
      };

      await expect(containerManager.createContainer(options)).rejects.toThrow(
        "Docker service is not connected"
      );
    });

    it("should handle Docker create container errors", async () => {
      const error = new Error("Failed to create container");
      mockDockerService.docker.createContainer.mockRejectedValue(error);

      const options: ContainerCreateOptions = {
        name: "test-container",
        image: "nginx",
        config: createValidContainerConfig(),
      };

      await expect(containerManager.createContainer(options)).rejects.toThrow(
        "Failed to create container"
      );
    });
  });

  describe("Container Lifecycle Operations", () => {
    const containerId = "test-container-id";

    describe("Start Container", () => {
      it("should start container successfully", async () => {
        mockContainer.start.mockResolvedValue(undefined);

        await containerManager.startContainer(containerId);

        expect(mockDockerService.docker.getContainer).toHaveBeenCalledWith(containerId);
        expect(mockContainer.start).toHaveBeenCalled();
      });

      it("should handle start container errors", async () => {
        const error = new Error("Failed to start");
        mockContainer.start.mockRejectedValue(error);

        await expect(containerManager.startContainer(containerId)).rejects.toThrow(
          "Failed to start"
        );
      });

      it("should throw error when Docker service is not connected", async () => {
        mockDockerService.isConnected.mockReturnValue(false);

        await expect(containerManager.startContainer(containerId)).rejects.toThrow(
          "Docker service is not connected"
        );
      });
    });

    describe("Stop Container", () => {
      it("should stop container successfully", async () => {
        mockContainer.stop.mockResolvedValue(undefined);

        await containerManager.stopContainer(containerId, 30);

        expect(mockContainer.stop).toHaveBeenCalledWith({ t: 30 });
      });

      it("should ignore 304 status code (already stopped)", async () => {
        const error: any = new Error("Container already stopped");
        error.statusCode = 304;
        mockContainer.stop.mockRejectedValue(error);

        // Should not throw
        await containerManager.stopContainer(containerId);

        expect(mockContainer.stop).toHaveBeenCalled();
      });

      it("should handle other stop errors", async () => {
        const error: any = new Error("Failed to stop");
        error.statusCode = 500;
        mockContainer.stop.mockRejectedValue(error);

        await expect(containerManager.stopContainer(containerId)).rejects.toThrow(
          "Failed to stop"
        );
      });

      it("should use default timeout if not specified", async () => {
        mockContainer.stop.mockResolvedValue(undefined);

        await containerManager.stopContainer(containerId);

        expect(mockContainer.stop).toHaveBeenCalledWith({ t: 30 });
      });
    });

    describe("Remove Container", () => {
      it("should remove container successfully", async () => {
        mockContainer.remove.mockResolvedValue(undefined);

        await containerManager.removeContainer(containerId, false);

        expect(mockContainer.remove).toHaveBeenCalledWith({
          force: false,
          v: true, // Remove volumes
        });
      });

      it("should remove container with force", async () => {
        mockContainer.remove.mockResolvedValue(undefined);

        await containerManager.removeContainer(containerId, true);

        expect(mockContainer.remove).toHaveBeenCalledWith({
          force: true,
          v: true,
        });
      });

      it("should handle remove container errors", async () => {
        const error = new Error("Failed to remove");
        mockContainer.remove.mockRejectedValue(error);

        await expect(containerManager.removeContainer(containerId)).rejects.toThrow(
          "Failed to remove"
        );
      });
    });

    describe("Restart Container", () => {
      it("should restart container successfully", async () => {
        mockContainer.stop.mockResolvedValue(undefined);
        mockContainer.start.mockResolvedValue(undefined);

        await containerManager.restartContainer(containerId, 30);

        expect(mockContainer.stop).toHaveBeenCalledWith({ t: 30 });
        expect(mockContainer.start).toHaveBeenCalled();
      });

      it("should handle restart errors", async () => {
        mockContainer.stop.mockRejectedValue(new Error("Failed to stop"));

        await expect(containerManager.restartContainer(containerId)).rejects.toThrow(
          "Failed to stop"
        );
      });
    });
  });

  describe("Container Status and Monitoring", () => {
    const containerId = "test-container-id";

    describe("Get Container Status", () => {
      it("should return container status successfully", async () => {
        const mockInspectData = {
          Id: containerId,
          Name: "/test-container",
          State: {
            Status: "running",
            Health: { Status: "healthy" },
            StartedAt: "2023-01-01T10:00:00.000Z",
            FinishedAt: "0001-01-01T00:00:00Z",
            ExitCode: 0,
            Error: "",
          },
          Created: "2023-01-01T09:00:00.000Z",
        };

        mockContainer.inspect.mockResolvedValue(mockInspectData);

        const status = await containerManager.getContainerStatus(containerId);

        expect(status).toEqual({
          id: containerId,
          name: "test-container",
          status: "running",
          health: "healthy",
          created: new Date("2023-01-01T09:00:00.000Z"),
          started: new Date("2023-01-01T10:00:00.000Z"),
          finished: new Date("0001-01-01T00:00:00Z"),
          exitCode: 0,
          error: undefined, // Empty string becomes undefined
        });
      });

      it("should return null for non-existent container", async () => {
        const error: any = new Error("Container not found");
        error.statusCode = 404;
        mockContainer.inspect.mockRejectedValue(error);

        const status = await containerManager.getContainerStatus(containerId);

        expect(status).toBeNull();
      });

      it("should handle other inspect errors", async () => {
        const error = new Error("Docker daemon error");
        mockContainer.inspect.mockRejectedValue(error);

        await expect(
          containerManager.getContainerStatus(containerId)
        ).rejects.toThrow("Docker daemon error");
      });

      it("should handle container without health status", async () => {
        const mockInspectData = {
          Id: containerId,
          Name: "/test-container",
          State: {
            Status: "running",
            StartedAt: "2023-01-01T10:00:00.000Z",
            ExitCode: 0,
          },
          Created: "2023-01-01T09:00:00.000Z",
        };

        mockContainer.inspect.mockResolvedValue(mockInspectData);

        const status = await containerManager.getContainerStatus(containerId);

        expect(status?.health).toBeUndefined();
      });
    });

    describe("Check Container Running", () => {
      it("should return true for running container", async () => {
        const mockInspectData = {
          Id: containerId,
          Name: "/test-container",
          State: { Status: "running" },
          Created: "2023-01-01T09:00:00.000Z",
        };

        mockContainer.inspect.mockResolvedValue(mockInspectData);

        const isRunning = await containerManager.isContainerRunning(containerId);

        expect(isRunning).toBe(true);
      });

      it("should return false for stopped container", async () => {
        const mockInspectData = {
          Id: containerId,
          Name: "/test-container",
          State: { Status: "exited" },
          Created: "2023-01-01T09:00:00.000Z",
        };

        mockContainer.inspect.mockResolvedValue(mockInspectData);

        const isRunning = await containerManager.isContainerRunning(containerId);

        expect(isRunning).toBe(false);
      });

      it("should return false for non-existent container", async () => {
        const error: any = new Error("Container not found");
        error.statusCode = 404;
        mockContainer.inspect.mockRejectedValue(error);

        const isRunning = await containerManager.isContainerRunning(containerId);

        expect(isRunning).toBe(false);
      });

      it("should return false on error", async () => {
        mockContainer.inspect.mockRejectedValue(new Error("Docker error"));

        const isRunning = await containerManager.isContainerRunning(containerId);

        expect(isRunning).toBe(false);
      });
    });

    describe("Wait for Container Status", () => {
      it("should return true when target status is reached", async () => {
        const mockInspectData = {
          Id: containerId,
          Name: "/test-container",
          State: { Status: "running" },
          Created: "2023-01-01T09:00:00.000Z",
        };

        mockContainer.inspect.mockResolvedValue(mockInspectData);

        const result = await containerManager.waitForContainerStatus(
          containerId,
          "running",
          5000,
          100
        );

        expect(result).toBe(true);
      });

      it("should return false when container exits while waiting for running", async () => {
        const mockInspectData = {
          Id: containerId,
          Name: "/test-container",
          State: { Status: "exited", ExitCode: 1, Error: "Container failed" },
          Created: "2023-01-01T09:00:00.000Z",
        };

        mockContainer.inspect.mockResolvedValue(mockInspectData);

        const result = await containerManager.waitForContainerStatus(
          containerId,
          "running",
          5000,
          100
        );

        expect(result).toBe(false);
      });

      it("should return false when container no longer exists", async () => {
        mockContainer.inspect.mockResolvedValue(null);

        const result = await containerManager.waitForContainerStatus(
          containerId,
          "running",
          5000,
          100
        );

        expect(result).toBe(false);
      });

      it("should timeout if status is never reached", async () => {
        const mockInspectData = {
          Id: containerId,
          Name: "/test-container",
          State: { Status: "created" }, // Never reaches "running"
          Created: "2023-01-01T09:00:00.000Z",
        };

        mockContainer.inspect.mockResolvedValue(mockInspectData);

        const startTime = Date.now();
        const result = await containerManager.waitForContainerStatus(
          containerId,
          "running",
          500, // Short timeout for test
          100
        );

        expect(result).toBe(false);
      });

      it("should return false on error during status check", async () => {
        mockContainer.inspect.mockRejectedValue(new Error("Docker error"));

        const result = await containerManager.waitForContainerStatus(
          containerId,
          "running",
          1000,
          100
        );

        expect(result).toBe(false);
      });
    });
  });

  describe("Container Cleanup", () => {
    describe("Find Orphaned Containers", () => {
      it("should find exited deployment containers older than max age", async () => {
        const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000); // 25 hours ago
        const mockContainers = [
          {
            Id: "container-1",
            Names: ["/deployment-app1-blue"],
            State: "exited",
            Created: Math.floor(oldDate.getTime() / 1000),
            Labels: {
              "mini-infra.deployment.id": "deploy-123",
              "mini-infra.managed": "true",
              "mini-infra.purpose": "deployment"
            },
          },
          {
            Id: "container-2",
            Names: ["/normal-container"],
            State: "running",
            Created: Math.floor(Date.now() / 1000),
            Labels: {},
          },
        ];

        mockDockerService.docker.listContainers.mockResolvedValue(mockContainers);

        // Mock parseContainerLabels to return managed=true for container-1
        mockLabelManager.parseContainerLabels.mockImplementation((labels) => {
          if (labels["mini-infra.managed"] === "true") {
            return {
              isMiniInfraManaged: true,
              containerPurpose: "deployment",
              isTemporary: false,
              deploymentId: "deploy-123",
              traefikEnabled: false
            };
          }
          return {
            isMiniInfraManaged: false,
            containerPurpose: undefined,
            isTemporary: false,
            deploymentId: undefined,
            traefikEnabled: false
          };
        });

        const orphaned = await containerManager.findOrphanedContainers(24);

        expect(orphaned).toHaveLength(1);
        expect(orphaned[0]).toEqual({
          id: "container-1",
          name: "deployment-app1-blue",
          created: new Date(Math.floor(oldDate.getTime() / 1000) * 1000), // Match Docker's second precision
          labels: {
            "mini-infra.deployment.id": "deploy-123",
            "mini-infra.managed": "true",
            "mini-infra.purpose": "deployment"
          },
          reason: "Container exited and is older than maximum age",
        });
      });

      it("should find created containers that never started", async () => {
        const oldDate = new Date(Date.now() - 31 * 60 * 1000); // 31 minutes ago
        const mockContainers = [
          {
            Id: "container-1",
            Names: ["/deployment-app1-green"],
            State: "created",
            Created: Math.floor(oldDate.getTime() / 1000),
            Labels: {
              "mini-infra.application": "test-app",
              "mini-infra.managed": "true",
              "mini-infra.purpose": "deployment"
            },
          },
        ];

        mockDockerService.docker.listContainers.mockResolvedValue(mockContainers);

        // Mock parseContainerLabels to return managed=true for container-1
        mockLabelManager.parseContainerLabels.mockReturnValue({
          isMiniInfraManaged: true,
          containerPurpose: "deployment",
          isTemporary: false,
          deploymentId: undefined,
          traefikEnabled: false
        });

        const orphaned = await containerManager.findOrphanedContainers(24);

        expect(orphaned).toHaveLength(1);
        expect(orphaned[0].reason).toBe(
          "Container created but never started (older than 30 minutes)"
        );
      });

      it("should find containers marked for cleanup", async () => {
        const mockContainers = [
          {
            Id: "container-1",
            Names: ["/deployment-app1"],
            State: "running",
            Created: Math.floor(Date.now() / 1000),
            Labels: {
              "mini-infra.cleanup": "true",
              "mini-infra.managed": "true",
              "mini-infra.purpose": "deployment"
            },
          },
        ];

        mockDockerService.docker.listContainers.mockResolvedValue(mockContainers);

        // Mock parseContainerLabels and shouldCleanupContainer
        mockLabelManager.parseContainerLabels.mockReturnValue({
          isMiniInfraManaged: true,
          containerPurpose: "deployment",
          isTemporary: false,
          deploymentId: undefined,
          traefikEnabled: false
        });

        mockLabelManager.shouldCleanupContainer.mockReturnValue({
          shouldCleanup: true,
          reason: "Container marked for cleanup"
        });

        const orphaned = await containerManager.findOrphanedContainers(24);

        expect(orphaned).toHaveLength(1);
        expect(orphaned[0].reason).toBe("Container marked for cleanup");
      });

      it("should ignore non-deployment containers", async () => {
        const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000);
        const mockContainers = [
          {
            Id: "container-1",
            Names: ["/postgres-db"],
            State: "exited",
            Created: Math.floor(oldDate.getTime() / 1000),
            Labels: {},
          },
          {
            Id: "container-2",
            Names: ["/redis-cache"],
            State: "exited",
            Created: Math.floor(oldDate.getTime() / 1000),
            Labels: {},
          },
        ];

        mockDockerService.docker.listContainers.mockResolvedValue(mockContainers);

        const orphaned = await containerManager.findOrphanedContainers(24);

        expect(orphaned).toHaveLength(0);
      });

      it("should handle containers without names gracefully", async () => {
        const mockContainers = [
          {
            Id: "container-1",
            Names: [], // No names
            State: "exited",
            Created: Math.floor((Date.now() - 25 * 60 * 60 * 1000) / 1000),
            Labels: {
              "mini-infra.deployment.id": "deploy-123",
              "mini-infra.managed": "true",
              "mini-infra.purpose": "deployment"
            },
          },
        ];

        mockDockerService.docker.listContainers.mockResolvedValue(mockContainers);

        // Mock parseContainerLabels to return managed=true
        mockLabelManager.parseContainerLabels.mockReturnValue({
          isMiniInfraManaged: true,
          containerPurpose: "deployment",
          isTemporary: false,
          deploymentId: "deploy-123",
          traefikEnabled: false
        });

        const orphaned = await containerManager.findOrphanedContainers(24);

        expect(orphaned).toHaveLength(1);
        expect(orphaned[0].name).toBe("unknown");
      });
    });

    describe("Cleanup Orphaned Containers", () => {
      it("should cleanup orphaned containers successfully", async () => {
        const mockContainers = [
          {
            Id: "container-1",
            Names: ["/deployment-app1-blue"],
            State: "exited",
            Created: Math.floor((Date.now() - 25 * 60 * 60 * 1000) / 1000),
            Labels: {
              "mini-infra.deployment.id": "deploy-123",
              "mini-infra.managed": "true",
              "mini-infra.purpose": "deployment"
            },
          },
        ];

        mockDockerService.docker.listContainers.mockResolvedValue(mockContainers);
        mockContainer.stop.mockResolvedValue(undefined);
        mockContainer.remove.mockResolvedValue(undefined);

        // Mock parseContainerLabels to return managed=true
        mockLabelManager.parseContainerLabels.mockReturnValue({
          isMiniInfraManaged: true,
          containerPurpose: "deployment",
          isTemporary: false,
          deploymentId: "deploy-123",
          traefikEnabled: false
        });

        const cleaned = await containerManager.cleanupOrphanedContainers(24, false);

        expect(cleaned).toBe(1);
        expect(mockContainer.remove).toHaveBeenCalledWith({
          force: true,
          v: true,
        });
      });

      it("should return count for dry run without actual cleanup", async () => {
        const mockContainers = [
          {
            Id: "container-1",
            Names: ["/deployment-app1-blue"],
            State: "exited",
            Created: Math.floor((Date.now() - 25 * 60 * 60 * 1000) / 1000),
            Labels: {
              "mini-infra.deployment.id": "deploy-123",
              "mini-infra.managed": "true",
              "mini-infra.purpose": "deployment"
            },
          },
          {
            Id: "container-2",
            Names: ["/deployment-app2-green"],
            State: "exited",
            Created: Math.floor((Date.now() - 25 * 60 * 60 * 1000) / 1000),
            Labels: {
              "mini-infra.deployment.id": "deploy-456",
              "mini-infra.managed": "true",
              "mini-infra.purpose": "deployment"
            },
          },
        ];

        mockDockerService.docker.listContainers.mockResolvedValue(mockContainers);

        // Mock parseContainerLabels to return managed=true for both
        mockLabelManager.parseContainerLabels.mockReturnValue({
          isMiniInfraManaged: true,
          containerPurpose: "deployment",
          isTemporary: false,
          deploymentId: "deploy-123",
          traefikEnabled: false
        });

        const cleaned = await containerManager.cleanupOrphanedContainers(24, true);

        expect(cleaned).toBe(2);
        expect(mockContainer.stop).not.toHaveBeenCalled();
        expect(mockContainer.remove).not.toHaveBeenCalled();
      });

      it("should handle cleanup errors gracefully", async () => {
        const mockContainers = [
          {
            Id: "container-1",
            Names: ["/deployment-app1-blue"],
            State: "exited",
            Created: Math.floor((Date.now() - 25 * 60 * 60 * 1000) / 1000),
            Labels: {
              "mini-infra.deployment.id": "deploy-123",
              "mini-infra.managed": "true",
              "mini-infra.purpose": "deployment"
            },
          },
          {
            Id: "container-2",
            Names: ["/deployment-app2-green"],
            State: "exited",
            Created: Math.floor((Date.now() - 25 * 60 * 60 * 1000) / 1000),
            Labels: {
              "mini-infra.deployment.id": "deploy-456",
              "mini-infra.managed": "true",
              "mini-infra.purpose": "deployment"
            },
          },
        ];

        mockDockerService.docker.listContainers.mockResolvedValue(mockContainers);
        mockContainer.stop.mockResolvedValue(undefined);
        mockContainer.remove
          .mockResolvedValueOnce(undefined) // First succeeds
          .mockRejectedValueOnce(new Error("Failed to remove")); // Second fails

        // Mock parseContainerLabels to return managed=true for both
        mockLabelManager.parseContainerLabels.mockReturnValue({
          isMiniInfraManaged: true,
          containerPurpose: "deployment",
          isTemporary: false,
          deploymentId: "deploy-123",
          traefikEnabled: false
        });

        const cleaned = await containerManager.cleanupOrphanedContainers(24, false);

        expect(cleaned).toBe(1); // Only one succeeded
      });

      it("should return 0 when no orphaned containers found", async () => {
        mockDockerService.docker.listContainers.mockResolvedValue([]);

        const cleaned = await containerManager.cleanupOrphanedContainers(24, false);

        expect(cleaned).toBe(0);
        expect(mockContainer.stop).not.toHaveBeenCalled();
        expect(mockContainer.remove).not.toHaveBeenCalled();
      });

      it("should ignore stop errors during cleanup", async () => {
        const mockContainers = [
          {
            Id: "container-1",
            Names: ["/deployment-app1-blue"],
            State: "exited",
            Created: Math.floor((Date.now() - 25 * 60 * 60 * 1000) / 1000),
            Labels: {
              "mini-infra.deployment.id": "deploy-123",
              "mini-infra.managed": "true",
              "mini-infra.purpose": "deployment"
            },
          },
        ];

        mockDockerService.docker.listContainers.mockResolvedValue(mockContainers);
        mockContainer.stop.mockRejectedValue(new Error("Already stopped"));
        mockContainer.remove.mockResolvedValue(undefined);

        // Mock parseContainerLabels to return managed=true
        mockLabelManager.parseContainerLabels.mockReturnValue({
          isMiniInfraManaged: true,
          containerPurpose: "deployment",
          isTemporary: false,
          deploymentId: "deploy-123",
          traefikEnabled: false
        });

        const cleaned = await containerManager.cleanupOrphanedContainers(24, false);

        expect(cleaned).toBe(1); // Should still succeed despite stop error
        expect(mockContainer.remove).toHaveBeenCalled();
      });
    });
  });

  describe("Error Handling", () => {
    it("should handle Docker connection errors", async () => {
      mockDockerService.isConnected.mockReturnValue(false);

      const options: ContainerCreateOptions = {
        name: "test-container",
        image: "nginx",
        config: createValidContainerConfig(),
      };

      await expect(containerManager.createContainer(options)).rejects.toThrow(
        "Docker service is not connected"
      );

      await expect(containerManager.startContainer("test-id")).rejects.toThrow(
        "Docker service is not connected"
      );

      await expect(containerManager.getContainerStatus("test-id")).rejects.toThrow(
        "Docker service is not connected"
      );

      await expect(containerManager.findOrphanedContainers()).rejects.toThrow(
        "Docker service is not connected"
      );
    });
  });
});