import { jest } from "@jest/globals";
import { PrismaClient } from "../../generated/prisma";
import { BackupSchedulerService } from "../backup-scheduler";
import { BackupConfigService } from "../backup-config";
import { BackupExecutorService } from "../backup-executor";
import * as cron from "node-cron";

// Mock objects that need to be referenced in tests
const mockScheduledTask = {
  start: jest.fn(),
  stop: jest.fn(),
  destroy: jest.fn(),
};

// Mock node-cron
jest.mock("node-cron", () => ({
  validate: jest.fn(),
  schedule: jest.fn(() => mockScheduledTask),
}));

// Mock services
jest.mock("../backup-config");
jest.mock("../backup-executor");
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    backupConfiguration: {
      findMany: jest.fn(),
      updateMany: jest.fn(),
    },
  },
}));

// Mock logger factory - create the mock instance inline
jest.mock("../../lib/logger-factory", () => {
  const mockLoggerInstance = {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  };
  
  return {
    appLogger: jest.fn(() => mockLoggerInstance),
    servicesLogger: jest.fn(() => mockLoggerInstance),
    httpLogger: jest.fn(() => mockLoggerInstance),
    prismaLogger: jest.fn(() => mockLoggerInstance),
    __esModule: true,
    default: jest.fn(() => mockLoggerInstance),
  };
});

// Get references to the mocked objects
const { servicesLogger } = require("../../lib/logger-factory");
const mockLogger = servicesLogger();
const mockCron = require("node-cron");

// Mock Prisma client
const mockPrisma = {
  backupConfiguration: {
    findMany: jest.fn(),
    updateMany: jest.fn(),
  },
} as unknown as PrismaClient;

// Mock service instances
const mockBackupConfigService = {
  // No specific methods needed for scheduler tests
} as unknown as BackupConfigService;

const mockBackupExecutorService = {
  initialize: jest.fn(),
  queueBackup: jest.fn(),
  shutdown: jest.fn(),
} as unknown as BackupExecutorService;


