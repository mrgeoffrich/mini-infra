import { jest } from "@jest/globals";
import { PrismaClient } from "../../generated/prisma";
import { ValidationResult, ServiceHealthStatus } from "@mini-infra/types";
import { DockerConfigService } from "../docker-config";

// Mock dockerode before importing
const mockDocker = {
  ping: jest.fn(),
  info: jest.fn(),
  version: jest.fn(),
};

jest.mock("dockerode", () => {
  return jest.fn().mockImplementation(() => mockDocker);
});

// Mock logger functions
const mockLoggerFunctions = {
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
};

// Mock logger
jest.mock("../../lib/logger-factory", () => ({
  appLogger: jest.fn(() => mockLoggerFunctions),
  servicesLogger: jest.fn(() => mockLoggerFunctions),
  httpLogger: jest.fn(() => mockLoggerFunctions),
  prismaLogger: jest.fn(() => mockLoggerFunctions),
  __esModule: true,
  default: jest.fn(() => mockLoggerFunctions),
}));

// Get reference to the mocked logger
const mockLogger = mockLoggerFunctions;

// Mock Prisma client
const mockPrisma = {
  systemSettings: {
    findUnique: jest.fn(),
    upsert: jest.fn(),
    delete: jest.fn(),
  },
  connectivityStatus: {
    create: jest.fn(),
    findFirst: jest.fn(),
  },
  settingsAudit: {
    create: jest.fn(),
  },
} as unknown as PrismaClient;

// Import the mock after the jest.mock calls

