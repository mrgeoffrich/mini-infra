import { jest } from "@jest/globals";
import { PrismaClient } from "../../generated/prisma";
import { BackupSchedulerService } from "../backup-scheduler";
import { BackupConfigService } from "../backup-config";
import { BackupExecutorService } from "../backup-executor";

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
const mockBackupConfigService = {} as unknown as BackupConfigService;
const mockBackupExecutorService = {
  initialize: jest.fn(),
  queueBackup: jest.fn(),
  shutdown: jest.fn(),
} as unknown as BackupExecutorService;

describe("BackupSchedulerService - Memory Test", () => {
  let backupSchedulerService: BackupSchedulerService;

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Reset mock objects completely
    mockScheduledTask.start.mockReset();
    mockScheduledTask.stop.mockReset();
    mockScheduledTask.destroy.mockReset();
    
    // Set default mock return values
    mockPrisma.backupConfiguration.findMany = jest.fn().mockResolvedValue([]);
    mockPrisma.backupConfiguration.updateMany = jest.fn().mockResolvedValue({});
    mockCron.validate.mockReturnValue(true);
    mockCron.schedule.mockReturnValue(mockScheduledTask);
    
    backupSchedulerService = new BackupSchedulerService(mockPrisma);

    // Mock service instances
    (backupSchedulerService as any).backupConfigService = mockBackupConfigService;
    (backupSchedulerService as any).backupExecutorService = mockBackupExecutorService;
  });

  afterEach(async () => {
    // Clean up any active schedules and service state
    if (backupSchedulerService) {
      try {
        await backupSchedulerService.shutdown();
      } catch (error) {
        // Ignore shutdown errors in tests
      }
      // Clear the service reference to help GC
      backupSchedulerService = null as any;
    }
    
    // Reset all mock objects completely
    mockScheduledTask.start.mockReset();
    mockScheduledTask.stop.mockReset();
    mockScheduledTask.destroy.mockReset();
    
    // Force garbage collection of mock call history
    jest.clearAllMocks();
    
    // Clear mock return values to prevent accumulation
    mockCron.schedule.mockReset();
    mockCron.validate.mockReset();
    
    // Force mock logger cleanup
    mockLogger.info.mockReset();
    mockLogger.error.mockReset();
    mockLogger.warn.mockReset();
    mockLogger.debug.mockReset();
  });

  describe("basic functionality", () => {
    it("should initialize with Prisma client", () => {
      expect(backupSchedulerService).toBeInstanceOf(BackupSchedulerService);
    });

    it("should register schedule successfully", async () => {
      await backupSchedulerService.registerSchedule("db-123", "0 2 * * *", "user-123");

      expect(mockCron.validate).toHaveBeenCalledWith("0 2 * * *");
      expect(mockCron.schedule).toHaveBeenCalled();
      expect(mockScheduledTask.stop).toHaveBeenCalled(); // Initially stopped

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          databaseId: "db-123",
          schedule: "0 2 * * *",
        }),
        "Backup schedule registered",
      );
    });

    it("should enable schedule successfully", async () => {
      await backupSchedulerService.registerSchedule("db-123", "0 2 * * *", "user-123");
      await backupSchedulerService.enableSchedule("db-123");

      expect(mockScheduledTask.start).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          databaseId: "db-123",
        }),
        "Backup schedule enabled",
      );
    });

    it("should unregister schedule successfully", async () => {
      await backupSchedulerService.registerSchedule("db-123", "0 2 * * *", "user-123");
      await backupSchedulerService.unregisterSchedule("db-123");

      expect(mockScheduledTask.destroy).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(
        { databaseId: "db-123" },
        "Backup schedule unregistered",
      );
    });
  });
});