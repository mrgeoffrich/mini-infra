import { jest } from "@jest/globals";
import { PrismaClient } from "../../generated/prisma";
import { ProgressTrackerService } from "../progress-tracker";
import {
  BackupProgressUpdate,
  RestoreProgressUpdate,
  BackupOperationStatus,
  RestoreOperationStatus,
} from "@mini-infra/types";

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
  backupOperation: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    deleteMany: jest.fn(),
  },
  restoreOperation: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    deleteMany: jest.fn(),
  },
} as unknown as PrismaClient;


describe("ProgressTrackerService", () => {
  let progressTrackerService: ProgressTrackerService;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.clearAllTimers();
    progressTrackerService = new ProgressTrackerService(mockPrisma);
  });

  afterEach(async () => {
    await progressTrackerService.shutdown();
    jest.useRealTimers();
    jest.clearAllTimers();
  });

  describe("constructor", () => {
    it("should initialize with Prisma client", () => {
      expect(progressTrackerService).toBeInstanceOf(ProgressTrackerService);
    });
  });

  describe("initialize", () => {
    it("should initialize successfully", async () => {
      await progressTrackerService.initialize();

      expect(mockLogger.info).toHaveBeenCalledWith(
        "ProgressTrackerService initialized successfully",
      );
    });

    it("should start periodic cleanup", async () => {
      await progressTrackerService.initialize();

      // Verify that cleanup interval is set
      expect((progressTrackerService as any).cleanupIntervalId).toBeTruthy();
    });

    it("should not reinitialize if already initialized", async () => {
      await progressTrackerService.initialize();
      await progressTrackerService.initialize();

      // Should only log initialization once
      expect(mockLogger.info).toHaveBeenCalledTimes(1);
    });
  });

  describe("getBackupProgress", () => {
    const mockBackupOperation = {
      id: "operation-123",
      databaseId: "db-123",
      operationType: "manual",
      status: "running",
      progress: 75,
      startedAt: new Date("2023-01-01T00:00:00Z"),
      completedAt: null,
      sizeBytes: BigInt(1000000),
      azureBlobUrl: null,
      errorMessage: null,
      metadata:
        '{"currentStep": "uploading", "totalSteps": 5, "completedSteps": 3}',
      database: {
        name: "test-db",
      },
    };

    it("should return backup operation progress", async () => {
      mockPrisma.backupOperation.findFirst = jest
        .fn()
        .mockResolvedValue(mockBackupOperation);

      const result = await progressTrackerService.getBackupProgress(
        "operation-123",
        "user-123",
      );

      expect(result).toEqual({
        id: "operation-123",
        databaseId: "db-123",
        status: "running",
        progress: 75,
        startedAt: "2023-01-01T00:00:00.000Z",
        errorMessage: undefined,
        metadata: {
          currentStep: "uploading",
          totalSteps: 5,
          completedSteps: 3,
        },
        currentStep: "uploading",
        totalSteps: 5,
        completedSteps: 3,
      });

      expect(mockPrisma.backupOperation.findFirst).toHaveBeenCalledWith({
        where: {
          id: "operation-123",
          database: {
            userId: "user-123",
          },
        },
        include: {
          database: {
            select: {
              name: true,
            },
          },
        },
      });
    });

    it("should return null for non-existent operation", async () => {
      mockPrisma.backupOperation.findFirst = jest.fn().mockResolvedValue(null);

      const result = await progressTrackerService.getBackupProgress(
        "nonexistent",
        "user-123",
      );

      expect(result).toBeNull();
    });

    it("should handle invalid metadata gracefully", async () => {
      const operationWithInvalidMetadata = {
        ...mockBackupOperation,
        metadata: "invalid-json",
      };

      mockPrisma.backupOperation.findFirst = jest
        .fn()
        .mockResolvedValue(operationWithInvalidMetadata);

      const result = await progressTrackerService.getBackupProgress(
        "operation-123",
        "user-123",
      );

      expect(result?.metadata).toBeUndefined();
      expect(mockLogger.debug).toHaveBeenCalledWith(
        { operationId: "operation-123" },
        "Failed to parse backup operation metadata",
      );
    });

    it("should handle database query errors", async () => {
      mockPrisma.backupOperation.findFirst = jest
        .fn()
        .mockRejectedValue(new Error("Database error"));

      await expect(
        progressTrackerService.getBackupProgress("operation-123", "user-123"),
      ).rejects.toThrow("Database error");

      expect(mockLogger.error).toHaveBeenCalledWith(
        {
          error: "Database error",
          operationId: "operation-123",
          userId: "user-123",
        },
        "Failed to get backup progress",
      );
    });
  });

  describe("getRestoreProgress", () => {
    const mockRestoreOperation = {
      id: "operation-456",
      databaseId: "db-456",
      backupUrl: "https://account.blob.core.windows.net/container/backup.sql",
      status: "running",
      progress: 60,
      startedAt: new Date("2023-01-01T01:00:00Z"),
      completedAt: null,
      errorMessage: null,
      database: {
        name: "restore-test-db",
      },
    };

    it("should return restore operation progress", async () => {
      mockPrisma.restoreOperation.findFirst = jest
        .fn()
        .mockResolvedValue(mockRestoreOperation);

      const result = await progressTrackerService.getRestoreProgress(
        "operation-456",
        "user-456",
      );

      expect(result).toEqual({
        id: "operation-456",
        databaseId: "db-456",
        status: "running",
        progress: 60,
        startedAt: "2023-01-01T01:00:00.000Z",
        backupUrl: "https://account.blob.core.windows.net/container/backup.sql",
        errorMessage: undefined,
      });
    });

    it("should return null for non-existent operation", async () => {
      mockPrisma.restoreOperation.findFirst = jest.fn().mockResolvedValue(null);

      const result = await progressTrackerService.getRestoreProgress(
        "nonexistent",
        "user-456",
      );

      expect(result).toBeNull();
    });
  });

  describe("getActiveOperations", () => {
    const mockActiveBackups = [
      {
        id: "backup-1",
        databaseId: "db-1",
        operationType: "manual",
        status: "running",
        progress: 50,
        startedAt: new Date("2023-01-01T00:00:00Z"),
        completedAt: null,
        sizeBytes: null,
        azureBlobUrl: null,
        errorMessage: null,
        metadata: null,
        database: { name: "test-db-1" },
      },
    ];

    const mockActiveRestores = [
      {
        id: "restore-1",
        databaseId: "db-2",
        backupUrl: "https://account.blob.core.windows.net/container/backup.sql",
        status: "pending",
        progress: 0,
        startedAt: new Date("2023-01-01T01:00:00Z"),
        completedAt: null,
        errorMessage: null,
        database: { name: "test-db-2" },
      },
    ];

    it("should return active operations for user", async () => {
      mockPrisma.backupOperation.findMany = jest
        .fn()
        .mockResolvedValue(mockActiveBackups);
      mockPrisma.restoreOperation.findMany = jest
        .fn()
        .mockResolvedValue(mockActiveRestores);

      const result =
        await progressTrackerService.getActiveOperations("user-123");

      expect(result.backupOperations).toHaveLength(1);
      expect(result.restoreOperations).toHaveLength(1);

      expect(result.backupOperations[0]).toEqual({
        id: "backup-1",
        databaseId: "db-1",
        status: "running",
        progress: 50,
        startedAt: "2023-01-01T00:00:00.000Z",
        errorMessage: undefined,
      });

      expect(result.restoreOperations[0]).toEqual({
        id: "restore-1",
        databaseId: "db-2",
        status: "pending",
        progress: 0,
        startedAt: "2023-01-01T01:00:00.000Z",
        backupUrl: "https://account.blob.core.windows.net/container/backup.sql",
        errorMessage: undefined,
      });
    });

    it("should handle query errors", async () => {
      mockPrisma.backupOperation.findMany = jest
        .fn()
        .mockRejectedValue(new Error("Database error"));

      await expect(
        progressTrackerService.getActiveOperations("user-123"),
      ).rejects.toThrow("Database error");
    });
  });

  describe("getOperationHistory", () => {
    const mockBackupOperations = [
      {
        id: "backup-1",
        databaseId: "db-1",
        operationType: "manual",
        status: "completed",
        progress: 100,
        startedAt: new Date("2023-01-01T00:00:00Z"),
        completedAt: new Date("2023-01-01T01:00:00Z"),
        sizeBytes: BigInt(1000000),
        azureBlobUrl:
          "https://account.blob.core.windows.net/backups/backup.sql",
        errorMessage: null,
        metadata: null,
        database: { name: "test-db-1" },
      },
    ];

    const mockRestoreOperations = [
      {
        id: "restore-1",
        databaseId: "db-2",
        backupUrl: "https://account.blob.core.windows.net/container/backup.sql",
        status: "failed",
        progress: 25,
        startedAt: new Date("2023-01-01T02:00:00Z"),
        completedAt: null,
        errorMessage: "Restore failed",
        database: { name: "test-db-2" },
      },
    ];

    it("should return operation history with all operations", async () => {
      mockPrisma.backupOperation.findMany = jest
        .fn()
        .mockResolvedValue(mockBackupOperations);
      mockPrisma.restoreOperation.findMany = jest
        .fn()
        .mockResolvedValue(mockRestoreOperations);

      const result = await progressTrackerService.getOperationHistory({
        userId: "user-123",
        limit: 10,
        offset: 0,
      });

      expect(result.operations).toHaveLength(2);
      expect(result.totalCount).toBe(2);
      expect(result.hasMore).toBe(false);

      // Operations should be sorted by startedAt descending
      expect(result.operations[0].id).toBe("restore-1"); // Started at 02:00
      expect(result.operations[1].id).toBe("backup-1"); // Started at 00:00
    });

    it("should filter by operation type", async () => {
      mockPrisma.backupOperation.findMany = jest
        .fn()
        .mockResolvedValue(mockBackupOperations);
      mockPrisma.restoreOperation.findMany = jest.fn().mockResolvedValue([]);

      const result = await progressTrackerService.getOperationHistory({
        operationType: "backup",
        limit: 10,
      });

      expect(mockPrisma.backupOperation.findMany).toHaveBeenCalled();
      expect(mockPrisma.restoreOperation.findMany).not.toHaveBeenCalled();
      expect(result.operations).toHaveLength(1);
      expect(result.operations[0].type).toBe("backup");
    });

    it("should filter by database ID", async () => {
      mockPrisma.backupOperation.findMany = jest
        .fn()
        .mockResolvedValue(mockBackupOperations);
      mockPrisma.restoreOperation.findMany = jest.fn().mockResolvedValue([]);

      await progressTrackerService.getOperationHistory({
        databaseId: "db-1",
      });

      expect(mockPrisma.backupOperation.findMany).toHaveBeenCalledWith({
        where: expect.objectContaining({
          databaseId: "db-1",
        }),
        include: expect.any(Object),
        orderBy: { startedAt: "desc" },
        take: 100, // limit * 2
      });
    });

    it("should filter by status", async () => {
      mockPrisma.backupOperation.findMany = jest.fn().mockResolvedValue([]);
      mockPrisma.restoreOperation.findMany = jest.fn().mockResolvedValue([]);

      await progressTrackerService.getOperationHistory({
        status: "completed",
      });

      expect(mockPrisma.backupOperation.findMany).toHaveBeenCalledWith({
        where: expect.objectContaining({
          status: "completed",
        }),
        include: expect.any(Object),
        orderBy: { startedAt: "desc" },
        take: 100,
      });
    });

    it("should filter by date range", async () => {
      const startDate = new Date("2023-01-01T00:00:00Z");
      const endDate = new Date("2023-01-02T00:00:00Z");

      mockPrisma.backupOperation.findMany = jest.fn().mockResolvedValue([]);
      mockPrisma.restoreOperation.findMany = jest.fn().mockResolvedValue([]);

      await progressTrackerService.getOperationHistory({
        startedAfter: startDate,
        startedBefore: endDate,
      });

      expect(mockPrisma.backupOperation.findMany).toHaveBeenCalledWith({
        where: expect.objectContaining({
          startedAt: {
            gte: startDate,
            lte: endDate,
          },
        }),
        include: expect.any(Object),
        orderBy: { startedAt: "desc" },
        take: 100,
      });
    });

    it("should apply pagination", async () => {
      // Create many operations to test pagination
      const manyOperations = Array.from({ length: 60 }, (_, i) => ({
        id: `backup-${i}`,
        databaseId: "db-1",
        operationType: "manual",
        status: "completed",
        progress: 100,
        startedAt: new Date(2023, 0, 1 + (i % 31), 0, 0, 0), // Cycle through valid days
        completedAt: new Date(2023, 0, 1 + (i % 31), 1, 0, 0), // Cycle through valid days
        sizeBytes: BigInt(1000000),
        azureBlobUrl:
          "https://account.blob.core.windows.net/backups/backup.sql",
        errorMessage: null,
        metadata: null,
        database: { name: "test-db" },
      }));

      mockPrisma.backupOperation.findMany = jest
        .fn()
        .mockResolvedValue(manyOperations);
      mockPrisma.restoreOperation.findMany = jest.fn().mockResolvedValue([]);
      mockPrisma.backupOperation.count = jest.fn().mockResolvedValue(60);
      mockPrisma.restoreOperation.count = jest.fn().mockResolvedValue(0);

      const result = await progressTrackerService.getOperationHistory({
        limit: 20,
        offset: 10,
      });

      expect(result.operations).toHaveLength(20);
      expect(result.totalCount).toBe(60);
      expect(result.hasMore).toBe(true);
    });

    it("should handle query errors", async () => {
      mockPrisma.backupOperation.findMany = jest
        .fn()
        .mockRejectedValue(new Error("Database error"));

      await expect(
        progressTrackerService.getOperationHistory({}),
      ).rejects.toThrow("Database error");

      expect(mockLogger.error).toHaveBeenCalledWith(
        {
          error: "Database error",
          filter: {},
        },
        "Failed to get operation history",
      );
    });
  });

  describe("broadcastProgressUpdate", () => {
    const backupUpdate: BackupProgressUpdate = {
      operationId: "backup-123",
      status: "running",
      progress: 50,
      message: "Creating backup",
    };

    const restoreUpdate: RestoreProgressUpdate = {
      operationId: "restore-456",
      status: "completed",
      progress: 100,
      message: "Restore completed",
    };

    it("should emit backup progress events", () => {
      const progressListener = jest.fn();
      progressTrackerService.on("backup-progress", progressListener);

      progressTrackerService.broadcastProgressUpdate("backup", backupUpdate);

      expect(progressListener).toHaveBeenCalledWith(backupUpdate);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        {
          type: "backup",
          operationId: "backup-123",
          status: "running",
          progress: 50,
        },
        "Progress update broadcasted",
      );
    });

    it("should emit restore progress events", () => {
      const progressListener = jest.fn();
      progressTrackerService.on("restore-progress", progressListener);

      progressTrackerService.broadcastProgressUpdate("restore", restoreUpdate);

      expect(progressListener).toHaveBeenCalledWith(restoreUpdate);
    });

    it("should emit operation completed events", () => {
      const completedListener = jest.fn();
      progressTrackerService.on("operation-completed", completedListener);

      progressTrackerService.broadcastProgressUpdate("restore", restoreUpdate);

      expect(completedListener).toHaveBeenCalledWith({
        type: "restore",
        operationId: "restore-456",
      });
    });

    it("should emit operation failed events", () => {
      const failedListener = jest.fn();
      progressTrackerService.on("operation-failed", failedListener);

      const failedUpdate: BackupProgressUpdate = {
        operationId: "backup-123",
        status: "failed",
        progress: 25,
        message: "Backup failed",
      };

      progressTrackerService.broadcastProgressUpdate("backup", failedUpdate);

      expect(failedListener).toHaveBeenCalledWith({
        type: "backup",
        operationId: "backup-123",
        error: "Backup failed",
      });
    });

    it("should handle broadcast errors gracefully", () => {
      const errorListener = jest.fn().mockImplementation(() => {
        throw new Error("Listener error");
      });
      progressTrackerService.on("backup-progress", errorListener);

      // Should not throw
      progressTrackerService.broadcastProgressUpdate("backup", backupUpdate);

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          error: "Listener error",
          type: "backup",
          update: backupUpdate,
        }),
        "Failed to broadcast progress update",
      );
    });
  });

  describe("cleanupOldOperations", () => {
    beforeEach(() => {
      // Mock current time
      jest.setSystemTime(new Date("2023-01-31T12:00:00Z"));
    });

    it("should clean up old operations successfully", async () => {
      mockPrisma.backupOperation.deleteMany = jest
        .fn()
        .mockResolvedValueOnce({ count: 5 }) // Completed operations
        .mockResolvedValueOnce({ count: 3 }); // Failed operations

      mockPrisma.restoreOperation.deleteMany = jest
        .fn()
        .mockResolvedValueOnce({ count: 2 }) // Completed operations
        .mockResolvedValueOnce({ count: 1 }); // Failed operations

      const result = await progressTrackerService.cleanupOldOperations();

      expect(result).toEqual({
        deletedBackupOperations: 8, // 5 + 3
        deletedRestoreOperations: 3, // 2 + 1
      });

      // Verify correct cutoff dates were used
      const expectedCompletedCutoff = new Date("2023-01-24T12:00:00Z"); // 7 days ago
      const expectedFailedCutoff = new Date("2023-01-01T12:00:00Z"); // 30 days ago

      expect(mockPrisma.backupOperation.deleteMany).toHaveBeenCalledWith({
        where: {
          status: "completed",
          completedAt: {
            lt: expectedCompletedCutoff,
          },
        },
      });

      expect(mockPrisma.backupOperation.deleteMany).toHaveBeenCalledWith({
        where: {
          status: "failed",
          startedAt: {
            lt: expectedFailedCutoff,
          },
        },
      });

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          deletedBackupOperations: 8,
          deletedRestoreOperations: 3,
        }),
        "Cleaned up old operations",
      );
    });

    it("should not log when no operations are cleaned up", async () => {
      mockPrisma.backupOperation.deleteMany = jest
        .fn()
        .mockResolvedValue({ count: 0 });
      mockPrisma.restoreOperation.deleteMany = jest
        .fn()
        .mockResolvedValue({ count: 0 });

      const result = await progressTrackerService.cleanupOldOperations();

      expect(result).toEqual({
        deletedBackupOperations: 0,
        deletedRestoreOperations: 0,
      });

      // Should not log cleanup info when nothing was cleaned
      expect(mockLogger.info).not.toHaveBeenCalledWith(
        expect.objectContaining({
          deletedBackupOperations: expect.any(Number),
        }),
        "Cleaned up old operations",
      );
    });

    it("should handle cleanup errors", async () => {
      mockPrisma.backupOperation.deleteMany = jest
        .fn()
        .mockRejectedValue(new Error("Delete error"));

      await expect(
        progressTrackerService.cleanupOldOperations(),
      ).rejects.toThrow("Delete error");

      expect(mockLogger.error).toHaveBeenCalledWith(
        {
          error: "Delete error",
        },
        "Failed to clean up old operations",
      );
    });
  });

  describe("periodic cleanup", () => {
    it("should start periodic cleanup on initialization", async () => {
      await progressTrackerService.initialize();

      expect((progressTrackerService as any).cleanupIntervalId).toBeTruthy();
      expect(mockLogger.debug).toHaveBeenCalledWith(
        {
          cleanupIntervalMs: 60 * 60 * 1000, // 1 hour
        },
        "Periodic cleanup started",
      );
    });

    it("should execute cleanup periodically", async () => {
      // Track all calls to understand the pattern
      const backupCalls: any[] = [];
      const restoreCalls: any[] = [];

      mockPrisma.backupOperation.deleteMany = jest
        .fn()
        .mockImplementation((args) => {
          backupCalls.push(args);
          return Promise.resolve({ count: 0 });
        });
      
      mockPrisma.restoreOperation.deleteMany = jest
        .fn()
        .mockImplementation((args) => {
          restoreCalls.push(args);
          return Promise.resolve({ count: 0 });
        });

      await progressTrackerService.initialize();

      // Fast forward time to trigger cleanup
      jest.advanceTimersByTime(60 * 60 * 1000); // 1 hour

      // Run all pending timers to execute the cleanup callback
      jest.runOnlyPendingTimers();

      // Wait for async operations to complete
      await new Promise(resolve => {
        jest.useRealTimers();
        setTimeout(() => {
          jest.useFakeTimers();
          resolve(void 0);
        }, 50);
      });

      // Should have at least some calls
      expect(mockPrisma.backupOperation.deleteMany).toHaveBeenCalled();
      expect(mockPrisma.restoreOperation.deleteMany).toHaveBeenCalled();
      
      // Check that both completed and failed operations are being cleaned up
      expect(backupCalls.some(call => call.where.status === "completed")).toBe(true);
      expect(backupCalls.some(call => call.where.status === "failed")).toBe(true);
      expect(restoreCalls.some(call => call.where.status === "completed")).toBe(true);
      expect(restoreCalls.some(call => call.where.status === "failed")).toBe(true);
    });

    it("should handle periodic cleanup errors gracefully", async () => {
      let cleanupErrorCount = 0;
      let periodicErrorCount = 0;
      
      // Override the mock logger to track calls
      mockLogger.error = jest.fn().mockImplementation((context, message) => {
        if (message === "Failed to clean up old operations") {
          cleanupErrorCount++;
        } else if (message === "Periodic cleanup failed") {
          periodicErrorCount++;
        }
      });

      mockPrisma.backupOperation.deleteMany = jest
        .fn()
        .mockRejectedValue(new Error("Database error"));

      await progressTrackerService.initialize();

      // Fast forward time to trigger cleanup
      jest.advanceTimersByTime(60 * 60 * 1000);

      // Run all pending timers to execute the cleanup callback
      jest.runOnlyPendingTimers();

      // Wait a bit for async error handling to complete
      await new Promise(resolve => {
        jest.useRealTimers();
        setTimeout(() => {
          jest.useFakeTimers();
          resolve(void 0);
        }, 10);
      });

      // Should log both error types
      expect(cleanupErrorCount).toBeGreaterThan(0);
      expect(periodicErrorCount).toBeGreaterThan(0);
      
      expect(mockLogger.error).toHaveBeenCalledWith(
        {
          error: "Database error",
        },
        "Failed to clean up old operations",
      );
      
      expect(mockLogger.error).toHaveBeenCalledWith(
        {
          error: "Database error",
        },
        "Periodic cleanup failed",
      );
    });
  });

  describe("shutdown", () => {
    it("should shutdown successfully", async () => {
      await progressTrackerService.initialize();

      // Add some event listeners
      const listener = jest.fn();
      progressTrackerService.on("backup-progress", listener);

      await progressTrackerService.shutdown();

      expect((progressTrackerService as any).cleanupIntervalId).toBeNull();
      expect(progressTrackerService.listenerCount("backup-progress")).toBe(0);

      expect(mockLogger.info).toHaveBeenCalledWith(
        "ProgressTrackerService shut down successfully",
      );
    });

    it("should handle shutdown when not initialized", async () => {
      await progressTrackerService.shutdown();

      expect(mockLogger.info).toHaveBeenCalledWith(
        "ProgressTrackerService shut down successfully",
      );
    });
  });

  describe("mapping operations", () => {
    it("should map backup operation to progress with all fields", () => {
      const operation = {
        id: "backup-123",
        databaseId: "db-123",
        operationType: "scheduled",
        status: "completed",
        progress: 100,
        startedAt: new Date("2023-01-01T00:00:00Z"),
        completedAt: new Date("2023-01-01T01:00:00Z"),
        sizeBytes: BigInt(1000000),
        azureBlobUrl:
          "https://account.blob.core.windows.net/backups/backup.sql",
        errorMessage: null,
        metadata: '{"currentStep": "completed", "totalSteps": 5}',
        database: { name: "test-db" },
      };

      const result = (
        progressTrackerService as any
      ).mapBackupOperationToProgress(operation);

      expect(result).toEqual({
        id: "backup-123",
        databaseId: "db-123",
        status: "completed",
        progress: 100,
        startedAt: "2023-01-01T00:00:00.000Z",
        estimatedCompletion: "2023-01-01T01:00:00.000Z",
        errorMessage: undefined,
        metadata: {
          currentStep: "completed",
          totalSteps: 5,
        },
        currentStep: "completed",
        totalSteps: 5,
      });
    });

    it("should map restore operation to progress with all fields", () => {
      const operation = {
        id: "restore-456",
        databaseId: "db-456",
        backupUrl: "https://account.blob.core.windows.net/container/backup.sql",
        status: "running",
        progress: 60,
        startedAt: new Date("2023-01-01T02:00:00Z"),
        completedAt: null,
        errorMessage: null,
        database: { name: "restore-db" },
      };

      const result = (
        progressTrackerService as any
      ).mapRestoreOperationToProgress(operation);

      expect(result).toEqual({
        id: "restore-456",
        databaseId: "db-456",
        status: "running",
        progress: 60,
        startedAt: "2023-01-01T02:00:00.000Z",
        backupUrl: "https://account.blob.core.windows.net/container/backup.sql",
        errorMessage: undefined,
      });
    });

    it("should map backup operation to history item", () => {
      const operation = {
        id: "backup-789",
        databaseId: "db-789",
        operationType: "manual",
        status: "failed",
        progress: 30,
        startedAt: new Date("2023-01-01T03:00:00Z"),
        completedAt: null,
        sizeBytes: null,
        azureBlobUrl: null,
        errorMessage: "Connection failed",
        metadata: null,
        database: { name: "failed-db" },
      };

      const result = (
        progressTrackerService as any
      ).mapBackupOperationToHistoryItem(operation);

      expect(result).toEqual({
        id: "backup-789",
        type: "backup",
        databaseId: "db-789",
        databaseName: "failed-db",
        status: "failed",
        progress: 30,
        startedAt: "2023-01-01T03:00:00.000Z",
        completedAt: null,
        errorMessage: "Connection failed",
        operationType: "manual",
        sizeBytes: null,
      });
    });

    it("should map restore operation to history item", () => {
      const operation = {
        id: "restore-789",
        databaseId: "db-789",
        backupUrl: "https://account.blob.core.windows.net/container/backup.sql",
        status: "completed",
        progress: 100,
        startedAt: new Date("2023-01-01T04:00:00Z"),
        completedAt: new Date("2023-01-01T05:00:00Z"),
        errorMessage: null,
        database: { name: "restored-db" },
      };

      const result = (
        progressTrackerService as any
      ).mapRestoreOperationToHistoryItem(operation);

      expect(result).toEqual({
        id: "restore-789",
        type: "restore",
        databaseId: "db-789",
        databaseName: "restored-db",
        status: "completed",
        progress: 100,
        startedAt: "2023-01-01T04:00:00.000Z",
        completedAt: "2023-01-01T05:00:00.000Z",
        errorMessage: null,
        backupUrl: "https://account.blob.core.windows.net/container/backup.sql",
      });
    });
  });

  describe("event handling edge cases", () => {
    it("should handle failed operations without error message", () => {
      const failedListener = jest.fn();
      progressTrackerService.on("operation-failed", failedListener);

      const updateWithoutMessage: BackupProgressUpdate = {
        operationId: "backup-123",
        status: "failed",
        progress: 0,
      };

      progressTrackerService.broadcastProgressUpdate(
        "backup",
        updateWithoutMessage,
      );

      expect(failedListener).toHaveBeenCalledWith({
        type: "backup",
        operationId: "backup-123",
        error: "Operation failed", // Default message
      });
    });
  });
});
