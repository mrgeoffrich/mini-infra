import prisma from "../../lib/prisma";
import { PrismaClient } from "../../generated/prisma/client";
import { BackupSchedulerService, BackupConfigurationManager, BackupExecutorService } from "../backup";
import * as loggerFactory from "../../lib/logger-factory";
import * as nodeCron from "node-cron";

// Hoist mock variables used inside vi.mock() factory functions
const { mockScheduledTask } = vi.hoisted(() => ({
  mockScheduledTask: {
    start: vi.fn(),
    stop: vi.fn(),
    destroy: vi.fn(),
  },
}));

// Mock node-cron
vi.mock("node-cron", () => ({
  validate: vi.fn(),
  schedule: vi.fn(function() { return mockScheduledTask; }),
}));

// Mock services
vi.mock("../backup/backup-configuration-manager");
vi.mock("../backup/backup-executor");
vi.mock("../../lib/prisma", () => ({
  default: {
    backupConfiguration: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

// Mock logger factory - create the mock instance inline
vi.mock("../../lib/logger-factory", () => {
  const mockLoggerInstance = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  };

  return {
    getLogger: vi.fn(function() { return mockLoggerInstance; }),
    clearLoggerCache: vi.fn(),
    createChildLogger: vi.fn(function() { return mockLoggerInstance; }),
    selfBackupLogger: vi.fn(function() { return mockLoggerInstance; }),
    serializeError: (e: unknown) => e,
    appLogger: vi.fn(function() { return mockLoggerInstance; }),
    servicesLogger: vi.fn(function() { return mockLoggerInstance; }),
    httpLogger: vi.fn(function() { return mockLoggerInstance; }),
    prismaLogger: vi.fn(function() { return mockLoggerInstance; }),
    default: vi.fn(function() { return mockLoggerInstance; }),
  };
});

// Get references to the mocked objects
const { servicesLogger } = loggerFactory as any;
const mockLogger = servicesLogger();
const mockCron = nodeCron as any;

// Mock Prisma client
const mockPrisma = {
  backupConfiguration: {
    findMany: vi.fn(),
    updateMany: vi.fn(),
  },
} as unknown as typeof prisma;

// Mock service instances
const mockBackupConfigurationManager = {} as unknown as BackupConfigurationManager;
const mockBackupExecutorService = {
  initialize: vi.fn(),
  queueBackup: vi.fn(),
  shutdown: vi.fn(),
} as unknown as BackupExecutorService;

describe("BackupSchedulerService - Memory Test", () => {
  let backupSchedulerService: BackupSchedulerService;

  beforeEach(() => {
    vi.clearAllMocks();

    // Reset mock objects completely
    mockScheduledTask.start.mockReset();
    mockScheduledTask.stop.mockReset();
    mockScheduledTask.destroy.mockReset();

    // Set default mock return values
    mockPrisma.backupConfiguration.findMany = vi.fn().mockResolvedValue([]);
    mockPrisma.backupConfiguration.updateMany = vi.fn().mockResolvedValue({});
    mockCron.validate.mockReturnValue(true);
    mockCron.schedule.mockReturnValue(mockScheduledTask);

    backupSchedulerService = new BackupSchedulerService(mockPrisma);

    // Mock service instances
    (backupSchedulerService as any).backupConfigService =
      mockBackupConfigurationManager;
    (backupSchedulerService as any).backupExecutorService =
      mockBackupExecutorService;
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
    vi.clearAllMocks();

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
      await backupSchedulerService.registerSchedule(
        "db-123",
        "0 2 * * *",
        "UTC",
        "user-123",
      );

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
      await backupSchedulerService.registerSchedule(
        "db-123",
        "0 2 * * *",
        "UTC",
        "user-123",
      );
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
      await backupSchedulerService.registerSchedule(
        "db-123",
        "0 2 * * *",
        "UTC",
        "user-123",
      );
      await backupSchedulerService.unregisterSchedule("db-123");

      expect(mockScheduledTask.destroy).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(
        { databaseId: "db-123" },
        "Backup schedule unregistered",
      );
    });
  });
});