describe("DockerConfigService", () => {
  let dockerConfigService: DockerConfigService;

  beforeEach(() => {
    jest.clearAllMocks();
    dockerConfigService = new DockerConfigService(mockPrisma);
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  describe("Constructor", () => {
    it("should initialize with correct category", () => {
      expect(dockerConfigService).toBeInstanceOf(DockerConfigService);
      expect((dockerConfigService as any).category).toBe("docker");
    });
  });

  describe("validate", () => {
    it("should validate Docker connectivity successfully", async () => {
      // Mock settings retrieval
      mockPrisma.systemSettings.findUnique = jest
        .fn()
        .mockResolvedValueOnce(null) // host setting not found
        .mockResolvedValueOnce(null); // apiVersion setting not found

      // Mock successful Docker operations
      mockDocker.ping.mockResolvedValue(true);
      mockDocker.info.mockResolvedValue({
        OperatingSystem: "Ubuntu 20.04",
        Architecture: "x86_64",
        Containers: 10,
        Images: 5,
      });
      mockDocker.version.mockResolvedValue({
        Version: "20.10.8",
        ApiVersion: "1.41",
      });

      mockPrisma.connectivityStatus.create = jest.fn().mockResolvedValue({});

      const result: ValidationResult = await dockerConfigService.validate();

      expect(result.isValid).toBe(true);
      expect(result.message).toContain("Docker connection successful");
      expect(result.responseTimeMs).toBeGreaterThanOrEqual(0);
      expect(result.metadata).toMatchObject({
        serverVersion: "20.10.8",
        apiVersion: "1.41",
        platform: "Ubuntu 20.04",
        architecture: "x86_64",
        containers: 10,
        images: 5,
      });

      // Verify connectivity status was recorded
      expect(mockPrisma.connectivityStatus.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            service: "docker",
            status: "connected",
            errorMessage: null,
            errorCode: null,
            metadata: JSON.stringify(result.metadata),
            checkInitiatedBy: null,
          }),
        }),
      );
    });

    it("should handle Docker ping timeout", async () => {
      mockPrisma.systemSettings.findUnique = jest.fn().mockResolvedValue(null);

      // Mock timeout scenario by directly rejecting with timeout error
      mockDocker.ping.mockRejectedValue(new Error("Docker API timeout"));

      mockPrisma.connectivityStatus.create = jest.fn().mockResolvedValue({});

      const result = await dockerConfigService.validate();

      expect(result.isValid).toBe(false);
      expect(result.message).toContain("Docker API timeout");
      expect(result.responseTimeMs).toBeGreaterThanOrEqual(0);
    });

    it("should handle Docker connection refused error", async () => {
      mockPrisma.systemSettings.findUnique = jest.fn().mockResolvedValue(null);

      const connectionError = new Error("connect ECONNREFUSED");
      (connectionError as any).code = "ECONNREFUSED";
      mockDocker.ping.mockRejectedValue(connectionError);

      mockPrisma.connectivityStatus.create = jest.fn().mockResolvedValue({});

      const result = await dockerConfigService.validate();

      expect(result.isValid).toBe(false);
      expect(result.message).toContain("Docker connection failed");
      expect(result.errorCode).toBe("ECONNREFUSED");
      expect(result.responseTimeMs).toBeGreaterThanOrEqual(0);

      // Verify error status was recorded
      expect(mockPrisma.connectivityStatus.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            service: "docker",
            status: "unreachable",
            errorMessage: expect.stringContaining("ECONNREFUSED"),
            errorCode: "ECONNREFUSED",
            checkInitiatedBy: null,
            lastSuccessfulAt: null,
          }),
        }),
      );
    });

    it("should use custom Docker host from settings", async () => {
      // Mock custom host setting
      mockPrisma.systemSettings.findUnique = jest
        .fn()
        .mockResolvedValueOnce({
          value: "tcp://192.168.1.100:2376",
        })
        .mockResolvedValueOnce({
          value: "1.40",
        });

      mockDocker.ping.mockResolvedValue(true);
      mockDocker.info.mockResolvedValue({
        OperatingSystem: "Ubuntu 20.04",
        Architecture: "x86_64",
        Containers: 5,
        Images: 3,
      });
      mockDocker.version.mockResolvedValue({
        Version: "20.10.8",
        ApiVersion: "1.40",
      });

      mockPrisma.connectivityStatus.create = jest.fn().mockResolvedValue({});

      const result = await dockerConfigService.validate();

      expect(result.isValid).toBe(true);
      expect(mockLogger.info).toHaveBeenCalledWith(
        {
          host: "tcp://192.168.1.100:2376",
          apiVersion: "1.40",
        },
        "Validating Docker configuration",
      );
    });

    it("should handle Docker info/version API errors gracefully", async () => {
      mockPrisma.systemSettings.findUnique = jest.fn().mockResolvedValue(null);

      mockDocker.ping.mockResolvedValue(true);
      mockDocker.info.mockRejectedValue(new Error("Docker info failed"));
      mockDocker.version.mockRejectedValue(new Error("Docker version failed"));

      const result = await dockerConfigService.validate();

      expect(result.isValid).toBe(false);
      expect(result.message).toContain("Docker info failed");
    });
  });

  describe("getHealthStatus", () => {
    it("should return health status from latest connectivity record", async () => {
      const mockConnectivityStatus = {
        service: "docker",
        status: "connected",
        responseTimeMs: 150,
        errorMessage: null,
        errorCode: null,
        checkedAt: new Date("2023-01-01T12:00:00Z"),
        lastSuccessfulAt: new Date("2023-01-01T12:00:00Z"),
        metadata: JSON.stringify({
          serverVersion: "20.10.8",
          apiVersion: "1.41",
        }),
      };

      mockPrisma.connectivityStatus.findFirst = jest
        .fn()
        .mockResolvedValue(mockConnectivityStatus);

      const result: ServiceHealthStatus =
        await dockerConfigService.getHealthStatus();

      expect(result).toEqual({
        service: "docker",
        status: "connected",
        lastChecked: new Date("2023-01-01T12:00:00Z"),
        lastSuccessful: new Date("2023-01-01T12:00:00Z"),
        responseTime: 150,
        errorMessage: undefined,
        errorCode: undefined,
        metadata: {
          serverVersion: "20.10.8",
          apiVersion: "1.41",
        },
      });
    });

    it("should return unreachable status when no connectivity data exists", async () => {
      mockPrisma.connectivityStatus.findFirst = jest
        .fn()
        .mockResolvedValue(null);

      const result = await dockerConfigService.getHealthStatus();

      expect(result.service).toBe("docker");
      expect(result.status).toBe("unreachable");
      expect(result.errorMessage).toBe("No connectivity data available");
      expect(result.lastChecked).toBeInstanceOf(Date);
    });

    it("should handle failed connectivity status correctly", async () => {
      const mockConnectivityStatus = {
        service: "docker",
        status: "failed",
        responseTimeMs: 5000,
        errorMessage: "Connection timeout",
        errorCode: "TIMEOUT",
        checkedAt: new Date("2023-01-01T12:00:00Z"),
        lastSuccessfulAt: null,
        metadata: null,
      };

      mockPrisma.connectivityStatus.findFirst = jest
        .fn()
        .mockResolvedValue(mockConnectivityStatus);

      const result = await dockerConfigService.getHealthStatus();

      expect(result).toEqual({
        service: "docker",
        status: "failed",
        lastChecked: new Date("2023-01-01T12:00:00Z"),
        lastSuccessful: undefined,
        responseTime: 5000,
        errorMessage: "Connection timeout",
        errorCode: "TIMEOUT",
        metadata: undefined,
      });
    });
  });

  describe("testConnection", () => {
    it("should test connection with provided parameters", async () => {
      mockDocker.ping.mockResolvedValue(true);
      mockDocker.version.mockResolvedValue({
        Version: "20.10.8",
        ApiVersion: "1.41",
      });

      const result = await dockerConfigService.testConnection(
        "tcp://localhost:2375",
        "1.40",
      );

      expect(result.isValid).toBe(true);
      expect(result.message).toBe("Docker connection test successful");
      expect(result.metadata).toMatchObject({
        serverVersion: "20.10.8",
        apiVersion: "1.41",
      });
    });

    it("should test connection with stored settings when no parameters provided", async () => {
      // Mock stored settings
      mockPrisma.systemSettings.findUnique = jest
        .fn()
        .mockResolvedValueOnce({
          value: "tcp://stored-host:2376",
        })
        .mockResolvedValueOnce({
          value: "1.39",
        });

      mockDocker.ping.mockResolvedValue(true);
      mockDocker.version.mockResolvedValue({
        Version: "19.03.15",
        ApiVersion: "1.39",
      });

      const result = await dockerConfigService.testConnection();

      expect(result.isValid).toBe(true);
      expect(result.metadata).toMatchObject({
        serverVersion: "19.03.15",
        apiVersion: "1.39",
      });
    });

    it("should handle connection test timeout", async () => {
      // Mock timeout scenario by directly rejecting with timeout error
      mockDocker.ping.mockRejectedValue(new Error("Connection timeout"));

      const result = await dockerConfigService.testConnection();

      expect(result.isValid).toBe(false);
      expect(result.message).toContain("Connection timeout");
    });
  });

  describe("createDockerClient", () => {
    it("should create client with Unix socket path", () => {
      const client = (dockerConfigService as any).createDockerClient(
        "/var/run/docker.sock",
        "1.41",
      );

      expect(require("dockerode")).toHaveBeenCalledWith({
        socketPath: "/var/run/docker.sock",
        version: "v1.41",
      });
    });

    it("should create client with Windows named pipe", () => {
      (dockerConfigService as any).createDockerClient(
        "//./pipe/docker_engine",
        "1.41",
      );

      expect(require("dockerode")).toHaveBeenCalledWith({
        socketPath: "//./pipe/docker_engine",
        version: "v1.41",
      });
    });

    it("should create client with TCP connection", () => {
      (dockerConfigService as any).createDockerClient(
        "tcp://192.168.1.100:2376",
        "1.41",
      );

      expect(require("dockerode")).toHaveBeenCalledWith({
        host: "192.168.1.100",
        port: 2376,
        protocol: "http",
        version: "v1.41",
      });
    });

    it("should create client with HTTPS connection", () => {
      (dockerConfigService as any).createDockerClient(
        "https://secure-docker:2376",
        "1.41",
      );

      expect(require("dockerode")).toHaveBeenCalledWith({
        host: "secure-docker",
        port: 2376,
        protocol: "https",
        version: "v1.41",
      });
    });

    it("should handle unix:// prefix", () => {
      (dockerConfigService as any).createDockerClient(
        "unix:///var/run/docker.sock",
        null,
      );

      expect(require("dockerode")).toHaveBeenCalledWith({
        socketPath: "/var/run/docker.sock",
      });
    });

    it("should handle host:port format", () => {
      (dockerConfigService as any).createDockerClient("localhost:2375");

      expect(require("dockerode")).toHaveBeenCalledWith({
        host: "localhost",
        port: 2375,
        protocol: "http",
      });
    });
  });

  describe("getDefaultDockerHost", () => {
    it("should return Windows pipe for win32 platform", () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", {
        value: "win32",
      });

      const host = (dockerConfigService as any).getDefaultDockerHost();
      expect(host).toBe("//./pipe/docker_engine");

      Object.defineProperty(process, "platform", {
        value: originalPlatform,
      });
    });

    it("should return Unix socket for non-Windows platforms", () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", {
        value: "linux",
      });

      const host = (dockerConfigService as any).getDefaultDockerHost();
      expect(host).toBe("/var/run/docker.sock");

      Object.defineProperty(process, "platform", {
        value: originalPlatform,
      });
    });
  });

  describe("mapErrorToStatus", () => {
    it("should map timeout errors correctly", () => {
      const timeoutError = new Error("Docker API timeout");
      const status = (dockerConfigService as any).mapErrorToStatus(
        timeoutError,
      );
      expect(status).toBe("timeout");
    });

    it("should map connection refused errors correctly", () => {
      const connRefusedError = new Error("connect ECONNREFUSED");
      const status = (dockerConfigService as any).mapErrorToStatus(
        connRefusedError,
      );
      expect(status).toBe("unreachable");
    });

    it("should map generic connection errors correctly", () => {
      const connError = new Error("connection failed");
      const status = (dockerConfigService as any).mapErrorToStatus(connError);
      expect(status).toBe("unreachable");
    });

    it("should default to failed for other errors", () => {
      const genericError = new Error("Some generic error");
      const status = (dockerConfigService as any).mapErrorToStatus(
        genericError,
      );
      expect(status).toBe("failed");
    });

    it("should handle non-Error objects", () => {
      const status = (dockerConfigService as any).mapErrorToStatus("string");
      expect(status).toBe("failed");
    });
  });

  describe("getDockerErrorCode", () => {
    it("should extract HTTP status codes", () => {
      const error = { statusCode: 404 };
      const code = (dockerConfigService as any).getDockerErrorCode(error);
      expect(code).toBe("HTTP_404");
    });

    it("should extract error codes", () => {
      const error = { code: "ECONNREFUSED" };
      const code = (dockerConfigService as any).getDockerErrorCode(error);
      expect(code).toBe("ECONNREFUSED");
    });

    it("should extract errno values", () => {
      const error = { errno: -61 };
      const code = (dockerConfigService as any).getDockerErrorCode(error);
      expect(code).toBe("ERRNO_-61");
    });

    it("should return undefined for non-object errors", () => {
      const code = (dockerConfigService as any).getDockerErrorCode("string");
      expect(code).toBeUndefined();
    });

    it("should return undefined when no error properties found", () => {
      const error = { message: "Some error" };
      const code = (dockerConfigService as any).getDockerErrorCode(error);
      expect(code).toBeUndefined();
    });
  });

  describe("set method override", () => {
    it("should call parent set method and invalidate Docker client", async () => {
      // Mock parent set method
      const parentSetSpy = jest.spyOn(
        Object.getPrototypeOf(Object.getPrototypeOf(dockerConfigService)),
        "set",
      );
      parentSetSpy.mockResolvedValue(undefined);

      await dockerConfigService.set("host", "tcp://localhost:2375", "user1");

      expect(parentSetSpy).toHaveBeenCalledWith(
        "host",
        "tcp://localhost:2375",
        "user1",
      );

      // Verify client was invalidated
      expect((dockerConfigService as any).docker).toBeNull();

      expect(mockLogger.info).toHaveBeenCalledWith(
        {
          key: "host",
          userId: "user1",
        },
        "Docker configuration updated, client cache invalidated",
      );

      parentSetSpy.mockRestore();
    });
  });

  describe("Docker API method delegation", () => {
    beforeEach(() => {
      // Set up a Docker client mock
      (dockerConfigService as any).docker = mockDocker;
    });

    it("should delegate getDockerInfo to Docker client", async () => {
      const mockInfo = {
        Containers: 5,
        Images: 10,
        OperatingSystem: "Ubuntu",
      };
      mockDocker.info.mockResolvedValue(mockInfo);

      // Mock getDockerClient to return the mocked docker instance
      mockPrisma.systemSettings.findUnique = jest.fn().mockResolvedValue(null);

      const result = await dockerConfigService.getDockerInfo();

      expect(result).toEqual(mockInfo);
      expect(mockDocker.info).toHaveBeenCalled();
    });

    it("should delegate getDockerVersion to Docker client", async () => {
      const mockVersion = {
        Version: "20.10.8",
        ApiVersion: "1.41",
      };
      mockDocker.version.mockResolvedValue(mockVersion);

      mockPrisma.systemSettings.findUnique = jest.fn().mockResolvedValue(null);

      const result = await dockerConfigService.getDockerVersion();

      expect(result).toEqual(mockVersion);
      expect(mockDocker.version).toHaveBeenCalled();
    });

    it("should handle Docker API errors in getDockerInfo", async () => {
      const dockerError = new Error("Docker API error");
      mockDocker.info.mockRejectedValue(dockerError);

      mockPrisma.systemSettings.findUnique = jest.fn().mockResolvedValue(null);

      await expect(dockerConfigService.getDockerInfo()).rejects.toThrow(
        "Docker API error",
      );

      expect(mockLogger.error).toHaveBeenCalledWith(
        {
          error: "Docker API error",
        },
        "Failed to get Docker info",
      );
    });

    it("should handle Docker API errors in getDockerVersion", async () => {
      const dockerError = new Error("Version API error");
      mockDocker.version.mockRejectedValue(dockerError);

      mockPrisma.systemSettings.findUnique = jest.fn().mockResolvedValue(null);

      await expect(dockerConfigService.getDockerVersion()).rejects.toThrow(
        "Version API error",
      );

      expect(mockLogger.error).toHaveBeenCalledWith(
        {
          error: "Version API error",
        },
        "Failed to get Docker version",
      );
    });
  });
});
