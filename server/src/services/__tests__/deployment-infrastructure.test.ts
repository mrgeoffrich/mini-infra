import { jest } from "@jest/globals";

// Mock the Docker service and its methods first
const mockDockerInstance = {
  listNetworks: jest.fn(),
  createNetwork: jest.fn(),
  listContainers: jest.fn(),
  createContainer: jest.fn(),
  getContainer: jest.fn(),
  getNetwork: jest.fn(),
};

const mockContainer = {
  start: jest.fn(),
  stop: jest.fn(),
  remove: jest.fn(),
  id: "container-id-123",
};

const mockNetwork = {
  id: "network-id-123",
  remove: jest.fn(),
};

// Create a mock DockerService class
class MockDockerService {
  static getInstance = jest.fn().mockReturnValue(new MockDockerService());
  getDockerInstance = jest.fn().mockResolvedValue(mockDockerInstance);
}

// Mock logger first
const mockLogger = {
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
};

jest.mock("../../lib/logger-factory", () => ({
  appLogger: jest.fn(() => mockLogger),
  servicesLogger: jest.fn(() => mockLogger),
}));

jest.mock("../docker", () => {
  return {
    __esModule: true,
    default: MockDockerService,
  };
});

// Import after mocking
import { DeploymentInfrastructureService } from "../deployment-infrastructure";

// Mock js-yaml
jest.mock("js-yaml", () => ({
  load: jest.fn(),
}));

