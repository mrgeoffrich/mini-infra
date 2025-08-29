import { jest } from "@jest/globals";
import { DockerContainerInfo } from "@mini-infra/types/containers";

// Mock dockerode before importing the service
const mockDocker = {
  ping: jest.fn(),
  listContainers: jest.fn(),
  getContainer: jest.fn(),
  getEvents: jest.fn(),
};

const mockContainer = {
  inspect: jest.fn(),
};

mockDocker.getContainer.mockReturnValue(mockContainer);

jest.mock("dockerode", () => {
  return jest.fn().mockImplementation(() => mockDocker);
});

// Mock node-cache
const mockCache = {
  get: jest.fn(),
  set: jest.fn(),
  flushAll: jest.fn(),
  keys: jest.fn().mockReturnValue([]),
  getStats: jest
    .fn()
    .mockReturnValue({ hits: 0, misses: 0, keys: 0, ksize: 0, vsize: 0 }),
};

jest.mock("node-cache", () => {
  return jest.fn().mockImplementation(() => mockCache);
});

// Mock logger
const mockLogger = {
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
};

jest.mock("../../lib/logger", () => mockLogger);

// Mock config
jest.mock("../../lib/config", () => ({
  default: {
    DOCKER_HOST: "", // Let it auto-detect based on platform
    DOCKER_API_VERSION: "1.41", // Will be prefixed with 'v' in the service
    CONTAINER_CACHE_TTL: 3000,
  },
}));

// Import the service after mocks are set up
import DockerService from "../docker";

