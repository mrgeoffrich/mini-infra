import { jest } from "@jest/globals";
import Docker, { Container } from "dockerode";
import { PrismaClient } from "../../generated/prisma";
import { DockerExecutorService } from "../docker-executor";
import { DockerConfigService } from "../docker-config";
import { Readable } from "stream";

// Mock dockerode
const mockContainer = {
  id: "container-123",
  attach: jest.fn(),
  start: jest.fn(),
  wait: jest.fn(),
  inspect: jest.fn(),
  remove: jest.fn(),
  kill: jest.fn(),
  stop: jest.fn(),
};

const mockDocker = {
  createContainer: jest.fn(),
  ping: jest.fn(),
  getContainer: jest.fn(() => mockContainer),
};

jest.mock("dockerode", () => {
  return jest.fn().mockImplementation(() => mockDocker);
});

// Mock DockerConfigService
jest.mock("../docker-config");

// Mock Prisma
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {} as PrismaClient,
}));

// Mock logger
jest.mock("../../lib/logger", () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

// Mock DockerConfigService
const mockDockerConfigService = {
  get: jest.fn(),
} as unknown as DockerConfigService;

import mockLogger from "../../lib/logger";

describe("DockerExecutorService", () => {
  let dockerExecutorService: DockerExecutorService;

  beforeEach(() => {
    jest.clearAllMocks();
    dockerExecutorService = new DockerExecutorService();
    // Mock the docker config service instance
    (dockerExecutorService as any).dockerConfigService = mockDockerConfigService;
  });

  describe("constructor", () => {
    it("should initialize with empty Docker client", () => {
      expect(dockerExecutorService).toBeInstanceOf(DockerExecutorService);
    });
  });

  describe("initialize", () => {
    beforeEach(() => {
      mockDockerConfigService.get = jest.fn()
        .mockResolvedValueOnce("unix:///var/run/docker.sock") // host
        .mockResolvedValueOnce("1.41"); // apiVersion
    });

    it("should initialize Docker client successfully", async () => {
      mockDocker.ping = jest.fn().mockResolvedValue({});

      await dockerExecutorService.initialize();

      expect(mockDockerConfigService.get).toHaveBeenCalledWith("host");
      expect(mockDockerConfigService.get).toHaveBeenCalledWith("apiVersion");
      expect(mockDocker.ping).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith("DockerExecutor initialized successfully");
    });

    it("should throw error when Docker host not configured", async () => {
      mockDockerConfigService.get = jest.fn()
        .mockResolvedValueOnce(null) // No host configured
        .mockResolvedValueOnce("1.41");

      await expect(dockerExecutorService.initialize()).rejects.toThrow(
        "Docker host not configured in database settings",
      );
    });

    it("should handle Docker ping failure", async () => {
      mockDocker.ping = jest.fn().mockRejectedValue(new Error("Docker not available"));

      await expect(dockerExecutorService.initialize()).rejects.toThrow(
        "Docker not available",
      );

      expect(mockLogger.error).toHaveBeenCalledWith(
        {
          error: "Docker not available",
        },
        "Failed to initialize DockerExecutor",
      );
    });
  });

  describe("executeContainer", () => {
    const containerOptions = {
      image: "postgres:15-alpine",
      env: {
        POSTGRES_HOST: "localhost",
        POSTGRES_USER: "testuser",
        POSTGRES_PASSWORD: "testpass",
      },
      timeout: 30000,
    };

    beforeEach(() => {
      mockDocker.createContainer = jest.fn().mockResolvedValue(mockContainer);
      mockContainer.start = jest.fn().mockResolvedValue(undefined);
      mockContainer.wait = jest.fn().mockResolvedValue({ StatusCode: 0 });
      mockContainer.inspect = jest.fn().mockResolvedValue({
        State: { Status: "exited" },
      });
      mockContainer.remove = jest.fn().mockResolvedValue(undefined);

      // Mock attach stream
      const mockStream = new Readable({ read() {} });
      mockContainer.attach = jest.fn().mockResolvedValue(mockStream);

      // Simulate stream data for testing
      setTimeout(() => {
        // Simulate stdout data with Docker stream format
        const stdoutData = Buffer.alloc(8 + 11); // Header + "Hello World"
        stdoutData.writeUInt8(1, 0); // stdout stream type
        stdoutData.writeUInt32BE(11, 4); // data size
        stdoutData.write("Hello World", 8);
        mockStream.emit("data", stdoutData);

        // Simulate stderr data
        const stderrData = Buffer.alloc(8 + 5); // Header + "Error"
        stderrData.writeUInt8(2, 0); // stderr stream type
        stderrData.writeUInt32BE(5, 4); // data size
        stderrData.write("Error", 8);
        mockStream.emit("data", stderrData);

        mockStream.emit("end");
      }, 10);
    });

    it("should execute container successfully", async () => {
      const result = await dockerExecutorService.executeContainer(containerOptions);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Hello World");
      expect(result.stderr).toBe("Error");
      expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
      expect(result.containerId).toBe("container-123");

      expect(mockDocker.createContainer).toHaveBeenCalledWith({
        Image: "postgres:15-alpine",
        Env: [
          "POSTGRES_HOST=localhost",
          "POSTGRES_USER=testuser",
          "POSTGRES_PASSWORD=testpass",
        ],
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
        AutoRemove: true,
        HostConfig: {
          Memory: 2 * 1024 * 1024 * 1024,
          CpuShares: 1024,
        },
      });

      expect(mockContainer.start).toHaveBeenCalled();
      expect(mockContainer.wait).toHaveBeenCalled();
    });

    it("should handle container creation failure", async () => {
      mockDocker.createContainer = jest.fn().mockRejectedValue(
        new Error("Image not found"),
      );

      const result = await dockerExecutorService.executeContainer(containerOptions);

      expect(result.exitCode).toBe(-1);
      expect(result.stderr).toContain("Execution error: Image not found");
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          error: "Image not found",
          image: "postgres:15-alpine",
        }),
        "Container execution failed",
      );
    });

    it("should handle container start failure", async () => {
      mockContainer.start = jest.fn().mockRejectedValue(new Error("Start failed"));

      const result = await dockerExecutorService.executeContainer(containerOptions);

      expect(result.exitCode).toBe(-1);
      expect(result.stderr).toContain("Execution error: Start failed");
    });

    it("should handle container wait timeout", async () => {
      // Mock a long-running container
      mockContainer.wait = jest.fn().mockImplementation(
        () => new Promise(() => {}), // Never resolves
      );

      const result = await dockerExecutorService.executeContainer({
        ...containerOptions,
        timeout: 100, // Very short timeout
      });

      expect(result.exitCode).toBe(-1);
      expect(result.stderr).toContain("Container execution timed out after 100ms");
    });

    it("should cleanup container when removeContainer is true", async () => {
      await dockerExecutorService.executeContainer({
        ...containerOptions,
        removeContainer: true,
      });

      expect(mockContainer.remove).toHaveBeenCalledWith({ force: true });
    });

    it("should not cleanup container when removeContainer is false", async () => {
      await dockerExecutorService.executeContainer({
        ...containerOptions,
        removeContainer: false,
      });

      expect(mockContainer.remove).not.toHaveBeenCalled();
    });

    it("should handle cleanup errors gracefully", async () => {
      mockContainer.inspect = jest.fn().mockResolvedValue({
        State: { Status: "exited" },
      });
      mockContainer.remove = jest.fn().mockRejectedValue(new Error("Remove failed"));

      const result = await dockerExecutorService.executeContainer(containerOptions);

      expect(result.exitCode).toBe(0); // Should still succeed
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          error: "Remove failed",
          containerId: "container-123",
        }),
        "Failed to clean up container",
      );
    });

    it("should handle container already removed (404 error)", async () => {
      mockContainer.inspect = jest.fn().mockRejectedValue({
        statusCode: 404,
        message: "No such container",
      });

      const result = await dockerExecutorService.executeContainer(containerOptions);

      expect(result.exitCode).toBe(0);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        { containerId: "container-123" },
        "Container already removed",
      );
    });

    it("should call output handler when provided", async () => {
      const outputHandler = jest.fn();

      await dockerExecutorService.executeContainer({
        ...containerOptions,
        outputHandler,
      });

      expect(outputHandler).toHaveBeenCalled();
    });
  });

  describe("executeContainerWithProgress", () => {
    const containerOptions = {
      image: "postgres:15-alpine",
      env: { TEST: "value" },
    };

    beforeEach(() => {
      mockDocker.createContainer = jest.fn().mockResolvedValue(mockContainer);
      mockContainer.start = jest.fn().mockResolvedValue(undefined);
      mockContainer.wait = jest.fn().mockResolvedValue({ StatusCode: 0 });
      mockContainer.inspect = jest.fn().mockResolvedValue({
        State: { Status: "exited" },
      });
      mockContainer.remove = jest.fn().mockResolvedValue(undefined);

      const mockStream = new Readable({ read() {} });
      mockContainer.attach = jest.fn().mockResolvedValue(mockStream);

      setTimeout(() => {
        mockStream.emit("end");
      }, 10);
    });

    it("should call progress callback with correct statuses", async () => {
      const progressCallback = jest.fn();

      const result = await dockerExecutorService.executeContainerWithProgress(
        containerOptions,
        progressCallback,
      );

      expect(progressCallback).toHaveBeenCalledWith({
        status: "starting",
      });

      expect(progressCallback).toHaveBeenCalledWith({
        status: "completed",
        containerId: "container-123",
        executionTimeMs: expect.any(Number),
        exitCode: 0,
        errorMessage: undefined,
      });

      expect(result.exitCode).toBe(0);
    });

    it("should report failed status on non-zero exit code", async () => {
      mockContainer.wait = jest.fn().mockResolvedValue({ StatusCode: 1 });
      const progressCallback = jest.fn();

      const result = await dockerExecutorService.executeContainerWithProgress(
        containerOptions,
        progressCallback,
      );

      expect(progressCallback).toHaveBeenCalledWith({
        status: "failed",
        containerId: "container-123",
        executionTimeMs: expect.any(Number),
        exitCode: 1,
        errorMessage: expect.any(String),
      });

      expect(result.exitCode).toBe(1);
    });

    it("should handle execution errors and report failed status", async () => {
      mockDocker.createContainer = jest.fn().mockRejectedValue(
        new Error("Container creation failed"),
      );
      const progressCallback = jest.fn();

      await expect(
        dockerExecutorService.executeContainerWithProgress(
          containerOptions,
          progressCallback,
        ),
      ).rejects.toThrow("Container creation failed");

      expect(progressCallback).toHaveBeenCalledWith({
        status: "failed",
        executionTimeMs: expect.any(Number),
        errorMessage: "Container creation failed",
      });
    });

    it("should work without progress callback", async () => {
      const result = await dockerExecutorService.executeContainerWithProgress(
        containerOptions,
      );

      expect(result.exitCode).toBe(0);
    });
  });

  describe("getContainerStatus", () => {
    it("should return container status successfully", async () => {
      mockContainer.inspect = jest.fn().mockResolvedValue({
        State: {
          Status: "running",
          Running: true,
          ExitCode: 0,
        },
      });

      const result = await dockerExecutorService.getContainerStatus("container-123");

      expect(result).toEqual({
        status: "running",
        running: true,
        exitCode: 0,
      });

      expect(mockDocker.getContainer).toHaveBeenCalledWith("container-123");
      expect(mockContainer.inspect).toHaveBeenCalled();
    });

    it("should handle container not found", async () => {
      mockContainer.inspect = jest.fn().mockRejectedValue(
        new Error("No such container"),
      );

      await expect(
        dockerExecutorService.getContainerStatus("nonexistent"),
      ).rejects.toThrow("No such container");

      expect(mockLogger.error).toHaveBeenCalledWith(
        {
          error: "No such container",
          containerId: "nonexistent",
        },
        "Failed to get container status",
      );
    });
  });

  describe("stopContainer", () => {
    it("should stop container gracefully", async () => {
      mockContainer.stop = jest.fn().mockResolvedValue(undefined);

      await dockerExecutorService.stopContainer("container-123", false);

      expect(mockContainer.stop).toHaveBeenCalled();
      expect(mockContainer.kill).not.toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(
        { containerId: "container-123" },
        "Container stopped",
      );
    });

    it("should force kill container when forceKill is true", async () => {
      mockContainer.kill = jest.fn().mockResolvedValue(undefined);

      await dockerExecutorService.stopContainer("container-123", true);

      expect(mockContainer.kill).toHaveBeenCalled();
      expect(mockContainer.stop).not.toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(
        { containerId: "container-123" },
        "Container killed",
      );
    });

    it("should handle stop/kill errors", async () => {
      mockContainer.stop = jest.fn().mockRejectedValue(new Error("Stop failed"));

      await expect(
        dockerExecutorService.stopContainer("container-123"),
      ).rejects.toThrow("Stop failed");

      expect(mockLogger.error).toHaveBeenCalledWith(
        {
          error: "Stop failed",
          containerId: "container-123",
        },
        "Failed to stop container",
      );
    });
  });

  describe("createDockerClient", () => {
    it("should create client with Windows named pipe", () => {
      const host = "npipe:////./pipe/docker_engine";

      const client = (dockerExecutorService as any).createDockerClient(host, "1.41");

      expect(Docker).toHaveBeenCalledWith({
        socketPath: "//./pipe/docker_engine",
        version: "v1.41",
      });
    });

    it("should create client with Unix socket", () => {
      const host = "unix:///var/run/docker.sock";

      const client = (dockerExecutorService as any).createDockerClient(host);

      expect(Docker).toHaveBeenCalledWith({
        socketPath: "/var/run/docker.sock",
      });
    });

    it("should create client with TCP connection", () => {
      const host = "tcp://localhost:2376";

      const client = (dockerExecutorService as any).createDockerClient(host);

      expect(Docker).toHaveBeenCalledWith({
        host: "localhost",
        port: 2376,
        protocol: "http",
      });
    });

    it("should create client with HTTPS connection", () => {
      const host = "https://docker.example.com:2376";

      const client = (dockerExecutorService as any).createDockerClient(host);

      expect(Docker).toHaveBeenCalledWith({
        host: "docker.example.com",
        port: 2376,
        protocol: "https",
      });
    });

    it("should create client with direct socket path", () => {
      const host = "/var/run/docker.sock";

      const client = (dockerExecutorService as any).createDockerClient(host);

      expect(Docker).toHaveBeenCalledWith({
        socketPath: "/var/run/docker.sock",
      });
    });

    it("should create client with host:port format", () => {
      const host = "localhost:2375";

      const client = (dockerExecutorService as any).createDockerClient(host);

      expect(Docker).toHaveBeenCalledWith({
        host: "localhost",
        port: 2375,
        protocol: "http",
      });
    });

    it("should handle API version with v prefix", () => {
      const host = "unix:///var/run/docker.sock";

      const client = (dockerExecutorService as any).createDockerClient(host, "v1.41");

      expect(Docker).toHaveBeenCalledWith({
        socketPath: "/var/run/docker.sock",
        version: "v1.41",
      });
    });

    it("should add v prefix to API version", () => {
      const host = "unix:///var/run/docker.sock";

      const client = (dockerExecutorService as any).createDockerClient(host, "1.41");

      expect(Docker).toHaveBeenCalledWith({
        socketPath: "/var/run/docker.sock",
        version: "v1.41",
      });
    });
  });

  describe("stream demultiplexing", () => {
    beforeEach(() => {
      mockDocker.createContainer = jest.fn().mockResolvedValue(mockContainer);
      mockContainer.start = jest.fn().mockResolvedValue(undefined);
      mockContainer.wait = jest.fn().mockResolvedValue({ StatusCode: 0 });
      mockContainer.inspect = jest.fn().mockResolvedValue({
        State: { Status: "exited" },
      });
      mockContainer.remove = jest.fn().mockResolvedValue(undefined);
    });

    it("should demultiplex Docker stream correctly", async () => {
      const mockStream = new Readable({ read() {} });
      mockContainer.attach = jest.fn().mockResolvedValue(mockStream);

      const containerOptions = {
        image: "test:latest",
        env: { TEST: "value" },
      };

      const resultPromise = dockerExecutorService.executeContainer(containerOptions);

      // Simulate stdout data
      const stdoutData = Buffer.alloc(8 + 6); // Header + "stdout"
      stdoutData.writeUInt8(1, 0); // stdout stream type
      stdoutData.writeUInt32BE(6, 4); // data size
      stdoutData.write("stdout", 8);
      mockStream.emit("data", stdoutData);

      // Simulate stderr data
      const stderrData = Buffer.alloc(8 + 6); // Header + "stderr"
      stderrData.writeUInt8(2, 0); // stderr stream type
      stderrData.writeUInt32BE(6, 4); // data size
      stderrData.write("stderr", 8);
      mockStream.emit("data", stderrData);

      // Simulate stream end
      mockStream.emit("end");

      const result = await resultPromise;

      expect(result.stdout).toBe("stdout");
      expect(result.stderr).toBe("stderr");
    });

    it("should handle malformed stream chunks", async () => {
      const mockStream = new Readable({ read() {} });
      mockContainer.attach = jest.fn().mockResolvedValue(mockStream);

      const containerOptions = {
        image: "test:latest",
        env: { TEST: "value" },
      };

      const resultPromise = dockerExecutorService.executeContainer(containerOptions);

      // Simulate malformed data (too small)
      const malformedData = Buffer.alloc(4); // Too small for header
      mockStream.emit("data", malformedData);

      // Simulate valid data
      const validData = Buffer.alloc(8 + 4); // Header + "test"
      validData.writeUInt8(1, 0);
      validData.writeUInt32BE(4, 4);
      validData.write("test", 8);
      mockStream.emit("data", validData);

      mockStream.emit("end");

      const result = await resultPromise;

      expect(result.stdout).toBe("test");
    });

    it("should ignore unknown stream types", async () => {
      const mockStream = new Readable({ read() {} });
      mockContainer.attach = jest.fn().mockResolvedValue(mockStream);

      const containerOptions = {
        image: "test:latest",
        env: { TEST: "value" },
      };

      const resultPromise = dockerExecutorService.executeContainer(containerOptions);

      // Simulate unknown stream type
      const unknownData = Buffer.alloc(8 + 4); // Header + "test"
      unknownData.writeUInt8(3, 0); // Unknown stream type
      unknownData.writeUInt32BE(4, 4);
      unknownData.write("test", 8);
      mockStream.emit("data", unknownData);

      mockStream.emit("end");

      const result = await resultPromise;

      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
    });
  });

  describe("container lifecycle", () => {
    it("should handle attach failure", async () => {
      mockDocker.createContainer = jest.fn().mockResolvedValue(mockContainer);
      mockContainer.attach = jest.fn().mockRejectedValue(new Error("Attach failed"));

      const result = await dockerExecutorService.executeContainer({
        image: "test:latest",
        env: { TEST: "value" },
      });

      expect(result.exitCode).toBe(-1);
      expect(result.stderr).toContain("Execution error: Attach failed");
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          error: "Attach failed",
          containerId: "container-123",
        }),
        "Failed to attach to container",
      );
    });

    it("should use default timeout when not specified", async () => {
      mockDocker.createContainer = jest.fn().mockResolvedValue(mockContainer);
      mockContainer.start = jest.fn().mockResolvedValue(undefined);
      mockContainer.wait = jest.fn().mockResolvedValue({ StatusCode: 0 });
      mockContainer.inspect = jest.fn().mockResolvedValue({
        State: { Status: "exited" },
      });
      mockContainer.remove = jest.fn().mockResolvedValue(undefined);

      const mockStream = new Readable({ read() {} });
      mockContainer.attach = jest.fn().mockResolvedValue(mockStream);

      setTimeout(() => mockStream.emit("end"), 10);

      await dockerExecutorService.executeContainer({
        image: "test:latest",
        env: { TEST: "value" },
      });

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          timeout: 30 * 60 * 1000, // Default timeout
        }),
        "Starting container execution",
      );
    });
  });

  describe("resource limits", () => {
    it("should set memory and CPU limits", async () => {
      mockDocker.createContainer = jest.fn().mockResolvedValue(mockContainer);
      mockContainer.start = jest.fn().mockResolvedValue(undefined);
      mockContainer.wait = jest.fn().mockResolvedValue({ StatusCode: 0 });
      mockContainer.inspect = jest.fn().mockResolvedValue({
        State: { Status: "exited" },
      });
      mockContainer.remove = jest.fn().mockResolvedValue(undefined);

      const mockStream = new Readable({ read() {} });
      mockContainer.attach = jest.fn().mockResolvedValue(mockStream);

      setTimeout(() => mockStream.emit("end"), 10);

      await dockerExecutorService.executeContainer({
        image: "test:latest",
        env: { TEST: "value" },
      });

      expect(mockDocker.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          HostConfig: {
            Memory: 2 * 1024 * 1024 * 1024, // 2GB
            CpuShares: 1024,
          },
        }),
      );
    });
  });
});