describe("DeploymentInfrastructureService", () => {
  let deploymentService: DeploymentInfrastructureService;

  beforeEach(() => {
    jest.clearAllMocks();
    deploymentService = new DeploymentInfrastructureService();
  });

  describe("ensureDeploymentNetwork", () => {
    it("should return existing network if it already exists", async () => {
      const existingNetwork = { Id: "existing-network-id" };
      mockDockerInstance.listNetworks.mockResolvedValue([existingNetwork]);

      const result = await deploymentService.ensureDeploymentNetwork(
        "test-network"
      );

      expect(result).toEqual({
        success: true,
        networkId: "existing-network-id",
      });
      expect(mockDockerInstance.listNetworks).toHaveBeenCalledWith({
        filters: { name: ["test-network"] },
      });
      expect(mockDockerInstance.createNetwork).not.toHaveBeenCalled();
    });

    it("should create new network if it doesn't exist", async () => {
      mockDockerInstance.listNetworks.mockResolvedValue([]);
      mockDockerInstance.createNetwork.mockResolvedValue({ id: "new-network-id" });

      const result = await deploymentService.ensureDeploymentNetwork(
        "test-network",
        "bridge"
      );

      expect(result).toEqual({
        success: true,
        networkId: "new-network-id",
      });
      expect(mockDockerInstance.createNetwork).toHaveBeenCalledWith({
        Name: "test-network",
        Driver: "bridge",
        Labels: {
          "mini-infra.type": "deployment-network",
          "mini-infra.managed": "true",
        },
      });
    });

    it("should handle errors when creating network", async () => {
      mockDockerInstance.listNetworks.mockResolvedValue([]);
      const error = new Error("Network creation failed");
      mockDockerInstance.createNetwork.mockRejectedValue(error);

      const result = await deploymentService.ensureDeploymentNetwork(
        "test-network"
      );

      expect(result).toEqual({
        success: false,
        error: "Network creation failed",
      });
    });

    it("should handle errors when accessing Docker service", async () => {
      const mockServiceInstance = new MockDockerService();
      MockDockerService.getInstance.mockReturnValue(mockServiceInstance);
      mockServiceInstance.getDockerInstance.mockRejectedValue(
        new Error("Docker service not available")
      );

      const result = await deploymentService.ensureDeploymentNetwork(
        "test-network"
      );

      expect(result).toEqual({
        success: false,
        error: "Docker service not available",
      });
    });
  });

  describe("getInfrastructureStatus", () => {
    it("should return status for existing network and running container", async () => {
      const network = { Id: "network-123" };
      const container = { Id: "container-123", State: "running" };

      mockDockerInstance.listNetworks.mockResolvedValue([network]);
      mockDockerInstance.listContainers.mockResolvedValue([container]);

      const result = await deploymentService.getInfrastructureStatus(
        "test-network"
      );

      expect(result).toEqual({
        networkStatus: {
          exists: true,
          id: "network-123",
        },
        traefikStatus: {
          exists: true,
          running: true,
          id: "container-123",
        },
      });
    });

    it("should return status for non-existing infrastructure", async () => {
      mockDockerInstance.listNetworks.mockResolvedValue([]);
      mockDockerInstance.listContainers.mockResolvedValue([]);

      const result = await deploymentService.getInfrastructureStatus(
        "test-network"
      );

      expect(result).toEqual({
        networkStatus: {
          exists: false,
        },
        traefikStatus: {
          exists: false,
          running: false,
        },
      });
    });

    it("should handle errors and return error status", async () => {
      const error = new Error("Docker API error");
      mockDockerInstance.listNetworks.mockRejectedValue(error);

      const result = await deploymentService.getInfrastructureStatus(
        "test-network"
      );

      expect(result).toEqual({
        networkStatus: {
          exists: false,
          error: "Docker API error",
        },
        traefikStatus: {
          exists: false,
          running: false,
          error: "Docker API error",
        },
      });
    });

    it("should handle error when getDockerInstance fails", async () => {
      const mockServiceInstance = new MockDockerService();
      MockDockerService.getInstance.mockReturnValue(mockServiceInstance);
      mockServiceInstance.getDockerInstance.mockRejectedValue(
        new Error("Docker service not connected")
      );

      const result = await deploymentService.getInfrastructureStatus(
        "test-network"
      );

      expect(result).toEqual({
        networkStatus: {
          exists: false,
          error: "Docker service not connected",
        },
        traefikStatus: {
          exists: false,
          running: false,
          error: "Docker service not connected",
        },
      });
    });
  });

  describe("ensureTraefikContainer", () => {
    const mockConfig = {
      image: "traefik:v3.0",
      webPort: 80,
      dashboardPort: 8080,
      configYaml: "api:\n  dashboard: true",
      networkName: "test-network",
    };

    beforeEach(() => {
      // Mock yaml.load to succeed by default
      const yaml = require("js-yaml");
      yaml.load.mockReturnValue({ api: { dashboard: true } });
    });

    it("should deploy new Traefik container successfully", async () => {
      mockDockerInstance.listContainers.mockResolvedValue([]);
      mockDockerInstance.listNetworks.mockResolvedValue([{ Id: "network-123" }]);
      mockDockerInstance.createContainer.mockResolvedValue(mockContainer);

      const result = await deploymentService.ensureTraefikContainer(mockConfig);

      expect(result).toEqual({
        success: true,
        containerId: "container-id-123",
      });
      expect(mockContainer.start).toHaveBeenCalled();
    });

    it("should stop and remove existing Traefik container before deploying new one", async () => {
      const existingContainer = { Id: "old-container-id" };
      mockDockerInstance.listContainers.mockResolvedValue([existingContainer]);
      mockDockerInstance.listNetworks.mockResolvedValue([{ Id: "network-123" }]);
      mockDockerInstance.getContainer.mockReturnValue({
        stop: jest.fn().mockResolvedValue(undefined),
        remove: jest.fn().mockResolvedValue(undefined),
      });
      mockDockerInstance.createContainer.mockResolvedValue(mockContainer);

      const result = await deploymentService.ensureTraefikContainer(mockConfig);

      expect(result).toEqual({
        success: true,
        containerId: "container-id-123",
      });
      expect(mockDockerInstance.getContainer).toHaveBeenCalledWith("old-container-id");
    });

    it("should handle invalid YAML configuration", async () => {
      const yaml = require("js-yaml");
      yaml.load.mockImplementation(() => {
        throw new Error("Invalid YAML");
      });

      const result = await deploymentService.ensureTraefikContainer(mockConfig);

      expect(result).toEqual({
        success: false,
        error: "Invalid YAML configuration: Invalid YAML",
      });
    });

    it("should handle network creation failure", async () => {
      mockDockerInstance.listContainers.mockResolvedValue([]);
      mockDockerInstance.listNetworks.mockResolvedValue([]);
      mockDockerInstance.createNetwork.mockRejectedValue(
        new Error("Network creation failed")
      );

      const result = await deploymentService.ensureTraefikContainer(mockConfig);

      expect(result).toEqual({
        success: false,
        error: "Failed to create network: Network creation failed",
      });
    });

    it("should handle container creation failure", async () => {
      mockDockerInstance.listContainers.mockResolvedValue([]);
      mockDockerInstance.listNetworks.mockResolvedValue([{ Id: "network-123" }]);
      const error = new Error("Container creation failed");
      mockDockerInstance.createContainer.mockRejectedValue(error);

      const result = await deploymentService.ensureTraefikContainer(mockConfig);

      expect(result).toEqual({
        success: false,
        error: "Container creation failed",
      });
    });

    it("should handle Docker service connection failure", async () => {
      const mockServiceInstance = new MockDockerService();
      MockDockerService.getInstance.mockReturnValue(mockServiceInstance);
      mockServiceInstance.getDockerInstance.mockRejectedValue(
        new Error("Docker service not connected")
      );

      const result = await deploymentService.ensureTraefikContainer(mockConfig);

      expect(result).toEqual({
        success: false,
        error: "Docker service not connected",
      });
    });
  });

  describe("cleanupInfrastructure", () => {
    it("should cleanup containers and networks successfully", async () => {
      const containers = [{ Id: "container-123" }];
      const networks = [{ Id: "network-123" }];

      mockDockerInstance.listContainers.mockResolvedValue(containers);
      mockDockerInstance.listNetworks.mockResolvedValue(networks);
      mockDockerInstance.getContainer.mockReturnValue({
        stop: jest.fn().mockResolvedValue(undefined),
        remove: jest.fn().mockResolvedValue(undefined),
      });
      mockDockerInstance.getNetwork.mockReturnValue(mockNetwork);

      const result = await deploymentService.cleanupInfrastructure("test-network");

      expect(result).toEqual({ success: true });
      expect(mockNetwork.remove).toHaveBeenCalled();
    });

    it("should handle stop failure but continue with removal", async () => {
      const containers = [{ Id: "container-123" }];
      const networks = [{ Id: "network-123" }];

      mockDockerInstance.listContainers.mockResolvedValue(containers);
      mockDockerInstance.listNetworks.mockResolvedValue(networks);
      mockDockerInstance.getContainer.mockReturnValue({
        stop: jest.fn().mockRejectedValue(new Error("Stop failed")),
        remove: jest.fn().mockResolvedValue(undefined),
      });
      mockDockerInstance.getNetwork.mockReturnValue(mockNetwork);

      const result = await deploymentService.cleanupInfrastructure("test-network");

      expect(result).toEqual({ success: true });
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it("should handle cleanup failure", async () => {
      const error = new Error("Cleanup failed");
      mockDockerInstance.listContainers.mockRejectedValue(error);

      const result = await deploymentService.cleanupInfrastructure("test-network");

      expect(result).toEqual({
        success: false,
        error: "Cleanup failed",
      });
    });

    it("should handle Docker service connection failure during cleanup", async () => {
      const mockServiceInstance = new MockDockerService();
      MockDockerService.getInstance.mockReturnValue(mockServiceInstance);
      mockServiceInstance.getDockerInstance.mockRejectedValue(
        new Error("Docker service not connected")
      );

      const result = await deploymentService.cleanupInfrastructure("test-network");

      expect(result).toEqual({
        success: false,
        error: "Docker service not connected",
      });
    });
  });

  describe("integration with DockerService.getDockerInstance", () => {
    it("should use getDockerInstance method for all Docker operations", async () => {
      const mockServiceInstance = new MockDockerService();
      MockDockerService.getInstance.mockReturnValue(mockServiceInstance);
      mockDockerInstance.listNetworks.mockResolvedValue([]);
      mockDockerInstance.createNetwork.mockResolvedValue({ id: "network-123" });

      await deploymentService.ensureDeploymentNetwork("test-network");

      expect(mockServiceInstance.getDockerInstance).toHaveBeenCalled();
      expect(mockDockerInstance.listNetworks).toHaveBeenCalled();
    });

    it("should propagate getDockerInstance errors correctly", async () => {
      const mockServiceInstance = new MockDockerService();
      MockDockerService.getInstance.mockReturnValue(mockServiceInstance);
      const dockerError = new Error("this.dockerService.getDockerInstance is not a function");
      mockServiceInstance.getDockerInstance.mockRejectedValue(dockerError);

      const result = await deploymentService.ensureDeploymentNetwork("test-network");

      expect(result).toEqual({
        success: false,
        error: "this.dockerService.getDockerInstance is not a function",
      });
    });
  });
});