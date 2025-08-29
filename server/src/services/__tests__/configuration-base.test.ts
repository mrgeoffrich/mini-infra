import { jest } from "@jest/globals";
import { PrismaClient } from "../../generated/prisma";
import {
  ValidationResult,
  ServiceHealthStatus,
  SettingsCategory,
} from "@mini-infra/types";
import { ConfigurationService } from "../configuration-base";

// Mock logger
jest.mock("../../lib/logger", () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

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

// Import the mock after the jest.mock calls
import mockLogger from "../../lib/logger";

describe("ConfigurationService", () => {
  let configService: TestConfigurationService;

  beforeEach(() => {
    jest.clearAllMocks();
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
      mockPrisma.systemSettings.upsert = jest.fn().mockResolvedValue({
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
      mockPrisma.systemSettings.upsert = jest.fn().mockResolvedValue({
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
      mockPrisma.systemSettings.upsert = jest.fn().mockRejectedValue(dbError);

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
      mockPrisma.systemSettings.upsert = jest
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

      mockPrisma.systemSettings.findUnique = jest
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
      mockPrisma.systemSettings.findUnique = jest.fn().mockResolvedValue(null);

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

      mockPrisma.systemSettings.findUnique = jest
        .fn()
        .mockResolvedValue(mockSetting);

      const result = await configService.get("host");

      expect(result).toBeNull();
    });

    it("should handle database errors", async () => {
      const dbError = new Error("Database query failed");
      mockPrisma.systemSettings.findUnique = jest
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
      mockPrisma.systemSettings.findUnique = jest
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
      mockPrisma.systemSettings.delete = jest.fn().mockResolvedValue({
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
      mockPrisma.systemSettings.delete = jest.fn().mockRejectedValue(dbError);

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
      mockPrisma.systemSettings.delete = jest
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
      mockPrisma.connectivityStatus.create = jest.fn().mockResolvedValue({
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
      mockPrisma.connectivityStatus.create = jest.fn().mockResolvedValue({
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
      mockPrisma.connectivityStatus.create = jest.fn().mockResolvedValue({
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
      mockPrisma.connectivityStatus.create = jest
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
      mockPrisma.connectivityStatus.create = jest
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
      const mockStatus = {
        id: "status-1",
        service: "docker",
        status: "connected",
        responseTimeMs: 150,
        checkedAt: new Date("2023-01-01T12:00:00Z"),
        lastSuccessfulAt: new Date("2023-01-01T12:00:00Z"),
      };

      mockPrisma.connectivityStatus.findFirst = jest
        .fn()
        .mockResolvedValue(mockStatus);

      const result = await (configService as any).getLatestConnectivityStatus();

      expect(result).toEqual(mockStatus);
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
      mockPrisma.connectivityStatus.findFirst = jest
        .fn()
        .mockResolvedValue(null);

      const result = await (configService as any).getLatestConnectivityStatus();

      expect(result).toBeNull();
    });

    it("should handle database errors gracefully", async () => {
      const dbError = new Error("Database query failed");
      mockPrisma.connectivityStatus.findFirst = jest
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
      mockPrisma.connectivityStatus.findFirst = jest
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

  describe("createAuditLog", () => {
    it("should create audit log with all parameters", async () => {
      mockPrisma.settingsAudit.create = jest.fn().mockResolvedValue({
        id: "audit-1",
      });

      await (configService as any).createAuditLog(
        "update",
        "host",
        "old-value",
        "new-value",
        "user1",
        "192.168.1.100",
        "Mozilla/5.0",
        true,
        undefined,
      );

      expect(mockPrisma.settingsAudit.create).toHaveBeenCalledWith({
        data: {
          category: "docker",
          key: "host",
          action: "update",
          oldValue: "old-value",
          newValue: "new-value",
          userId: "user1",
          ipAddress: "192.168.1.100",
          userAgent: "Mozilla/5.0",
          success: true,
          errorMessage: null,
          createdAt: expect.any(Date),
        },
      });
    });

    it("should create audit log with minimal parameters", async () => {
      mockPrisma.settingsAudit.create = jest.fn().mockResolvedValue({
        id: "audit-1",
      });

      await (configService as any).createAuditLog(
        "create",
        "api_token",
        null,
        "[REDACTED]",
        "user2",
      );

      expect(mockPrisma.settingsAudit.create).toHaveBeenCalledWith({
        data: {
          category: "docker",
          key: "api_token",
          action: "create",
          oldValue: null,
          newValue: "[REDACTED]",
          userId: "user2",
          ipAddress: null,
          userAgent: null,
          success: true,
          errorMessage: null,
          createdAt: expect.any(Date),
        },
      });
    });

    it("should create audit log for failed operation", async () => {
      mockPrisma.settingsAudit.create = jest.fn().mockResolvedValue({
        id: "audit-1",
      });

      await (configService as any).createAuditLog(
        "validate",
        "connection",
        null,
        null,
        "user1",
        "127.0.0.1",
        "curl/7.68.0",
        false,
        "Connection refused",
      );

      expect(mockPrisma.settingsAudit.create).toHaveBeenCalledWith({
        data: {
          category: "docker",
          key: "connection",
          action: "validate",
          oldValue: null,
          newValue: null,
          userId: "user1",
          ipAddress: "127.0.0.1",
          userAgent: "curl/7.68.0",
          success: false,
          errorMessage: "Connection refused",
          createdAt: expect.any(Date),
        },
      });
    });

    it("should handle database errors gracefully", async () => {
      const dbError = new Error("Audit log insert failed");
      mockPrisma.settingsAudit.create = jest.fn().mockRejectedValue(dbError);

      // Should not throw
      await expect(
        (configService as any).createAuditLog(
          "update",
          "host",
          "old",
          "new",
          "user1",
        ),
      ).resolves.toBeUndefined();

      expect(mockLogger.error).toHaveBeenCalledWith(
        {
          category: "docker",
          key: "host",
          action: "update",
          error: "Audit log insert failed",
        },
        "Failed to create audit log",
      );
    });

    it("should handle non-Error exceptions", async () => {
      const unknownError = { message: "Unknown audit error" };
      mockPrisma.settingsAudit.create = jest
        .fn()
        .mockRejectedValue(unknownError);

      await expect(
        (configService as any).createAuditLog(
          "delete",
          "host",
          "old",
          null,
          "user1",
        ),
      ).resolves.toBeUndefined();

      expect(mockLogger.error).toHaveBeenCalledWith(
        {
          category: "docker",
          key: "host",
          action: "delete",
          error: "Unknown error",
        },
        "Failed to create audit log",
      );
    });
  });
});