describe("BackupSchedulerService", () => {
  let backupSchedulerService: BackupSchedulerService;

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Set default mock return values
    mockPrisma.backupConfiguration.findMany = jest.fn().mockResolvedValue([]);
    mockPrisma.backupConfiguration.updateMany = jest.fn().mockResolvedValue({});
    mockCron.validate.mockReturnValue(true);
    
    backupSchedulerService = new BackupSchedulerService(mockPrisma);

    // Mock service instances
    (backupSchedulerService as any).backupConfigService = mockBackupConfigService;
    (backupSchedulerService as any).backupExecutorService = mockBackupExecutorService;
  });

  describe("constructor", () => {
    it("should initialize with Prisma client", () => {
      expect(backupSchedulerService).toBeInstanceOf(BackupSchedulerService);
    });
  });

  describe("initialize", () => {
    const mockBackupConfigs = [
      {
        id: "config-1",
        databaseId: "db-1",
        schedule: "0 2 * * *",
        isEnabled: true,
        database: {
          userId: "user-123",
        },
      },
      {
        id: "config-2",
        databaseId: "db-2",
        schedule: "0 3 * * *",
        isEnabled: false,
        database: {
          userId: "user-456",
        },
      },
    ];

    beforeEach(() => {
      mockBackupExecutorService.initialize = jest.fn().mockResolvedValue(undefined);
      mockPrisma.backupConfiguration.findMany = jest.fn().mockResolvedValue(mockBackupConfigs);
      mockCron.validate.mockReturnValue(true);
      mockPrisma.backupConfiguration.updateMany = jest.fn().mockResolvedValue({});
    });

    it("should initialize successfully and load existing schedules", async () => {
      await backupSchedulerService.initialize();

      expect(mockBackupExecutorService.initialize).toHaveBeenCalled();
      expect(mockPrisma.backupConfiguration.findMany).toHaveBeenCalledWith({
        where: {
          schedule: { not: null },
          isEnabled: true,
        },
        include: {
          database: true,
        },
      });

      expect(mockCron.schedule).toHaveBeenCalledTimes(2);
      expect(mockLogger.info).toHaveBeenCalledWith(
        "BackupSchedulerService initialized successfully",
      );
    });

    it("should handle executor initialization failure", async () => {
      mockBackupExecutorService.initialize = jest.fn().mockRejectedValue(
        new Error("Executor init failed"),
      );

      await expect(backupSchedulerService.initialize()).rejects.toThrow(
        "Executor init failed",
      );

      expect(mockLogger.error).toHaveBeenCalledWith(
        {
          error: "Executor init failed",
        },
        "Failed to initialize BackupSchedulerService",
      );
    });

    it("should not reinitialize if already initialized", async () => {
      await backupSchedulerService.initialize();
      await backupSchedulerService.initialize();

      // Should only call initialize once
      expect(mockBackupExecutorService.initialize).toHaveBeenCalledTimes(1);
    });

    it("should handle database query failure during schedule loading", async () => {
      mockPrisma.backupConfiguration.findMany = jest.fn().mockRejectedValue(
        new Error("Database error"),
      );

      await expect(backupSchedulerService.initialize()).rejects.toThrow(
        "Database error",
      );

      expect(mockLogger.error).toHaveBeenCalledWith(
        {
          error: "Database error",
        },
        "Failed to load existing backup schedules",
      );
    });

    it("should skip invalid schedules during loading", async () => {
      const invalidConfig = {
        id: "config-invalid",
        databaseId: "db-invalid",
        schedule: "invalid-cron",
        isEnabled: true,
        database: {
          userId: "user-123",
        },
      };

      mockPrisma.backupConfiguration.findMany = jest.fn().mockResolvedValue([
        mockBackupConfigs[0],
        invalidConfig,
      ]);

      mockCron.validate.mockImplementation((expr) => expr !== "invalid-cron");

      await backupSchedulerService.initialize();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          databaseId: "db-invalid",
          schedule: "invalid-cron",
        }),
        "Failed to load backup schedule, skipping",
      );

      // Should still initialize successfully
      expect(mockLogger.info).toHaveBeenCalledWith(
        "BackupSchedulerService initialized successfully",
      );
    });
  });

  describe("registerSchedule", () => {
    beforeEach(() => {
      // Reset all mocks
      mockCron.validate.mockReturnValue(true);
      mockCron.schedule.mockReturnValue(mockScheduledTask);
      mockPrisma.backupConfiguration.updateMany = jest.fn().mockResolvedValue({});
      mockBackupExecutorService.initialize = jest.fn().mockResolvedValue(undefined);
    });

    it("should register schedule successfully", async () => {
      await backupSchedulerService.registerSchedule("db-123", "0 2 * * *", "user-123");

      expect(mockCron.validate).toHaveBeenCalledWith("0 2 * * *");
      expect(mockCron.schedule).toHaveBeenCalledWith(
        "0 2 * * *",
        expect.any(Function),
        { timezone: "UTC" },
      );
      expect(mockScheduledTask.stop).toHaveBeenCalled(); // Initially stopped

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          databaseId: "db-123",
          schedule: "0 2 * * *",
        }),
        "Backup schedule registered",
      );
    });

    it("should throw error for invalid cron expression", async () => {
      mockCron.validate.mockReturnValue(false);

      await expect(
        backupSchedulerService.registerSchedule("db-123", "invalid-cron", "user-123"),
      ).rejects.toThrow("Invalid cron expression: invalid-cron");
    });

    it("should replace existing schedule", async () => {
      // Ensure service is initialized first to avoid extra calls during init
      (backupSchedulerService as any).isInitialized = true;
      
      // Clear mocks specifically for this test  
      jest.clearAllMocks();
      
      // Register first schedule
      await backupSchedulerService.registerSchedule("db-123", "0 2 * * *", "user-123");

      // Register second schedule for same database
      await backupSchedulerService.registerSchedule("db-123", "0 3 * * *", "user-123");

      expect(mockCron.schedule).toHaveBeenCalledTimes(4); // 2 actual tasks + 2 temp tasks for calculateNextRunTime  
      expect(mockScheduledTask.stop).toHaveBeenCalledTimes(3); // 2 actual tasks stopped + 1 from destroyed first schedule 
      expect(mockScheduledTask.destroy).toHaveBeenCalledTimes(3); // First schedule destroyed + 2 temp tasks
    });

    it("should initialize if not already initialized", async () => {
      (backupSchedulerService as any).isInitialized = false;

      await backupSchedulerService.registerSchedule("db-123", "0 2 * * *", "user-123");

      expect(mockBackupExecutorService.initialize).toHaveBeenCalled();
    });

    it("should handle registration errors", async () => {
      mockCron.schedule.mockImplementation(() => {
        throw new Error("Schedule creation failed");
      });

      await expect(
        backupSchedulerService.registerSchedule("db-123", "0 2 * * *", "user-123"),
      ).rejects.toThrow("Schedule creation failed");

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          error: "Schedule creation failed",
          databaseId: "db-123",
          schedule: "0 2 * * *",
          userId: "user-123",
        }),
        "Failed to register backup schedule",
      );
    });
  });

  describe("unregisterSchedule", () => {
    beforeEach(() => {
      // Reset all mocks
      mockCron.validate.mockReturnValue(true);
      mockCron.schedule.mockReturnValue(mockScheduledTask);
      mockPrisma.backupConfiguration.updateMany = jest.fn().mockResolvedValue({});
    });

    it("should unregister schedule successfully", async () => {
      // First register a schedule
      await backupSchedulerService.registerSchedule("db-123", "0 2 * * *", "user-123");

      // Then unregister it
      await backupSchedulerService.unregisterSchedule("db-123");

      expect(mockScheduledTask.stop).toHaveBeenCalledTimes(2); // Once during register, once during unregister
      expect(mockScheduledTask.destroy).toHaveBeenCalled();
      expect(mockPrisma.backupConfiguration.updateMany).toHaveBeenCalledWith({
        where: { databaseId: "db-123" },
        data: { nextScheduledAt: null },
      });

      expect(mockLogger.info).toHaveBeenCalledWith(
        { databaseId: "db-123" },
        "Backup schedule unregistered",
      );
    });

    it("should handle unregistering non-existent schedule", async () => {
      // Should not throw error
      await backupSchedulerService.unregisterSchedule("nonexistent");

      // Should not call task methods
      expect(mockScheduledTask.stop).not.toHaveBeenCalled();
      expect(mockScheduledTask.destroy).not.toHaveBeenCalled();
    });

    it("should handle database update failure", async () => {
      // Register a schedule first
      await backupSchedulerService.registerSchedule("db-123", "0 2 * * *", "user-123");

      mockPrisma.backupConfiguration.updateMany = jest.fn().mockRejectedValue(
        new Error("Database error"),
      );

      await expect(
        backupSchedulerService.unregisterSchedule("db-123"),
      ).rejects.toThrow("Database error");

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          error: "Database error",
          databaseId: "db-123",
        }),
        "Failed to unregister backup schedule",
      );
    });
  });

  describe("enableSchedule", () => {
    beforeEach(() => {
      mockCron.validate.mockReturnValue(true);
      mockPrisma.backupConfiguration.updateMany = jest.fn().mockResolvedValue({});
    });

    it("should enable schedule successfully", async () => {
      // Register schedule first
      await backupSchedulerService.registerSchedule("db-123", "0 2 * * *", "user-123");

      // Enable it
      await backupSchedulerService.enableSchedule("db-123");

      expect(mockScheduledTask.start).toHaveBeenCalled();
      expect(mockPrisma.backupConfiguration.updateMany).toHaveBeenCalledWith({
        where: { databaseId: "db-123" },
        data: { nextScheduledAt: expect.any(Date) },
      });

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          databaseId: "db-123",
          nextScheduledAt: expect.any(String),
        }),
        "Backup schedule enabled",
      );
    });

    it("should throw error for non-existent schedule", async () => {
      await expect(
        backupSchedulerService.enableSchedule("nonexistent"),
      ).rejects.toThrow("Schedule not found for database");
    });

    it("should not enable already enabled schedule", async () => {
      // Register and enable schedule
      await backupSchedulerService.registerSchedule("db-123", "0 2 * * *", "user-123");
      await backupSchedulerService.enableSchedule("db-123");

      // Clear mocks to test second enable call
      jest.clearAllMocks();

      // Try to enable again
      await backupSchedulerService.enableSchedule("db-123");

      // Should not call start again
      expect(mockScheduledTask.start).not.toHaveBeenCalled();
    });
  });

  describe("disableSchedule", () => {
    beforeEach(() => {
      mockCron.validate.mockReturnValue(true);
      mockPrisma.backupConfiguration.updateMany = jest.fn().mockResolvedValue({});
    });

    it("should disable schedule successfully", async () => {
      // Register and enable schedule first
      await backupSchedulerService.registerSchedule("db-123", "0 2 * * *", "user-123");
      await backupSchedulerService.enableSchedule("db-123");

      // Clear mocks to test disable
      jest.clearAllMocks();

      // Disable it
      await backupSchedulerService.disableSchedule("db-123");

      expect(mockScheduledTask.stop).toHaveBeenCalled();
      expect(mockPrisma.backupConfiguration.updateMany).toHaveBeenCalledWith({
        where: { databaseId: "db-123" },
        data: { nextScheduledAt: null },
      });

      expect(mockLogger.info).toHaveBeenCalledWith(
        { databaseId: "db-123" },
        "Backup schedule disabled",
      );
    });

    it("should throw error for non-existent schedule", async () => {
      await expect(
        backupSchedulerService.disableSchedule("nonexistent"),
      ).rejects.toThrow("Schedule not found for database");
    });

    it("should not disable already disabled schedule", async () => {
      // Register schedule (starts disabled)
      await backupSchedulerService.registerSchedule("db-123", "0 2 * * *", "user-123");

      // Clear mocks to test disable call
      jest.clearAllMocks();

      // Try to disable (should not call stop since already disabled)
      await backupSchedulerService.disableSchedule("db-123");

      expect(mockScheduledTask.stop).not.toHaveBeenCalled();
    });
  });

  describe("getScheduleStatus", () => {
    beforeEach(() => {
      mockCron.validate.mockReturnValue(true);
      mockPrisma.backupConfiguration.updateMany = jest.fn().mockResolvedValue({});
    });

    it("should return status for all schedules", async () => {
      // Register multiple schedules
      await backupSchedulerService.registerSchedule("db-1", "0 2 * * *", "user-123");
      await backupSchedulerService.registerSchedule("db-2", "0 3 * * *", "user-456");
      await backupSchedulerService.enableSchedule("db-1");

      const status = backupSchedulerService.getScheduleStatus();

      expect(status).toHaveLength(2);
      expect(status[0]).toEqual({
        databaseId: "db-1",
        schedule: "0 2 * * *",
        isEnabled: true,
        nextScheduledAt: expect.any(String),
      });
      expect(status[1]).toEqual({
        databaseId: "db-2",
        schedule: "0 3 * * *",
        isEnabled: false,
        nextScheduledAt: expect.any(String),
      });
    });

    it("should return empty array when no schedules", () => {
      const status = backupSchedulerService.getScheduleStatus();

      expect(status).toEqual([]);
    });
  });

  describe("getScheduleStatusForDatabase", () => {
    beforeEach(() => {
      mockCron.validate.mockReturnValue(true);
      mockPrisma.backupConfiguration.updateMany = jest.fn().mockResolvedValue({});
    });

    it("should return status for specific database", async () => {
      await backupSchedulerService.registerSchedule("db-123", "0 2 * * *", "user-123");
      await backupSchedulerService.enableSchedule("db-123");

      const status = backupSchedulerService.getScheduleStatusForDatabase("db-123");

      expect(status).toEqual({
        databaseId: "db-123",
        schedule: "0 2 * * *",
        isEnabled: true,
        nextScheduledAt: expect.any(String),
      });
    });

    it("should return null for non-existent schedule", () => {
      const status = backupSchedulerService.getScheduleStatusForDatabase("nonexistent");

      expect(status).toBeNull();
    });
  });

  describe("executeScheduledBackup", () => {
    beforeEach(() => {
      mockCron.validate.mockReturnValue(true);
      mockPrisma.backupConfiguration.updateMany = jest.fn().mockResolvedValue({});
      mockBackupExecutorService.queueBackup = jest.fn().mockResolvedValue({
        id: "operation-123",
      });
    });

    it("should execute scheduled backup successfully", async () => {
      // Register and enable schedule
      await backupSchedulerService.registerSchedule("db-123", "0 2 * * *", "user-123");
      await backupSchedulerService.enableSchedule("db-123");

      // Get the scheduled function and call it
      const scheduledFunction = mockCron.schedule.mock.calls[0][1];
      await scheduledFunction();

      expect(mockBackupExecutorService.queueBackup).toHaveBeenCalledWith(
        "db-123",
        "scheduled",
        "user-123",
      );

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          databaseId: "db-123",
          operationId: "operation-123",
        }),
        "Scheduled backup queued successfully",
      );
    });

    it("should handle backup execution failure", async () => {
      mockBackupExecutorService.queueBackup = jest.fn().mockRejectedValue(
        new Error("Backup failed"),
      );

      // Register schedule
      await backupSchedulerService.registerSchedule("db-123", "0 2 * * *", "user-123");

      // Get the scheduled function and call it
      const scheduledFunction = mockCron.schedule.mock.calls[0][1];
      await scheduledFunction();

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          error: "Backup failed",
          databaseId: "db-123",
          userId: "user-123",
        }),
        "Failed to execute scheduled backup",
      );
    });

    it("should update next scheduled time after execution", async () => {
      // Register schedule
      await backupSchedulerService.registerSchedule("db-123", "0 2 * * *", "user-123");

      // Get the scheduled function and call it
      const scheduledFunction = mockCron.schedule.mock.calls[0][1];
      await scheduledFunction();

      // Should update next scheduled time
      expect(mockPrisma.backupConfiguration.updateMany).toHaveBeenCalledWith({
        where: { databaseId: "db-123" },
        data: { nextScheduledAt: expect.any(Date) },
      });
    });
  });

  describe("refreshSchedules", () => {
    const mockBackupConfigs = [
      {
        id: "config-1",
        databaseId: "db-1",
        schedule: "0 2 * * *",
        isEnabled: true,
        database: {
          userId: "user-123",
        },
      },
    ];

    beforeEach(() => {
      mockCron.validate.mockReturnValue(true);
      mockPrisma.backupConfiguration.updateMany = jest.fn().mockResolvedValue({});
      mockPrisma.backupConfiguration.findMany = jest.fn().mockResolvedValue(mockBackupConfigs);
      mockBackupExecutorService.initialize = jest.fn().mockResolvedValue(undefined);
    });

    it("should refresh schedules successfully", async () => {
      // Register initial schedule
      await backupSchedulerService.registerSchedule("db-old", "0 1 * * *", "user-123");

      // Refresh schedules
      await backupSchedulerService.refreshSchedules();

      expect(mockLogger.info).toHaveBeenCalledWith("Refreshing backup schedules");
      expect(mockLogger.info).toHaveBeenCalledWith("Backup schedules refreshed successfully");

      // Should have stopped old schedule and loaded new ones
      expect(mockScheduledTask.stop).toHaveBeenCalled();
      expect(mockScheduledTask.destroy).toHaveBeenCalled();
    });

    it("should handle refresh errors", async () => {
      mockPrisma.backupConfiguration.findMany = jest.fn().mockRejectedValue(
        new Error("Database error"),
      );

      await expect(backupSchedulerService.refreshSchedules()).rejects.toThrow(
        "Database error",
      );

      expect(mockLogger.error).toHaveBeenCalledWith(
        {
          error: "Database error",
        },
        "Failed to refresh backup schedules",
      );
    });
  });

  describe("calculateNextRunTime", () => {
    it("should calculate next run time for valid cron", () => {
      mockCron.validate.mockReturnValue(true);

      const result = (backupSchedulerService as any).calculateNextRunTime("0 2 * * *");

      expect(result).toBeInstanceOf(Date);
      // Should be approximately 1 hour from now (simplified calculation)
      const now = new Date();
      const expectedTime = new Date(now.getTime() + 60 * 60 * 1000);
      expect(Math.abs(result.getTime() - expectedTime.getTime())).toBeLessThan(60000); // Within 1 minute
    });

    it("should return null for invalid cron expression", () => {
      mockCron.validate.mockReturnValue(false);

      const result = (backupSchedulerService as any).calculateNextRunTime("invalid");

      expect(result).toBeNull();
    });

    it("should handle calculation errors", () => {
      mockCron.validate.mockReturnValue(true);
      mockCron.schedule.mockImplementation(() => {
        throw new Error("Schedule error");
      });

      const result = (backupSchedulerService as any).calculateNextRunTime("0 2 * * *");

      expect(result).toBeNull();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          error: "Schedule error",
          schedule: "0 2 * * *",
        }),
        "Failed to calculate next run time",
      );
    });
  });

  describe("updateNextScheduledTime", () => {
    it("should update next scheduled time in database", async () => {
      const nextTime = new Date("2023-01-01T02:00:00Z");
      mockPrisma.backupConfiguration.updateMany = jest.fn().mockResolvedValue({});

      await (backupSchedulerService as any).updateNextScheduledTime("db-123", nextTime);

      expect(mockPrisma.backupConfiguration.updateMany).toHaveBeenCalledWith({
        where: { databaseId: "db-123" },
        data: { nextScheduledAt: nextTime },
      });
    });

    it("should handle database update errors gracefully", async () => {
      mockPrisma.backupConfiguration.updateMany = jest.fn().mockRejectedValue(
        new Error("Update failed"),
      );

      // Should not throw, just log warning
      await (backupSchedulerService as any).updateNextScheduledTime("db-123", new Date());

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          error: "Update failed",
          databaseId: "db-123",
        }),
        "Failed to update next scheduled time in database",
      );
    });
  });

  describe("shutdown", () => {
    beforeEach(() => {
      mockCron.validate.mockReturnValue(true);
      mockPrisma.backupConfiguration.updateMany = jest.fn().mockResolvedValue({});
      mockBackupExecutorService.shutdown = jest.fn().mockResolvedValue(undefined);
    });

    it("should shutdown successfully", async () => {
      // Register some schedules first
      await backupSchedulerService.registerSchedule("db-1", "0 2 * * *", "user-123");
      await backupSchedulerService.registerSchedule("db-2", "0 3 * * *", "user-456");

      await backupSchedulerService.shutdown();

      expect(mockScheduledTask.stop).toHaveBeenCalledTimes(4); // 2 during register, 2 during shutdown
      expect(mockScheduledTask.destroy).toHaveBeenCalledTimes(2);
      expect(mockBackupExecutorService.shutdown).toHaveBeenCalled();

      expect(mockLogger.info).toHaveBeenCalledWith(
        "BackupSchedulerService shut down successfully",
      );
    });

    it("should handle shutdown errors", async () => {
      mockBackupExecutorService.shutdown = jest.fn().mockRejectedValue(
        new Error("Shutdown error"),
      );

      await backupSchedulerService.shutdown();

      expect(mockLogger.error).toHaveBeenCalledWith(
        {
          error: "Shutdown error",
        },
        "Error during BackupSchedulerService shutdown",
      );
    });
  });

  describe("timezone handling", () => {
    beforeEach(() => {
      mockCron.validate.mockReturnValue(true);
      mockPrisma.backupConfiguration.updateMany = jest.fn().mockResolvedValue({});
    });

    it("should register schedule with UTC timezone", async () => {
      await backupSchedulerService.registerSchedule("db-123", "0 2 * * *", "user-123");

      expect(mockCron.schedule).toHaveBeenCalledWith(
        "0 2 * * *",
        expect.any(Function),
        { timezone: "UTC" },
      );
    });
  });

  describe("schedule persistence", () => {
    beforeEach(() => {
      mockBackupExecutorService.initialize = jest.fn().mockResolvedValue(undefined);
    });

    it("should load schedules with correct enabled state", async () => {
      const mockConfigs = [
        {
          id: "config-1",
          databaseId: "db-1",
          schedule: "0 2 * * *",
          isEnabled: true,
          database: { userId: "user-123" },
        },
        {
          id: "config-2", 
          databaseId: "db-2",
          schedule: "0 3 * * *",
          isEnabled: false,
          database: { userId: "user-456" },
        },
      ];

      mockPrisma.backupConfiguration.findMany = jest.fn().mockResolvedValue(mockConfigs);
      mockCron.validate.mockReturnValue(true);
      mockPrisma.backupConfiguration.updateMany = jest.fn().mockResolvedValue({});

      await backupSchedulerService.initialize();

      // Check that only enabled schedules are started
      expect(mockScheduledTask.start).toHaveBeenCalledTimes(1); // Only for enabled config

      const allStatus = backupSchedulerService.getScheduleStatus();
      expect(allStatus).toHaveLength(2);
      expect(allStatus.find(s => s.databaseId === "db-1")?.isEnabled).toBe(true);
      expect(allStatus.find(s => s.databaseId === "db-2")?.isEnabled).toBe(false);
    });
  });
});