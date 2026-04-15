import prisma from "../../lib/prisma";
import { PrismaClient } from "../../generated/prisma/client";
import {
  ValidationResult,
  ServiceHealthStatus,
  SettingsCategory,
} from "@mini-infra/types";
import { ConfigurationService } from "../configuration-base";

// Create a single mock logger instance that will be reused
const mockLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
};

// Mock logger factory to always return the same mock instances
vi.mock("../../lib/logger-factory", () => ({
  getLogger: vi.fn(function() { return mockLogger; }),
  clearLoggerCache: vi.fn(),
  createChildLogger: vi.fn(function() { return mockLogger; }),
  selfBackupLogger: vi.fn(function() { return mockLogger; }),
  serializeError: (e: unknown) => e,
  appLogger: vi.fn(function() { return mockLogger; }),
  servicesLogger: vi.fn(function() { return mockLogger; }),
  httpLogger: vi.fn(function() { return mockLogger; }),
  prismaLogger: vi.fn(function() { return mockLogger; }),
  default: vi.fn(function() { return mockLogger; }),
}));

// Mock Prisma client
const mockPrisma = {
  systemSettings: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
  },
  connectivityStatus: {
    create: vi.fn(),
    findFirst: vi.fn(),
  },
} as unknown as typeof prisma;

// Test implementation of abstract ConfigurationService
class TestConfigurationService extends ConfigurationService {
  constructor(prisma: PrismaClient, category: SettingsCategory) {
    super(prisma, category);
  }

  async validate(): Promise<ValidationResult> {
    return {
      isValid: true,
      message: "Test validation successful",
      responseTimeMs: 100,
    };
  }

  async getHealthStatus(): Promise<ServiceHealthStatus> {
    return {
      service: "docker",
      status: "connected",
      lastChecked: new Date(),
    };
  }
}

// Import the mock after the vi.mock calls