describe("DockerService", () => {
  let dockerService: DockerService;

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset singleton instance for each test
    (DockerService as any).instance = undefined;
    mockDocker.ping.mockResolvedValue(true);
    mockDocker.getEvents.mockImplementation((options, callback) => {
      callback(null, {
        on: jest.fn(),
      });
    });
  });

  afterEach(() => {
    // Clean up any intervals
    if ((dockerService as any)?.reconnectInterval) {
      clearInterval((dockerService as any).reconnectInterval);
    }
  });

  describe("Singleton Pattern", () => {
    it("should return the same instance when called multiple times", () => {
      const instance1 = DockerService.getInstance();
      const instance2 = DockerService.getInstance();

      expect(instance1).toBe(instance2);
    });

    it("should initialize Docker client with correct configuration", () => {
      DockerService.getInstance();

      const expectedSocketPath =
        process.platform === "win32"
          ? "//./pipe/docker_engine"
          : "/var/run/docker.sock";

      expect(require("dockerode")).toHaveBeenCalledWith({
        socketPath: expectedSocketPath,
        version: "v1.41",
      });
    });

    it("should initialize cache with correct TTL", () => {
      DockerService.getInstance();

      expect(require("node-cache")).toHaveBeenCalledWith({
        stdTTL: 3, // 3000ms / 1000
        checkperiod: 5,
      });
    });
  });

  describe("Connection Management", () => {
    it("should connect successfully and set connected status to true", async () => {
      mockDocker.ping.mockResolvedValueOnce(true);

      dockerService = DockerService.getInstance();

      // Manually trigger connection for testing
      await (dockerService as any).connect();

      expect(mockDocker.ping).toHaveBeenCalled();
      expect(dockerService.isConnected()).toBe(true);
      expect(mockLogger.info).toHaveBeenCalledWith(
        "Docker service connected successfully",
      );
    });

    it("should handle connection failure and schedule reconnect", async () => {
      const connectionError = new Error("Docker daemon not available");
      mockDocker.ping.mockRejectedValueOnce(connectionError);

      dockerService = DockerService.getInstance();

      // Manually trigger connection for testing
      try {
        await (dockerService as any).connect();
      } catch (error) {
        // Expected to throw
      }

      expect(dockerService.isConnected()).toBe(false);
      expect(mockLogger.error).toHaveBeenCalledWith(
        { error: connectionError },
        "Failed to connect to Docker",
      );
    });

    it("should attempt to reconnect when connection fails", () => {
      jest.useFakeTimers();

      const connectionError = new Error("Docker daemon not available");
      mockDocker.ping.mockRejectedValueOnce(connectionError);

      dockerService = DockerService.getInstance();

      // Manually trigger reconnect scheduling
      (dockerService as any).scheduleReconnect();

      // Fast-forward time to trigger reconnection
      jest.advanceTimersByTime(10000);

      expect(mockLogger.info).toHaveBeenCalledWith(
        "Attempting to reconnect to Docker...",
      );

      jest.useRealTimers();
    });

    it("should clear reconnect interval on successful connection", async () => {
      dockerService = DockerService.getInstance();

      // Set up an interval
      (dockerService as any).scheduleReconnect();
      expect((dockerService as any).reconnectInterval).not.toBeNull();

      // Simulate successful connection
      mockDocker.ping.mockResolvedValueOnce(true);
      await (dockerService as any).connect();

      // Verify interval is cleared
      expect((dockerService as any).reconnectInterval).toBeNull();
    });
  });

  describe("Event Listeners", () => {
    it("should set up Docker event listeners", () => {
      dockerService = DockerService.getInstance();

      expect(mockDocker.getEvents).toHaveBeenCalledWith(
        {},
        expect.any(Function),
      );
    });

    it("should flush cache on container events", () => {
      let eventCallback: any;
      const mockStream = {
        on: jest.fn((event, callback) => {
          if (event === "data") {
            eventCallback = callback;
          }
        }),
      };

      mockDocker.getEvents.mockImplementation((options, callback) => {
        callback(null, mockStream);
      });

      dockerService = DockerService.getInstance();

      // Simulate container event
      const containerEvent = JSON.stringify({
        Type: "container",
        Action: "start",
        id: "test-container-id",
      });

      eventCallback(Buffer.from(containerEvent));

      expect(mockCache.flushAll).toHaveBeenCalled();
      expect(mockLogger.debug).toHaveBeenCalledWith(
        {
          action: "start",
          containerId: "test-container-id",
        },
        "Container event received, invalidating cache",
      );
    });

    it("should handle malformed event data gracefully", () => {
      let eventCallback: any;
      const mockStream = {
        on: jest.fn((event, callback) => {
          if (event === "data") {
            eventCallback = callback;
          }
        }),
      };

      mockDocker.getEvents.mockImplementation((options, callback) => {
        callback(null, mockStream);
      });

      dockerService = DockerService.getInstance();

      // Simulate malformed event data
      eventCallback(Buffer.from("invalid json"));

      expect(mockCache.flushAll).not.toHaveBeenCalled();
      expect(mockLogger.error).toHaveBeenCalledWith(
        { error: expect.any(Error) },
        "Failed to parse Docker event",
      );
    });

    it("should handle event stream errors", () => {
      let errorCallback: any;
      const mockStream = {
        on: jest.fn((event, callback) => {
          if (event === "error") {
            errorCallback = callback;
          }
        }),
      };

      mockDocker.getEvents.mockImplementation((options, callback) => {
        callback(null, mockStream);
      });

      dockerService = DockerService.getInstance();

      const streamError = new Error("Stream error");
      errorCallback(streamError);

      expect(mockLogger.error).toHaveBeenCalledWith(
        { error: streamError },
        "Docker events stream error",
      );
    });

    it("should handle getEvents callback error", () => {
      const eventsError = new Error("Failed to get events");
      mockDocker.getEvents.mockImplementation((options, callback) => {
        callback(eventsError, null);
      });

      dockerService = DockerService.getInstance();

      expect(mockLogger.error).toHaveBeenCalledWith(
        { error: eventsError },
        "Failed to subscribe to Docker events",
      );
    });
  });

  describe("isConnected", () => {
    it("should return connection status", () => {
      mockDocker.ping.mockResolvedValueOnce(true);
      dockerService = DockerService.getInstance();

      expect(typeof dockerService.isConnected()).toBe("boolean");
    });
  });

  describe("Cache Management", () => {
    beforeEach(() => {
      dockerService = DockerService.getInstance();
    });

    it("should return cache statistics", () => {
      const mockStats = { hits: 5, misses: 2, keys: 3, ksize: 100, vsize: 500 };
      mockCache.keys.mockReturnValue(["key1", "key2", "key3"]);
      mockCache.getStats.mockReturnValue(mockStats);

      const stats = dockerService.getCacheStats();

      expect(stats).toEqual({
        keys: 3,
        stats: mockStats,
      });
    });

    it("should flush cache manually", () => {
      dockerService.flushCache();

      expect(mockCache.flushAll).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(
        "Docker service cache flushed",
      );
    });
  });

  describe("listContainers", () => {
    beforeEach(() => {
      dockerService = DockerService.getInstance();
      // Mock connected state
      (dockerService as any).connected = true;
    });

    it("should throw error when not connected", async () => {
      (dockerService as any).connected = false;

      await expect(dockerService.listContainers()).rejects.toThrow(
        "Docker service not connected",
      );
    });

    it("should return cached data when available", async () => {
      const cachedData: DockerContainerInfo[] = [
        {
          id: "test-id",
          name: "test-container",
          status: "running",
          image: "nginx",
          imageTag: "latest",
          ports: [],
          volumes: [],
          createdAt: new Date("2023-01-01T00:00:00Z"),
          labels: {},
        },
      ];

      mockCache.get.mockReturnValue(cachedData);

      const result = await dockerService.listContainers();

      expect(result).toBe(cachedData);
      expect(mockDocker.listContainers).not.toHaveBeenCalled();
      expect(mockLogger.debug).toHaveBeenCalledWith(
        "Returning cached container list",
      );
    });

    it("should fetch from Docker API when cache miss", async () => {
      mockCache.get.mockReturnValue(undefined);

      const mockContainerData = [
        {
          Id: "abcd1234",
          Names: ["/test-container"],
          State: "running",
          Image: "nginx:latest",
          Ports: [{ PrivatePort: 80, PublicPort: 8080, Type: "tcp" }],
          Mounts: [
            {
              Source: "/host/path",
              Destination: "/container/path",
              RW: true,
            },
          ],
          NetworkSettings: { IPAddress: "172.17.0.2" },
          Created: 1672531200, // Unix timestamp
          StartedAt: "2023-01-01T00:00:00Z",
          Labels: { version: "1.0" },
        },
      ];

      mockDocker.listContainers.mockResolvedValue(mockContainerData);

      const result = await dockerService.listContainers();

      expect(mockDocker.listContainers).toHaveBeenCalledWith({ all: true });
      expect(mockCache.set).toHaveBeenCalledWith(
        "containers_true",
        expect.any(Array),
      );
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: "abcd1234",
        name: "test-container",
        status: "running",
        image: "nginx",
        imageTag: "latest",
        ports: [{ private: 80, public: 8080, type: "tcp" }],
        volumes: [
          { source: "/host/path", destination: "/container/path", mode: "rw" },
        ],
        ipAddress: "172.17.0.2",
        createdAt: new Date(1672531200 * 1000),
        startedAt: new Date("2023-01-01T00:00:00Z"),
        labels: { version: "1.0" },
      });
    });

    it("should handle timeout errors", async () => {
      mockCache.get.mockReturnValue(undefined);
      mockDocker.listContainers.mockImplementation(
        () =>
          new Promise((_, reject) => {
            setTimeout(() => reject(new Error("Docker API timeout")), 10);
          }),
      );

      await expect(dockerService.listContainers()).rejects.toThrow(
        "Docker API timeout",
      );
      expect(mockLogger.error).toHaveBeenCalledWith(
        { error: expect.any(Error) },
        "Failed to list containers",
      );
    });

    it("should handle Docker API errors", async () => {
      mockCache.get.mockReturnValue(undefined);
      const dockerError = new Error("Docker daemon error");
      mockDocker.listContainers.mockRejectedValue(dockerError);

      await expect(dockerService.listContainers()).rejects.toThrow(
        "Docker daemon error",
      );
      expect(mockLogger.error).toHaveBeenCalledWith(
        { error: dockerError },
        "Failed to list containers",
      );
    });
  });

  describe("getContainer", () => {
    beforeEach(() => {
      dockerService = DockerService.getInstance();
      (dockerService as any).connected = true;
    });

    it("should throw error when not connected", async () => {
      (dockerService as any).connected = false;

      await expect(dockerService.getContainer("test-id")).rejects.toThrow(
        "Docker service not connected",
      );
    });

    it("should return cached container data", async () => {
      const cachedContainer: DockerContainerInfo = {
        id: "test-id",
        name: "test-container",
        status: "running",
        image: "nginx",
        imageTag: "latest",
        ports: [],
        volumes: [],
        createdAt: new Date(),
        labels: {},
      };

      mockCache.get.mockReturnValue(cachedContainer);

      const result = await dockerService.getContainer("test-id");

      expect(result).toBe(cachedContainer);
      expect(mockDocker.getContainer).not.toHaveBeenCalled();
    });

    it("should fetch detailed container data from Docker API", async () => {
      mockCache.get.mockReturnValue(undefined);

      const mockDetailedData = {
        Id: "abcd1234",
        Name: "/test-container",
        State: { Status: "running", StartedAt: "2023-01-01T00:00:00Z" },
        Config: {
          Image: "nginx:latest",
          Labels: { version: "1.0" },
        },
        NetworkSettings: {
          IPAddress: "172.17.0.2",
          Ports: { "80/tcp": [{ HostPort: "8080" }] },
        },
        Mounts: [
          {
            Source: "/host/path",
            Destination: "/container/path",
            RW: false,
          },
        ],
        Created: "2023-01-01T00:00:00Z",
      };

      mockContainer.inspect.mockResolvedValue(mockDetailedData);

      const result = await dockerService.getContainer("test-id");

      expect(mockDocker.getContainer).toHaveBeenCalledWith("test-id");
      expect(mockContainer.inspect).toHaveBeenCalled();
      expect(mockCache.set).toHaveBeenCalledWith(
        "container_test-id",
        expect.any(Object),
      );
      expect(result).toMatchObject({
        id: "abcd1234",
        name: "test-container",
        status: "running",
        image: "nginx",
        imageTag: "latest",
        ports: [{ private: 80, public: 8080, type: "tcp" }],
        volumes: [
          { source: "/host/path", destination: "/container/path", mode: "ro" },
        ],
        ipAddress: "172.17.0.2",
        createdAt: new Date("2023-01-01T00:00:00Z"),
        startedAt: new Date("2023-01-01T00:00:00Z"),
        labels: { version: "1.0" },
      });
    });

    it("should return null for 404 errors", async () => {
      mockCache.get.mockReturnValue(undefined);
      const notFoundError = new Error("Container not found");
      (notFoundError as any).statusCode = 404;
      mockContainer.inspect.mockRejectedValue(notFoundError);

      const result = await dockerService.getContainer("non-existent");

      expect(result).toBeNull();
      expect(mockLogger.error).not.toHaveBeenCalled();
    });

    it("should handle other Docker API errors", async () => {
      mockCache.get.mockReturnValue(undefined);
      const dockerError = new Error("Docker daemon error");
      mockContainer.inspect.mockRejectedValue(dockerError);

      await expect(dockerService.getContainer("test-id")).rejects.toThrow(
        "Docker daemon error",
      );
      expect(mockLogger.error).toHaveBeenCalledWith(
        {
          error: dockerError,
          containerId: "test-id",
        },
        "Failed to get container details",
      );
    });

    it("should handle timeout errors", async () => {
      mockCache.get.mockReturnValue(undefined);
      mockContainer.inspect.mockImplementation(
        () =>
          new Promise((_, reject) => {
            setTimeout(() => reject(new Error("Docker API timeout")), 10);
          }),
      );

      await expect(dockerService.getContainer("test-id")).rejects.toThrow(
        "Docker API timeout",
      );
    });
  });

  describe("Data Transformation", () => {
    beforeEach(() => {
      dockerService = DockerService.getInstance();
    });

    it("should normalize container status correctly", () => {
      const testCases = [
        { input: "RUNNING", expected: "running" },
        { input: "exited", expected: "exited" },
        { input: "STOPPED", expected: "stopped" },
        { input: "Restarting", expected: "restarting" },
        { input: "PAUSED", expected: "paused" },
        { input: "unknown-status", expected: "exited" },
      ];

      testCases.forEach(({ input, expected }) => {
        const result = (dockerService as any).normalizeStatus(input);
        expect(result).toBe(expected);
      });
    });

    it("should transform port data correctly", () => {
      const mockPorts = [
        { PrivatePort: 80, PublicPort: 8080, Type: "tcp" },
        { PrivatePort: 443, Type: "tcp" }, // No public port
        { PrivatePort: 53, PublicPort: 5353, Type: "udp" },
      ];

      const result = (dockerService as any).transformPorts(mockPorts);

      expect(result).toEqual([
        { private: 80, public: 8080, type: "tcp" },
        { private: 443, public: undefined, type: "tcp" },
        { private: 53, public: 5353, type: "udp" },
      ]);
    });

    it("should transform detailed port data correctly", () => {
      const mockDetailedPorts = {
        "80/tcp": [{ HostPort: "8080" }],
        "443/tcp": null, // No bindings
        "53/udp": [{ HostPort: "5353" }],
      };

      const result = (dockerService as any).transformDetailedPorts(
        mockDetailedPorts,
      );

      expect(result).toEqual([
        { private: 80, type: "tcp", public: 8080 },
        { private: 443, type: "tcp", public: undefined },
        { private: 53, type: "udp", public: 5353 },
      ]);
    });

    it("should transform volume data correctly", () => {
      const mockMounts = [
        { Source: "/host/data", Destination: "/app/data", RW: true },
        { Name: "my-volume", Destination: "/app/config", RW: false },
        { Source: "/host/logs", Destination: "/app/logs", RW: true },
      ];

      const result = (dockerService as any).transformVolumes(mockMounts);

      expect(result).toEqual([
        { source: "/host/data", destination: "/app/data", mode: "rw" },
        { source: "my-volume", destination: "/app/config", mode: "ro" },
        { source: "/host/logs", destination: "/app/logs", mode: "rw" },
      ]);
    });

    it("should extract IP address from various network settings", () => {
      const testCases = [
        {
          input: { IPAddress: "172.17.0.2" },
          expected: "172.17.0.2",
        },
        {
          input: {
            Networks: {
              bridge: { IPAddress: "172.17.0.3" },
            },
          },
          expected: "172.17.0.3",
        },
        {
          input: {
            IPAddress: "172.17.0.2",
            Networks: {
              bridge: { IPAddress: "172.17.0.3" },
            },
          },
          expected: "172.17.0.2", // Prefer direct IPAddress
        },
        {
          input: null,
          expected: undefined,
        },
        {
          input: {},
          expected: undefined,
        },
      ];

      testCases.forEach(({ input, expected }) => {
        const result = (dockerService as any).extractIpAddress(input);
        expect(result).toBe(expected);
      });
    });

    it("should sanitize sensitive labels", () => {
      const mockLabels = {
        version: "1.0",
        environment: "production",
        "secret-key": "sensitive-value",
        "api-key": "another-sensitive-value",
        "database-password": "very-secret",
        "auth-token": "token-value",
        "normal-label": "normal-value",
        "private-setting": "private-value",
        "confidential-data": "confidential-value",
      };

      const result = (dockerService as any).sanitizeLabels(mockLabels);

      expect(result).toEqual({
        version: "1.0",
        environment: "production",
        "secret-key": "[REDACTED]",
        "api-key": "[REDACTED]",
        "database-password": "[REDACTED]",
        "auth-token": "[REDACTED]",
        "normal-label": "normal-value",
        "private-setting": "[REDACTED]",
        "confidential-data": "[REDACTED]",
      });
    });

    it("should handle containers with missing names gracefully", () => {
      const mockContainer = {
        Id: "abcd1234",
        Names: [], // Empty names array
        State: "running",
        Image: "nginx:latest",
        Ports: [],
        Mounts: [],
        NetworkSettings: {},
        Created: 1672531200,
        Labels: {},
      };

      const result = (dockerService as any).transformContainerData(
        mockContainer,
      );

      expect(result.name).toBe("unknown");
    });

    it("should handle containers with no image tag", () => {
      const mockContainer = {
        Id: "abcd1234",
        Names: ["/test-container"],
        State: "running",
        Image: "nginx", // No tag
        Ports: [],
        Mounts: [],
        NetworkSettings: {},
        Created: 1672531200,
        Labels: {},
      };

      const result = (dockerService as any).transformContainerData(
        mockContainer,
      );

      expect(result.image).toBe("nginx");
      expect(result.imageTag).toBe("latest");
    });
  });

  describe("TCP Configuration", () => {
    beforeEach(() => {
      jest.clearAllMocks();
      // Reset singleton instance
      (DockerService as any).instance = undefined;
    });

    it("should configure Docker client for TCP connection", () => {
      // Mock TCP configuration
      jest.doMock("../../lib/config", () => ({
        default: {
          DOCKER_HOST: "tcp://localhost:2375",
          DOCKER_API_VERSION: "1.41",
          CONTAINER_CACHE_TTL: 3000,
        },
      }));

      const DockerServiceTCP = require("../docker").default;
      DockerServiceTCP.getInstance();

      expect(require("dockerode")).toHaveBeenCalledWith({
        host: "localhost",
        port: 2375,
        protocol: "http",
        version: "v1.41",
      });
    });
  });
});
