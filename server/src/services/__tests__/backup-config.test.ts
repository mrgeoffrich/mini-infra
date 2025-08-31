import { jest } from "@jest/globals";
import { PrismaClient } from "../../generated/prisma";
import { BackupConfigService } from "../backup-config";
import { AzureConfigService } from "../azure-config";
import { BackupFormat } from "@mini-infra/types";

// Mock node-cron
const mockCron = {
  validate: jest.fn(),
};
jest.mock("node-cron", () => mockCron);

// Mock logger
jest.mock("../../lib/logger", () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

// Mock AzureConfigService
jest.mock("../azure-config");

// Mock Prisma client
const mockPrisma = {
  postgresDatabase: {
    findFirst: jest.fn(),
  },
  backupConfiguration: {
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
} as unknown as PrismaClient;

// Mock Azure config service
const mockAzureConfigService = {
  testContainerAccess: jest.fn(),
} as unknown as AzureConfigService;

import mockLogger from "../../lib/logger";

describe("BackupConfigService", () => {
  let backupConfigService: BackupConfigService;

  beforeEach(() => {
    jest.clearAllMocks();
    backupConfigService = new BackupConfigService(mockPrisma);
    // Mock the Azure service instance
    (backupConfigService as any).azureConfigService = mockAzureConfigService;
  });

  describe("constructor", () => {
    it("should initialize with Prisma client", () => {
      expect(backupConfigService).toBeInstanceOf(BackupConfigService);
    });
  });

  describe("createBackupConfig", () => {
    const validConfig = {
      schedule: "0 2 * * *",
      azureContainerName: "test-backups",
      azurePathPrefix: "db-backups/",
      retentionDays: 30,
      backupFormat: "custom" as BackupFormat,
      compressionLevel: 6,
      isEnabled: true,
    };

    const mockDatabase = {
      id: "db-123",
      userId: "user-123",
      name: "test-db",
    };

    beforeEach(() => {
      mockCron.validate.mockReturnValue(true);
      mockAzureConfigService.testContainerAccess = jest.fn().mockResolvedValue({
        accessible: true,
        responseTimeMs: 100,
        cached: false,
      });
    });

    it("should create backup configuration successfully", async () => {
      mockPrisma.postgresDatabase.findFirst = jest.fn().mockResolvedValue(mockDatabase);
      mockPrisma.backupConfiguration.findUnique = jest.fn().mockResolvedValue(null);

      const mockCreatedConfig = {
        id: "config-123",
        databaseId: "db-123",
        schedule: validConfig.schedule,
        azureContainerName: validConfig.azureContainerName,
        azurePathPrefix: validConfig.azurePathPrefix,
        retentionDays: validConfig.retentionDays,
        backupFormat: validConfig.backupFormat,
        compressionLevel: validConfig.compressionLevel,
        isEnabled: validConfig.isEnabled,
        lastBackupAt: null,
        nextScheduledAt: new Date("2023-01-01T03:00:00Z"),
        createdAt: new Date("2023-01-01T00:00:00Z"),
        updatedAt: new Date("2023-01-01T00:00:00Z"),
      };

      mockPrisma.backupConfiguration.create = jest.fn().mockResolvedValue(mockCreatedConfig);

      const result = await backupConfigService.createBackupConfig(
        "db-123",
        validConfig,
        "user-123",
      );

      expect(result).toEqual({
        id: "config-123",
        databaseId: "db-123",
        schedule: validConfig.schedule,
        azureContainerName: validConfig.azureContainerName,
        azurePathPrefix: validConfig.azurePathPrefix,
        retentionDays: validConfig.retentionDays,
        backupFormat: validConfig.backupFormat,
        compressionLevel: validConfig.compressionLevel,
        isEnabled: validConfig.isEnabled,
        lastBackupAt: null,
        nextScheduledAt: "2023-01-01T03:00:00.000Z",
        createdAt: "2023-01-01T00:00:00.000Z",
        updatedAt: "2023-01-01T00:00:00.000Z",
      });

      expect(mockPrisma.backupConfiguration.create).toHaveBeenCalledWith({
        data: {
          databaseId: "db-123",
          schedule: validConfig.schedule,
          azureContainerName: validConfig.azureContainerName,
          azurePathPrefix: validConfig.azurePathPrefix,
          retentionDays: validConfig.retentionDays,
          backupFormat: validConfig.backupFormat,
          compressionLevel: validConfig.compressionLevel,
          isEnabled: validConfig.isEnabled,
          nextScheduledAt: expect.any(Date),
        },
      });
    });

    it("should throw error for non-existent database", async () => {
      mockPrisma.postgresDatabase.findFirst = jest.fn().mockResolvedValue(null);

      await expect(
        backupConfigService.createBackupConfig("nonexistent", validConfig, "user-123"),
      ).rejects.toThrow("Database not found or access denied");
    });

    it("should throw error for unauthorized database access", async () => {
      const unauthorizedDb = { ...mockDatabase, userId: "other-user" };
      mockPrisma.postgresDatabase.findFirst = jest.fn().mockResolvedValue(unauthorizedDb);

      await expect(
        backupConfigService.createBackupConfig("db-123", validConfig, "user-123"),
      ).rejects.toThrow("Database not found or access denied");
    });

    it("should throw error for existing backup configuration", async () => {
      mockPrisma.postgresDatabase.findFirst = jest.fn().mockResolvedValue(mockDatabase);
      mockPrisma.backupConfiguration.findUnique = jest.fn().mockResolvedValue({
        id: "existing-config",
      });

      await expect(
        backupConfigService.createBackupConfig("db-123", validConfig, "user-123"),
      ).rejects.toThrow("Backup configuration already exists for this database");
    });

    it("should throw error for invalid cron expression", async () => {
      mockPrisma.postgresDatabase.findFirst = jest.fn().mockResolvedValue(mockDatabase);
      mockPrisma.backupConfiguration.findUnique = jest.fn().mockResolvedValue(null);
      mockCron.validate.mockReturnValue(false);

      const invalidConfig = { ...validConfig, schedule: "invalid cron" };

      await expect(
        backupConfigService.createBackupConfig("db-123", invalidConfig, "user-123"),
      ).rejects.toThrow("Invalid cron expression");
    });

    it("should throw error for inaccessible Azure container", async () => {
      mockPrisma.postgresDatabase.findFirst = jest.fn().mockResolvedValue(mockDatabase);
      mockPrisma.backupConfiguration.findUnique = jest.fn().mockResolvedValue(null);
      mockAzureConfigService.testContainerAccess = jest.fn().mockResolvedValue({
        accessible: false,
        error: "Container not found",
      });

      await expect(
        backupConfigService.createBackupConfig("db-123", validConfig, "user-123"),
      ).rejects.toThrow("Azure container 'test-backups' is not accessible: Container not found");
    });

    it("should validate required fields", async () => {
      mockPrisma.postgresDatabase.findFirst = jest.fn().mockResolvedValue(mockDatabase);
      mockPrisma.backupConfiguration.findUnique = jest.fn().mockResolvedValue(null);

      const invalidConfigs = [
        { ...validConfig, azureContainerName: "" },
        { ...validConfig, azurePathPrefix: "" },
        { ...validConfig, retentionDays: 0 },
        { ...validConfig, compressionLevel: -1 },
        { ...validConfig, compressionLevel: 10 },
        { ...validConfig, backupFormat: "invalid" as BackupFormat },
      ];

      for (const invalidConfig of invalidConfigs) {
        await expect(
          backupConfigService.createBackupConfig("db-123", invalidConfig, "user-123"),
        ).rejects.toThrow();
      }
    });

    it("should create configuration without schedule", async () => {
      mockPrisma.postgresDatabase.findFirst = jest.fn().mockResolvedValue(mockDatabase);
      mockPrisma.backupConfiguration.findUnique = jest.fn().mockResolvedValue(null);

      const configWithoutSchedule = {
        azureContainerName: "test-backups",
        azurePathPrefix: "db-backups/",
      };

      const mockCreatedConfig = {
        id: "config-123",
        databaseId: "db-123",
        schedule: null,
        azureContainerName: configWithoutSchedule.azureContainerName,
        azurePathPrefix: configWithoutSchedule.azurePathPrefix,
        retentionDays: 30,
        backupFormat: "custom",
        compressionLevel: 6,
        isEnabled: true,
        lastBackupAt: null,
        nextScheduledAt: null,
        createdAt: new Date("2023-01-01T00:00:00Z"),
        updatedAt: new Date("2023-01-01T00:00:00Z"),
      };

      mockPrisma.backupConfiguration.create = jest.fn().mockResolvedValue(mockCreatedConfig);

      const result = await backupConfigService.createBackupConfig(
        "db-123",
        configWithoutSchedule,
        "user-123",
      );

      expect(result.schedule).toBeNull();
      expect(result.nextScheduledAt).toBeNull();
    });

    it("should create disabled configuration with no next scheduled time", async () => {
      mockPrisma.postgresDatabase.findFirst = jest.fn().mockResolvedValue(mockDatabase);
      mockPrisma.backupConfiguration.findUnique = jest.fn().mockResolvedValue(null);

      const disabledConfig = { ...validConfig, isEnabled: false };

      const mockCreatedConfig = {
        id: "config-123",
        databaseId: "db-123",
        schedule: validConfig.schedule,
        azureContainerName: validConfig.azureContainerName,
        azurePathPrefix: validConfig.azurePathPrefix,
        retentionDays: validConfig.retentionDays,
        backupFormat: validConfig.backupFormat,
        compressionLevel: validConfig.compressionLevel,
        isEnabled: false,
        lastBackupAt: null,
        nextScheduledAt: null,
        createdAt: new Date("2023-01-01T00:00:00Z"),
        updatedAt: new Date("2023-01-01T00:00:00Z"),
      };

      mockPrisma.backupConfiguration.create = jest.fn().mockResolvedValue(mockCreatedConfig);

      const result = await backupConfigService.createBackupConfig(
        "db-123",
        disabledConfig,
        "user-123",
      );

      expect(result.isEnabled).toBe(false);
      expect(result.nextScheduledAt).toBeNull();
    });
  });

  describe("updateBackupConfig", () => {
    const existingConfig = {
      id: "config-123",
      databaseId: "db-123",
      schedule: "0 2 * * *",
      azureContainerName: "test-backups",
      azurePathPrefix: "db-backups/",
      retentionDays: 30,
      backupFormat: "custom",
      compressionLevel: 6,
      isEnabled: true,
      database: {
        id: "db-123",
        userId: "user-123",
      },
    };

    const updateData = {
      schedule: "0 3 * * *",
      retentionDays: 60,
      isEnabled: false,
    };

    beforeEach(() => {
      mockCron.validate.mockReturnValue(true);
      mockAzureConfigService.testContainerAccess = jest.fn().mockResolvedValue({
        accessible: true,
      });
    });

    it("should update backup configuration successfully", async () => {
      mockPrisma.backupConfiguration.findUnique = jest.fn().mockResolvedValue(existingConfig);

      const updatedConfig = {
        ...existingConfig,
        ...updateData,
        nextScheduledAt: null, // Disabled
        updatedAt: new Date("2023-01-01T01:00:00Z"),
      };

      mockPrisma.backupConfiguration.update = jest.fn().mockResolvedValue(updatedConfig);

      const result = await backupConfigService.updateBackupConfig(
        "config-123",
        updateData,
        "user-123",
      );

      expect(result.schedule).toBe(updateData.schedule);
      expect(result.retentionDays).toBe(updateData.retentionDays);
      expect(result.isEnabled).toBe(updateData.isEnabled);
      expect(result.nextScheduledAt).toBeNull();

      expect(mockPrisma.backupConfiguration.update).toHaveBeenCalledWith({
        where: { id: "config-123" },
        data: expect.objectContaining({
          schedule: updateData.schedule,
          retentionDays: updateData.retentionDays,
          isEnabled: updateData.isEnabled,
          nextScheduledAt: null,
          updatedAt: expect.any(Date),
        }),
      });
    });

    it("should throw error for non-existent configuration", async () => {
      mockPrisma.backupConfiguration.findUnique = jest.fn().mockResolvedValue(null);

      await expect(
        backupConfigService.updateBackupConfig("nonexistent", updateData, "user-123"),
      ).rejects.toThrow("Backup configuration not found");
    });

    it("should throw error for unauthorized access", async () => {
      const unauthorizedConfig = {
        ...existingConfig,
        database: { ...existingConfig.database, userId: "other-user" },
      };
      mockPrisma.backupConfiguration.findUnique = jest.fn().mockResolvedValue(unauthorizedConfig);

      await expect(
        backupConfigService.updateBackupConfig("config-123", updateData, "user-123"),
      ).rejects.toThrow("Access denied: You can only update backup configurations for your own databases");
    });

    it("should validate cron expression on update", async () => {
      mockPrisma.backupConfiguration.findUnique = jest.fn().mockResolvedValue(existingConfig);
      mockCron.validate.mockReturnValue(false);

      const invalidUpdate = { schedule: "invalid cron" };

      await expect(
        backupConfigService.updateBackupConfig("config-123", invalidUpdate, "user-123"),
      ).rejects.toThrow("Invalid cron expression");
    });

    it("should validate Azure container on update", async () => {
      mockPrisma.backupConfiguration.findUnique = jest.fn().mockResolvedValue(existingConfig);
      mockAzureConfigService.testContainerAccess = jest.fn().mockResolvedValue({
        accessible: false,
        error: "Container not found",
      });

      const updateWithContainer = { azureContainerName: "new-container" };

      await expect(
        backupConfigService.updateBackupConfig("config-123", updateWithContainer, "user-123"),
      ).rejects.toThrow("Azure container 'new-container' is not accessible");
    });

    it("should validate retention days and compression level", async () => {
      mockPrisma.backupConfiguration.findUnique = jest.fn().mockResolvedValue(existingConfig);

      const invalidUpdates = [
        { retentionDays: 0 },
        { compressionLevel: -1 },
        { compressionLevel: 10 },
      ];

      for (const invalidUpdate of invalidUpdates) {
        await expect(
          backupConfigService.updateBackupConfig("config-123", invalidUpdate, "user-123"),
        ).rejects.toThrow();
      }
    });

    it("should handle schedule removal", async () => {
      mockPrisma.backupConfiguration.findUnique = jest.fn().mockResolvedValue(existingConfig);

      const updatedConfig = {
        ...existingConfig,
        schedule: null,
        nextScheduledAt: null,
        updatedAt: new Date(),
      };

      mockPrisma.backupConfiguration.update = jest.fn().mockResolvedValue(updatedConfig);

      const result = await backupConfigService.updateBackupConfig(
        "config-123",
        { schedule: null },
        "user-123",
      );

      expect(result.schedule).toBeNull();
      expect(result.nextScheduledAt).toBeNull();
    });
  });

  describe("getBackupConfigByDatabaseId", () => {
    const mockConfig = {
      id: "config-123",
      databaseId: "db-123",
      schedule: "0 2 * * *",
      azureContainerName: "test-backups",
      azurePathPrefix: "db-backups/",
      retentionDays: 30,
      backupFormat: "custom",
      compressionLevel: 6,
      isEnabled: true,
      lastBackupAt: new Date("2023-01-01T02:00:00Z"),
      nextScheduledAt: new Date("2023-01-02T02:00:00Z"),
      createdAt: new Date("2023-01-01T00:00:00Z"),
      updatedAt: new Date("2023-01-01T00:00:00Z"),
      database: {
        userId: "user-123",
      },
    };

    it("should return backup configuration", async () => {
      mockPrisma.backupConfiguration.findUnique = jest.fn().mockResolvedValue(mockConfig);

      const result = await backupConfigService.getBackupConfigByDatabaseId(
        "db-123",
        "user-123",
      );

      expect(result).toEqual({
        id: "config-123",
        databaseId: "db-123",
        schedule: "0 2 * * *",
        azureContainerName: "test-backups",
        azurePathPrefix: "db-backups/",
        retentionDays: 30,
        backupFormat: "custom",
        compressionLevel: 6,
        isEnabled: true,
        lastBackupAt: "2023-01-01T02:00:00.000Z",
        nextScheduledAt: "2023-01-02T02:00:00.000Z",
        createdAt: "2023-01-01T00:00:00.000Z",
        updatedAt: "2023-01-01T00:00:00.000Z",
      });
    });

    it("should return null for non-existent configuration", async () => {
      mockPrisma.backupConfiguration.findUnique = jest.fn().mockResolvedValue(null);

      const result = await backupConfigService.getBackupConfigByDatabaseId(
        "nonexistent",
        "user-123",
      );

      expect(result).toBeNull();
    });

    it("should return null for unauthorized access", async () => {
      const unauthorizedConfig = {
        ...mockConfig,
        database: { userId: "other-user" },
      };
      mockPrisma.backupConfiguration.findUnique = jest.fn().mockResolvedValue(unauthorizedConfig);

      const result = await backupConfigService.getBackupConfigByDatabaseId(
        "db-123",
        "user-123",
      );

      expect(result).toBeNull();
    });
  });

  describe("deleteBackupConfig", () => {
    const mockConfig = {
      id: "config-123",
      databaseId: "db-123",
      database: {
        userId: "user-123",
      },
    };

    it("should delete backup configuration successfully", async () => {
      mockPrisma.backupConfiguration.findUnique = jest.fn().mockResolvedValue(mockConfig);
      mockPrisma.backupConfiguration.delete = jest.fn().mockResolvedValue({});

      await backupConfigService.deleteBackupConfig("config-123", "user-123");

      expect(mockPrisma.backupConfiguration.delete).toHaveBeenCalledWith({
        where: { id: "config-123" },
      });

      expect(mockLogger.info).toHaveBeenCalledWith(
        {
          configId: "config-123",
          databaseId: "db-123",
          userId: "user-123",
        },
        "Backup configuration deleted",
      );
    });

    it("should throw error for non-existent configuration", async () => {
      mockPrisma.backupConfiguration.findUnique = jest.fn().mockResolvedValue(null);

      await expect(
        backupConfigService.deleteBackupConfig("nonexistent", "user-123"),
      ).rejects.toThrow("Backup configuration not found");
    });

    it("should throw error for unauthorized access", async () => {
      const unauthorizedConfig = {
        ...mockConfig,
        database: { userId: "other-user" },
      };
      mockPrisma.backupConfiguration.findUnique = jest.fn().mockResolvedValue(unauthorizedConfig);

      await expect(
        backupConfigService.deleteBackupConfig("config-123", "user-123"),
      ).rejects.toThrow("Access denied");
    });
  });

  describe("isValidCronExpression", () => {
    it("should validate correct cron expressions", () => {
      mockCron.validate.mockReturnValue(true);

      const result = backupConfigService.isValidCronExpression("0 2 * * *");

      expect(result).toBe(true);
      expect(mockCron.validate).toHaveBeenCalledWith("0 2 * * *");
    });

    it("should reject invalid cron expressions", () => {
      mockCron.validate.mockReturnValue(false);

      const result = backupConfigService.isValidCronExpression("invalid");

      expect(result).toBe(false);
    });

    it("should handle validation errors", () => {
      mockCron.validate.mockImplementation(() => {
        throw new Error("Validation error");
      });

      const result = backupConfigService.isValidCronExpression("* * * * *");

      expect(result).toBe(false);
    });
  });

  describe("calculateNextScheduledTime", () => {
    it("should calculate next scheduled time for valid cron", () => {
      mockCron.validate.mockReturnValue(true);

      const result = backupConfigService.calculateNextScheduledTime("0 2 * * *");

      expect(result).toBeInstanceOf(Date);
      expect(result!.getMinutes()).toBe(0);
      expect(result!.getSeconds()).toBe(0);
      expect(result!.getMilliseconds()).toBe(0);
    });

    it("should return null for invalid cron expression", () => {
      mockCron.validate.mockReturnValue(false);

      const result = backupConfigService.calculateNextScheduledTime("invalid");

      expect(result).toBeNull();
    });

    it("should handle calculation errors", () => {
      mockCron.validate.mockReturnValue(true);
      // Mock Date constructor to throw (edge case)
      const originalDate = global.Date;
      global.Date = jest.fn().mockImplementation(() => {
        throw new Error("Date error");
      }) as any;

      const result = backupConfigService.calculateNextScheduledTime("0 2 * * *");

      expect(result).toBeNull();
      expect(mockLogger.error).toHaveBeenCalled();

      // Restore Date
      global.Date = originalDate;
    });
  });

  describe("updateLastBackupTime", () => {
    it("should update last backup time successfully", async () => {
      mockPrisma.backupConfiguration.update = jest.fn().mockResolvedValue({});

      await backupConfigService.updateLastBackupTime("config-123");

      expect(mockPrisma.backupConfiguration.update).toHaveBeenCalledWith({
        where: { id: "config-123" },
        data: {
          lastBackupAt: expect.any(Date),
          updatedAt: expect.any(Date),
        },
      });

      expect(mockLogger.debug).toHaveBeenCalledWith(
        {
          configId: "config-123",
          lastBackupAt: expect.any(String),
        },
        "Updated last backup time for configuration",
      );
    });

    it("should handle update errors", async () => {
      mockPrisma.backupConfiguration.update = jest.fn().mockRejectedValue(
        new Error("Database error"),
      );

      await expect(
        backupConfigService.updateLastBackupTime("config-123"),
      ).rejects.toThrow("Database error");

      expect(mockLogger.error).toHaveBeenCalledWith(
        {
          configId: "config-123",
          error: "Database error",
        },
        "Failed to update last backup time",
      );
    });
  });

  describe("calculateRetentionCutoffDate", () => {
    it("should calculate correct cutoff date", () => {
      const fixedDate = new Date("2023-01-15T12:00:00Z");
      const originalDate = global.Date;
      global.Date = jest.fn(() => fixedDate) as any;
      global.Date.prototype = originalDate.prototype;

      const result = backupConfigService.calculateRetentionCutoffDate(7);

      const expectedDate = new Date("2023-01-08T12:00:00Z");
      expect(result).toEqual(expectedDate);

      global.Date = originalDate;
    });

    it("should handle different retention periods", () => {
      const fixedDate = new Date("2023-01-31T12:00:00Z");
      const originalDate = global.Date;
      global.Date = jest.fn(() => fixedDate) as any;
      global.Date.prototype = originalDate.prototype;

      const result30 = backupConfigService.calculateRetentionCutoffDate(30);
      const result90 = backupConfigService.calculateRetentionCutoffDate(90);

      expect(result30.getDate()).toBe(1); // 30 days before Jan 31 = Jan 1
      expect(result90.getMonth()).toBe(9); // 90 days before = October
      expect(result90.getFullYear()).toBe(2022);

      global.Date = originalDate;
    });
  });

  describe("validation edge cases", () => {
    const mockDatabase = { id: "db-123", userId: "user-123" };

    beforeEach(() => {
      mockPrisma.postgresDatabase.findFirst = jest.fn().mockResolvedValue(mockDatabase);
      mockPrisma.backupConfiguration.findUnique = jest.fn().mockResolvedValue(null);
      mockCron.validate.mockReturnValue(true);
      mockAzureConfigService.testContainerAccess = jest.fn().mockResolvedValue({
        accessible: true,
      });
    });

    it("should validate Azure container name length", async () => {
      const shortName = "ab"; // Too short
      const longName = "a".repeat(64); // Too long

      await expect(
        backupConfigService.createBackupConfig(
          "db-123",
          { azureContainerName: shortName, azurePathPrefix: "test/" },
          "user-123",
        ),
      ).rejects.toThrow("Azure container name must be 3-63 characters");

      await expect(
        backupConfigService.createBackupConfig(
          "db-123",
          { azureContainerName: longName, azurePathPrefix: "test/" },
          "user-123",
        ),
      ).rejects.toThrow("Azure container name must be 3-63 characters");
    });

    it("should validate Azure container name format", async () => {
      const invalidNames = [
        "Test", // Capital letters
        "test_container", // Underscores
        "-test", // Starting with hyphen
        "test-", // Ending with hyphen
        "test..container", // Double dots
        "test container", // Spaces
      ];

      for (const invalidName of invalidNames) {
        await expect(
          backupConfigService.createBackupConfig(
            "db-123",
            { azureContainerName: invalidName, azurePathPrefix: "test/" },
            "user-123",
          ),
        ).rejects.toThrow();
      }
    });

    it("should allow valid Azure container names", async () => {
      const validNames = [
        "test",
        "test-container",
        "test123",
        "123test",
        "test-123-container",
      ];

      mockPrisma.backupConfiguration.create = jest.fn().mockResolvedValue({
        id: "config-123",
        databaseId: "db-123",
        schedule: null,
        azureContainerName: "test",
        azurePathPrefix: "test/",
        retentionDays: 30,
        backupFormat: "custom",
        compressionLevel: 6,
        isEnabled: true,
        lastBackupAt: null,
        nextScheduledAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      for (const validName of validNames) {
        await expect(
          backupConfigService.createBackupConfig(
            "db-123",
            { azureContainerName: validName, azurePathPrefix: "test/" },
            "user-123",
          ),
        ).resolves.toBeDefined();
      }
    });

    it("should validate backup format values", async () => {
      const validFormats: BackupFormat[] = ["custom", "plain", "tar"];
      const invalidFormats = ["invalid", "json", "sql"];

      // Valid formats should work
      mockPrisma.backupConfiguration.create = jest.fn().mockResolvedValue({
        id: "config-123",
        databaseId: "db-123",
        schedule: null,
        azureContainerName: "test-container",
        azurePathPrefix: "test/",
        retentionDays: 30,
        backupFormat: "custom",
        compressionLevel: 6,
        isEnabled: true,
        lastBackupAt: null,
        nextScheduledAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      for (const format of validFormats) {
        await expect(
          backupConfigService.createBackupConfig(
            "db-123",
            {
              azureContainerName: "test-container",
              azurePathPrefix: "test/",
              backupFormat: format,
            },
            "user-123",
          ),
        ).resolves.toBeDefined();
      }

      // Invalid formats should fail
      for (const format of invalidFormats) {
        await expect(
          backupConfigService.createBackupConfig(
            "db-123",
            {
              azureContainerName: "test-container",
              azurePathPrefix: "test/",
              backupFormat: format as BackupFormat,
            },
            "user-123",
          ),
        ).rejects.toThrow("Backup format must be 'custom', 'plain', or 'tar'");
      }
    });
  });

  describe("error handling and logging", () => {
    it("should log and rethrow database errors", async () => {
      mockPrisma.postgresDatabase.findFirst = jest.fn().mockRejectedValue(
        new Error("Database connection failed"),
      );

      await expect(
        backupConfigService.createBackupConfig(
          "db-123",
          { azureContainerName: "test", azurePathPrefix: "test/" },
          "user-123",
        ),
      ).rejects.toThrow("Database connection failed");

      expect(mockLogger.error).toHaveBeenCalledWith(
        {
          databaseId: "db-123",
          userId: "user-123",
          error: "Database connection failed",
        },
        "Failed to create backup configuration",
      );
    });

    it("should handle Azure service errors", async () => {
      const mockDatabase = { id: "db-123", userId: "user-123" };
      mockPrisma.postgresDatabase.findFirst = jest.fn().mockResolvedValue(mockDatabase);
      mockPrisma.backupConfiguration.findUnique = jest.fn().mockResolvedValue(null);
      mockCron.validate.mockReturnValue(true);

      mockAzureConfigService.testContainerAccess = jest.fn().mockRejectedValue(
        new Error("Azure service unavailable"),
      );

      await expect(
        backupConfigService.createBackupConfig(
          "db-123",
          { azureContainerName: "test-container", azurePathPrefix: "test/" },
          "user-123",
        ),
      ).rejects.toThrow("Azure service unavailable");
    });
  });
});