describe("ConfigurationService", () => {
  let configService: TestConfigurationService;

  beforeEach(() => {
    vi.clearAllMocks();
    configService = new TestConfigurationService(mockPrisma, "docker");
  });

  describe("Constructor", () => {
    it("should initialize with correct prisma client and category", () => {
      expect((configService as any).prisma).toBe(mockPrisma);
      expect((configService as any).category).toBe("docker");
    });
  });

  describe("set", () => {
    it("should create new setting when not exists", async () => {
      mockPrisma.systemSettings.upsert = vi.fn().mockResolvedValue({
        id: "setting-1",
        category: "docker",
        key: "host",
        value: "tcp://localhost:2375",
      });

      await configService.set("host", "tcp://localhost:2375", "user1");

      expect(mockPrisma.systemSettings.upsert).toHaveBeenCalledWith({
        where: {
          category_key: {
            category: "docker",
            key: "host",
          },
        },
        update: {
          value: "tcp://localhost:2375",
          updatedBy: "user1",
          updatedAt: expect.any(Date),
        },
        create: {
          category: "docker",
          key: "host",
          value: "tcp://localhost:2375",
          createdBy: "user1",
          updatedBy: "user1",
          isEncrypted: false,
          isActive: true,
        },
      });

      expect(mockLogger.info).toHaveBeenCalledWith(
        {
          category: "docker",
          key: "host",
          userId: "user1",
        },
        "Setting updated",
      );
    });

    it("should update existing setting", async () => {
      mockPrisma.systemSettings.upsert = vi.fn().mockResolvedValue({
        id: "setting-1",
        category: "docker",
        key: "host",
        value: "tcp://localhost:2376",
      });

      await configService.set("host", "tcp://localhost:2376", "user1");

      expect(mockPrisma.systemSettings.upsert).toHaveBeenCalledWith({
        where: {
          category_key: {
            category: "docker",
            key: "host",
          },
        },
        update: {
          value: "tcp://localhost:2376",
          updatedBy: "user1",
          updatedAt: expect.any(Date),
        },
        create: {
          category: "docker",
          key: "host",
          value: "tcp://localhost:2376",
          createdBy: "user1",
          updatedBy: "user1",
          isEncrypted: false,
          isActive: true,
        },
      });
    });

    it("should handle database errors", async () => {
      const dbError = new Error("Database connection failed");
      mockPrisma.systemSettings.upsert = vi.fn().mockRejectedValue(dbError);

      await expect(
        configService.set("host", "tcp://localhost:2375", "user1"),
      ).rejects.toThrow("Database connection failed");

      expect(mockLogger.error).toHaveBeenCalledWith(
        {
          category: "docker",
          key: "host",
          error: "Database connection failed",
        },
        "Failed to set configuration value",
      );
    });

    it("should handle non-Error exceptions", async () => {
      const unknownError = "Unknown error";
      mockPrisma.systemSettings.upsert = vi
        .fn()
        .mockRejectedValue(unknownError);

      await expect(
        configService.set("host", "tcp://localhost:2375", "user1"),
      ).rejects.toBe("Unknown error");

      expect(mockLogger.error).toHaveBeenCalledWith(
        {
          category: "docker",
          key: "host",
          error: "Unknown error",
        },
        "Failed to set configuration value",
      );
    });
  });

  describe("get", () => {
    it("should retrieve existing setting", async () => {
      const mockSetting = {
        id: "setting-1",
        category: "docker",
        key: "host",
        value: "tcp://localhost:2375",
        isEncrypted: false,
        isActive: true,
      };

      mockPrisma.systemSettings.findUnique = vi
        .fn()
        .mockResolvedValue(mockSetting);

      const result = await configService.get("host");

      expect(result).toBe("tcp://localhost:2375");
      expect(mockPrisma.systemSettings.findUnique).toHaveBeenCalledWith({
        where: {
          category_key: {
            category: "docker",
            key: "host",
          },
        },
      });
    });

    it("should return null when setting not found", async () => {
      mockPrisma.systemSettings.findUnique = vi.fn().mockResolvedValue(null);

      const result = await configService.get("nonexistent");

      expect(result).toBeNull();
    });

    it("should return null when setting has no value", async () => {
      const mockSetting = {
        id: "setting-1",
        category: "docker",
        key: "host",
        value: "",
        isEncrypted: false,
        isActive: true,
      };

      mockPrisma.systemSettings.findUnique = vi
        .fn()
        .mockResolvedValue(mockSetting);

      const result = await configService.get("host");

      expect(result).toBeNull();
    });

    it("should handle database errors", async () => {
      const dbError = new Error("Database query failed");
      mockPrisma.systemSettings.findUnique = vi
        .fn()
        .mockRejectedValue(dbError);

      await expect(configService.get("host")).rejects.toThrow(
        "Database query failed",
      );

      expect(mockLogger.error).toHaveBeenCalledWith(
        {
          category: "docker",
          key: "host",
          error: "Database query failed",
        },
        "Failed to get configuration value",
      );
    });

    it("should handle non-Error exceptions", async () => {
      const unknownError = { message: "Unknown database error" };
      mockPrisma.systemSettings.findUnique = vi
        .fn()
        .mockRejectedValue(unknownError);

      await expect(configService.get("host")).rejects.toEqual(unknownError);

      expect(mockLogger.error).toHaveBeenCalledWith(
        {
          category: "docker",
          key: "host",
          error: "Unknown error",
        },
        "Failed to get configuration value",
      );
    });
  });

  describe("delete", () => {
    it("should delete existing setting", async () => {
      mockPrisma.systemSettings.delete = vi.fn().mockResolvedValue({
        id: "setting-1",
        category: "docker",
        key: "host",
      });

      await configService.delete("host", "user1");

      expect(mockPrisma.systemSettings.delete).toHaveBeenCalledWith({
        where: {
          category_key: {
            category: "docker",
            key: "host",
          },
        },
      });

      expect(mockLogger.info).toHaveBeenCalledWith(
        {
          category: "docker",
          key: "host",
          userId: "user1",
        },
        "Setting deleted",
      );
    });

    it("should handle database errors", async () => {
      const dbError = new Error("Database delete failed");
      mockPrisma.systemSettings.delete = vi.fn().mockRejectedValue(dbError);

      await expect(configService.delete("host", "user1")).rejects.toThrow(
        "Database delete failed",
      );

      expect(mockLogger.error).toHaveBeenCalledWith(
        {
          category: "docker",
          key: "host",
          error: "Database delete failed",
        },
        "Failed to delete configuration value",
      );
    });

    it("should handle non-Error exceptions", async () => {
      const unknownError = "Delete failed";
      mockPrisma.systemSettings.delete = vi
        .fn()
        .mockRejectedValue(unknownError);

      await expect(configService.delete("host", "user1")).rejects.toBe(
        "Delete failed",
      );

      expect(mockLogger.error).toHaveBeenCalledWith(
        {
          category: "docker",
          key: "host",
          error: "Unknown error",
        },
        "Failed to delete configuration value",
      );
    });
  });

  describe("recordConnectivityStatus", () => {
    it("should record successful connectivity status", async () => {
      mockPrisma.connectivityStatus.create = vi.fn().mockResolvedValue({
        id: "status-1",
      });

      await (configService as any).recordConnectivityStatus(
        "connected",
        150,
        undefined,
        undefined,
        { version: "20.10.8" },
        "user1",
      );

      expect(mockPrisma.connectivityStatus.create).toHaveBeenCalledWith({
        data: {
          service: "docker",
          status: "connected",
          responseTimeMs: 150,
          errorMessage: null,
          errorCode: null,
          metadata: JSON.stringify({ version: "20.10.8" }),
          checkInitiatedBy: "user1",
          checkedAt: expect.any(Date),
          lastSuccessfulAt: expect.any(Date),
        },
      });
    });

    it("should record failed connectivity status", async () => {
      mockPrisma.connectivityStatus.create = vi.fn().mockResolvedValue({
        id: "status-1",
      });

      await (configService as any).recordConnectivityStatus(
        "failed",
        5000,
        "Connection timeout",
        "TIMEOUT",
        undefined,
        "user1",
      );

      expect(mockPrisma.connectivityStatus.create).toHaveBeenCalledWith({
        data: {
          service: "docker",
          status: "failed",
          responseTimeMs: 5000,
          errorMessage: "Connection timeout",
          errorCode: "TIMEOUT",
          metadata: null,
          checkInitiatedBy: "user1",
          checkedAt: expect.any(Date),
          lastSuccessfulAt: null,
        },
      });
    });

    it("should record status without optional parameters", async () => {
      mockPrisma.connectivityStatus.create = vi.fn().mockResolvedValue({
        id: "status-1",
      });

      await (configService as any).recordConnectivityStatus("unreachable");

      expect(mockPrisma.connectivityStatus.create).toHaveBeenCalledWith({
        data: {
          service: "docker",
          status: "unreachable",
          responseTimeMs: null,
          errorMessage: null,
          errorCode: null,
          metadata: null,
          checkInitiatedBy: null,
          checkedAt: expect.any(Date),
          lastSuccessfulAt: null,
        },
      });
    });

    it("should handle database errors gracefully", async () => {
      const dbError = new Error("Database insert failed");
      mockPrisma.connectivityStatus.create = vi
        .fn()
        .mockRejectedValue(dbError);

      // Should not throw
      await expect(
        (configService as any).recordConnectivityStatus("connected"),
      ).resolves.toBeUndefined();

      expect(mockLogger.error).toHaveBeenCalledWith(
        {
          service: "docker",
          status: "connected",
          error: "Database insert failed",
        },
        "Failed to record connectivity status",
      );
    });

    it("should handle non-Error exceptions", async () => {
      const unknownError = { code: "DB_ERROR" };
      mockPrisma.connectivityStatus.create = vi
        .fn()
        .mockRejectedValue(unknownError);

      await expect(
        (configService as any).recordConnectivityStatus("connected"),
      ).resolves.toBeUndefined();

      expect(mockLogger.error).toHaveBeenCalledWith(
        {
          service: "docker",
          status: "connected",
          error: "Unknown error",
        },
        "Failed to record connectivity status",
      );
    });
  });

  describe("getLatestConnectivityStatus", () => {
    it("should retrieve latest connectivity status", async () => {
      const storedRow = {
        id: "status-1",
        service: "docker",
        status: "connected",
        responseTimeMs: 150,
        checkedAt: new Date("2023-01-01T12:00:00Z"),
        lastSuccessfulAt: new Date("2023-01-01T12:00:00Z"),
        errorMessage: null,
        errorCode: null,
        metadata: null,
      };

      mockPrisma.connectivityStatus.findFirst = vi
        .fn()
        .mockResolvedValue(storedRow);

      const result = await (configService as any).getLatestConnectivityStatus();

      // The method projects the raw Prisma row into a narrow DTO —
      // `id`/`service` are dropped (service is always `this.category`)
      // and nullable fields become `undefined` to match the public shape.
      expect(result).toEqual({
        status: "connected",
        responseTimeMs: 150,
        checkedAt: new Date("2023-01-01T12:00:00Z"),
        lastSuccessfulAt: new Date("2023-01-01T12:00:00Z"),
        errorMessage: undefined,
        errorCode: undefined,
        metadata: undefined,
      });
      expect(mockPrisma.connectivityStatus.findFirst).toHaveBeenCalledWith({
        where: {
          service: "docker",
        },
        orderBy: {
          checkedAt: "desc",
        },
      });
    });

    it("should return null when no status exists", async () => {
      mockPrisma.connectivityStatus.findFirst = vi
        .fn()
        .mockResolvedValue(null);

      const result = await (configService as any).getLatestConnectivityStatus();

      expect(result).toBeNull();
    });

    it("should handle database errors gracefully", async () => {
      const dbError = new Error("Database query failed");
      mockPrisma.connectivityStatus.findFirst = vi
        .fn()
        .mockRejectedValue(dbError);

      const result = await (configService as any).getLatestConnectivityStatus();

      expect(result).toBeNull();
      expect(mockLogger.error).toHaveBeenCalledWith(
        {
          service: "docker",
          error: "Database query failed",
        },
        "Failed to get latest connectivity status",
      );
    });

    it("should handle non-Error exceptions", async () => {
      const unknownError = "Query error";
      mockPrisma.connectivityStatus.findFirst = vi
        .fn()
        .mockRejectedValue(unknownError);

      const result = await (configService as any).getLatestConnectivityStatus();

      expect(result).toBeNull();
      expect(mockLogger.error).toHaveBeenCalledWith(
        {
          service: "docker",
          error: "Unknown error",
        },
        "Failed to get latest connectivity status",
      );
    });
  });
});
