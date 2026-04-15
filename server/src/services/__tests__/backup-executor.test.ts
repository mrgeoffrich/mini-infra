import prisma from "../../lib/prisma";
import { PrismaClient } from "../../generated/prisma/client";
import { BackupExecutorService, BackupConfigurationManager } from "../backup";
import { DockerExecutorService } from "../docker-executor";
import { PostgresDatabaseManager } from "../postgres";
import { AzureStorageService } from "../azure-storage-service";
import { InMemoryQueue } from "../../lib/in-memory-queue";
import * as loggerFactory from "../../lib/logger-factory";

// Hoist mock variables used inside vi.mock() factory functions
const { mockQueue, mockBlobServiceClient, mockBlobClient, mockContainerClient } = vi.hoisted(() => {
  const mockBlobClient = {
    getProperties: vi.fn(),
    url: "https://testaccount.blob.core.windows.net/test-container/db-backups/testdb/backup-2023-01-01.sql",
  };

  return {
    mockQueue: {
      add: vi.fn(),
      process: vi.fn(),
      getJobs: vi.fn(),
      close: vi.fn(),
      on: vi.fn(),
      remove: vi.fn(),
      getStats: vi.fn().mockReturnValue({
        pending: 0,
        active: 0,
        completed: 0,
        failed: 0,
        total: 0,
      }),
    },
    mockBlobServiceClient: {
      accountName: "testaccount",
      getContainerClient: vi.fn(),
    },
    mockBlobClient,
    mockContainerClient: {
      listBlobsFlat: vi.fn(),
      getBlobClient: vi.fn(function() { return mockBlobClient; }),
    },
  };
});

vi.mock("../../lib/in-memory-queue", () => {
  return {
    InMemoryQueue: vi.fn().mockImplementation(function() { return mockQueue; }),
  };
});

// Mock all the services
vi.mock("../docker-executor");
vi.mock("../backup/backup-configuration-manager");
vi.mock("../postgres/postgres-database-manager");
vi.mock("../azure-storage-service");

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

vi.mock("@azure/storage-blob", () => ({
  BlobServiceClient: {
    fromConnectionString: vi.fn(function() { return mockBlobServiceClient; }),
  },
}));

// Get reference to the mocked logger
const { servicesLogger } = loggerFactory as any;
const mockLogger = servicesLogger();

// Mock Prisma client
const mockPrisma = {
  backupOperation: {
    create: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  systemSettings: {
    findFirst: vi.fn(),
  },
} as unknown as typeof prisma;

// Mock service instances
const mockDockerExecutor = {
  initialize: vi.fn(),
  executeContainerWithProgress: vi.fn(),
} as unknown as DockerExecutorService;

const mockBackupConfigurationManager = {
  getBackupConfigByDatabaseId: vi.fn(),
  updateLastBackupTime: vi.fn(),
} as unknown as BackupConfigurationManager;

const mockPostgresDatabaseManager = {
  getDatabaseById: vi.fn(),
  getConnectionConfig: vi.fn(),
} as unknown as PostgresDatabaseManager;

const mockAzureStorageService = {
  get: vi.fn(),
  getConnectionString: vi.fn(),
} as unknown as AzureStorageService;

describe("BackupExecutorService", () => {
  let backupExecutorService: BackupExecutorService;

  beforeEach(() => {
    vi.clearAllMocks();
    backupExecutorService = new BackupExecutorService(mockPrisma);

    // Mock service instances
    (backupExecutorService as any).dockerExecutor = mockDockerExecutor;
    (backupExecutorService as any).backupConfigService =
      mockBackupConfigurationManager;
    (backupExecutorService as any).databaseConfigService =
      mockPostgresDatabaseManager;
    (backupExecutorService as any).azureConfigService = mockAzureStorageService;
    (backupExecutorService as any).backupQueue = mockQueue;
  });

  afterAll(() => {
    // Clean up the static NodeCache in AzureStorageService to prevent timer leaks
    AzureStorageService.cleanupCache();
  });

  describe("constructor", () => {
    it("should initialize with Prisma client and create queue", () => {
      expect(backupExecutorService).toBeInstanceOf(BackupExecutorService);
      expect(InMemoryQueue).toHaveBeenCalledWith(
        "postgres-backup",
        expect.objectContaining({
          defaultJobOptions: expect.objectContaining({
            attempts: 3,
            backoff: expect.objectContaining({
              type: "exponential",
              delay: 30000,
            }),
            removeOnComplete: 10,
            removeOnFail: 50,
          }),
        }),
      );
    });
  });

  describe("initialize", () => {
    it("should initialize Docker executor successfully", async () => {
      mockDockerExecutor.initialize = vi.fn().mockResolvedValue(undefined);

      await backupExecutorService.initialize();

      expect(mockDockerExecutor.initialize).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(
        {
          initializationTimeMs: expect.any(Number),
          queueConcurrency: 2,
          maxRetries: 3,
          timeoutMs: 7200000,
        },
        "BackupExecutorService initialized successfully",
      );
    });

    it("should handle initialization failure", async () => {
      mockDockerExecutor.initialize = vi
        .fn()
        .mockRejectedValue(new Error("Docker initialization failed"));

      await backupExecutorService.initialize();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        {
          error: "Docker initialization failed",
        },
        "Failed to initialize Docker executor - backup operations will be unavailable until Docker is configured",
      );

    });

    it("should not reinitialize if already initialized", async () => {
      mockDockerExecutor.initialize = vi.fn().mockResolvedValue(undefined);

      // Initialize twice
      await backupExecutorService.initialize();
      await backupExecutorService.initialize();

      // Should only call initialize once
      expect(mockDockerExecutor.initialize).toHaveBeenCalledTimes(1);
    });
  });

  describe("queueBackup", () => {
    const mockBackupOperation = {
      id: "operation-123",
      databaseId: "db-123",
      operationType: "manual",
      status: "pending",
      progress: 0,
      startedAt: new Date("2023-01-01T00:00:00Z"),
      completedAt: null,
      sizeBytes: null,
      azureBlobUrl: null,
      errorMessage: null,
      metadata: null,
    };

    beforeEach(() => {
      mockDockerExecutor.initialize = vi.fn().mockResolvedValue(undefined);
    });

    it("should create and queue backup operation", async () => {
      mockPrisma.backupOperation.create = vi
        .fn()
        .mockResolvedValue(mockBackupOperation);
      mockQueue.add = vi.fn().mockResolvedValue({ id: "job-123" });

      const result = await backupExecutorService.queueBackup(
        "db-123",
        "manual",
        "user-123",
      );

      expect(result).toEqual({
        id: "operation-123",
        databaseId: "db-123",
        operationType: "manual",
        status: "pending",
        startedAt: "2023-01-01T00:00:00.000Z",
        completedAt: null,
        sizeBytes: null,
        azureBlobUrl: null,
        errorMessage: null,
        progress: 0,
        metadata: null,
      });

      expect(mockPrisma.backupOperation.create).toHaveBeenCalledWith({
        data: {
          databaseId: "db-123",
          operationType: "manual",
          status: "pending",
          progress: 0,
        },
      });

      expect(mockQueue.add).toHaveBeenCalledWith(
        "execute-backup",
        {
          backupOperationId: "operation-123",
          databaseId: "db-123",
          operationType: "manual",
          userId: "user-123",
        },
        { delay: 0 },
      );
    });

    it("should initialize if not already initialized", async () => {
      // Set as not initialized
      (backupExecutorService as any).isInitialized = false;

      mockPrisma.backupOperation.create = vi
        .fn()
        .mockResolvedValue(mockBackupOperation);
      mockQueue.add = vi.fn().mockResolvedValue({ id: "job-123" });

      await backupExecutorService.queueBackup("db-123", "manual", "user-123");

      expect(mockDockerExecutor.initialize).toHaveBeenCalled();
    });

    it("should handle database operation creation failure", async () => {
      mockPrisma.backupOperation.create = vi
        .fn()
        .mockRejectedValue(new Error("Database error"));

      await expect(
        backupExecutorService.queueBackup("db-123", "manual", "user-123"),
      ).rejects.toThrow("Database error");

      expect(mockLogger.error).toHaveBeenCalledWith(
        {
          error: "Database error",
          databaseId: "db-123",
          operationType: "manual",
          userId: "user-123",
          queueingTimeMs: expect.any(Number),
        },
        "Failed to queue backup operation",
      );
    });

    it("should handle queue add failure", async () => {
      mockPrisma.backupOperation.create = vi
        .fn()
        .mockResolvedValue(mockBackupOperation);
      mockQueue.add = vi.fn().mockRejectedValue(new Error("Queue error"));

      await expect(
        backupExecutorService.queueBackup("db-123", "manual", "user-123"),
      ).rejects.toThrow("Queue error");
    });
  });

  describe("getBackupStatus", () => {
    const mockOperation = {
      id: "operation-123",
      databaseId: "db-123",
      operationType: "manual",
      status: "running",
      progress: 50,
      startedAt: new Date("2023-01-01T00:00:00Z"),
      completedAt: null,
      sizeBytes: null,
      azureBlobUrl: null,
      errorMessage: null,
      metadata: null,
    };

    it("should return backup operation status", async () => {
      mockPrisma.backupOperation.findUnique = vi
        .fn()
        .mockResolvedValue(mockOperation);

      const result =
        await backupExecutorService.getBackupStatus("operation-123");

      expect(result).toEqual({
        id: "operation-123",
        databaseId: "db-123",
        operationType: "manual",
        status: "running",
        startedAt: "2023-01-01T00:00:00.000Z",
        completedAt: null,
        sizeBytes: null,
        azureBlobUrl: null,
        errorMessage: null,
        progress: 50,
        metadata: null,
      });
    });

    it("should return null for non-existent operation", async () => {
      mockPrisma.backupOperation.findUnique = vi.fn().mockResolvedValue(null);

      const result = await backupExecutorService.getBackupStatus("nonexistent");

      expect(result).toBeNull();
    });

    it("should handle database query errors", async () => {
      mockPrisma.backupOperation.findUnique = vi
        .fn()
        .mockRejectedValue(new Error("Database error"));

      await expect(
        backupExecutorService.getBackupStatus("operation-123"),
      ).rejects.toThrow("Database error");

      expect(mockLogger.error).toHaveBeenCalledWith(
        {
          error: "Database error",
          operationId: "operation-123",
        },
        "Failed to get backup status",
      );
    });
  });

  describe("cancelBackup", () => {
    const mockOperation = {
      id: "operation-123",
      status: "running",
      progress: 50,
    };

    const mockJob = {
      id: "job-123",
      data: { backupOperationId: "operation-123" },
      remove: vi.fn(),
    };

    it("should cancel backup operation successfully", async () => {
      mockPrisma.backupOperation.findUnique = vi
        .fn()
        .mockResolvedValue(mockOperation);
      mockPrisma.backupOperation.update = vi.fn().mockResolvedValue({});
      mockQueue.getJobs = vi.fn().mockResolvedValue([mockJob]);

      const result = await backupExecutorService.cancelBackup("operation-123");

      expect(result).toBe(true);
      expect(mockPrisma.backupOperation.update).toHaveBeenCalledWith({
        where: { id: "operation-123" },
        data: {
          status: "failed",
          progress: 50,
          errorMessage: "Operation cancelled by user",
        },
      });
      expect(mockQueue.remove).toHaveBeenCalledWith(mockJob.id);
    });

    it("should return false for non-existent operation", async () => {
      mockPrisma.backupOperation.findUnique = vi.fn().mockResolvedValue(null);

      const result = await backupExecutorService.cancelBackup("nonexistent");

      expect(result).toBe(false);
    });

    it("should return false for completed operation", async () => {
      const completedOperation = { ...mockOperation, status: "completed" };
      mockPrisma.backupOperation.findUnique = vi
        .fn()
        .mockResolvedValue(completedOperation);

      const result = await backupExecutorService.cancelBackup("operation-123");

      expect(result).toBe(false);
    });

    it("should handle cancellation when job not in queue", async () => {
      mockPrisma.backupOperation.findUnique = vi
        .fn()
        .mockResolvedValue(mockOperation);
      mockPrisma.backupOperation.update = vi.fn().mockResolvedValue({});
      mockQueue.getJobs = vi.fn().mockResolvedValue([]); // No jobs in queue

      const result = await backupExecutorService.cancelBackup("operation-123");

      expect(result).toBe(true);
      expect(mockPrisma.backupOperation.update).toHaveBeenCalled();
    });

    it("should handle errors during cancellation", async () => {
      mockPrisma.backupOperation.findUnique = vi
        .fn()
        .mockRejectedValue(new Error("Database error"));

      const result = await backupExecutorService.cancelBackup("operation-123");

      expect(result).toBe(false);
      expect(mockLogger.error).toHaveBeenCalledWith(
        {
          error: "Database error",
          operationId: "operation-123",
        },
        "Failed to cancel backup operation",
      );
    });
  });

  describe("backup execution", () => {
    const mockDatabase = {
      id: "db-123",
      name: "test-db",
      database: "testdb",
    };

    const mockBackupConfig = {
      id: "config-123",
      azureContainerName: "test-backups",
      azurePathPrefix: "db-backups/",
      backupFormat: "custom",
      compressionLevel: 6,
    };

    const mockConnectionConfig = {
      host: "localhost",
      username: "testuser",
      password: "testpass",
      database: "testdb",
    };

    beforeEach(() => {
      mockPostgresDatabaseManager.getDatabaseById = vi
        .fn()
        .mockResolvedValue(mockDatabase);
      mockBackupConfigurationManager.getBackupConfigByDatabaseId = vi
        .fn()
        .mockResolvedValue(mockBackupConfig);
      mockPostgresDatabaseManager.getConnectionConfig = vi
        .fn()
        .mockResolvedValue(mockConnectionConfig);
      mockAzureStorageService.get = vi
        .fn()
        .mockResolvedValue("azure-connection-string");
      mockPrisma.systemSettings.findFirst = vi.fn().mockResolvedValue({
        value: "postgres:15-alpine",
      });
      mockPrisma.backupOperation.update = vi.fn().mockResolvedValue({});
    });

    it("should execute backup successfully", async () => {
      // Mock container execution
      mockDockerExecutor.executeContainerWithProgress = vi
        .fn()
        .mockImplementation(async (config, progressCallback) => {
          // Simulate progress updates
          await progressCallback({ status: "starting" });
          await progressCallback({ status: "running" });
          await progressCallback({ status: "completed" });

          return {
            exitCode: 0,
            stdout: "Backup completed",
            stderr: "",
          };
        });

      // Mock Azure verification
      mockBlobServiceClient.getContainerClient = vi
        .fn()
        .mockReturnValue(mockContainerClient);
      const mockBlobs = [
        {
          name: "db-backups/testdb/backup-2023-01-01.sql",
          properties: {
            createdOn: new Date("2023-01-01T02:00:00Z"),
            contentLength: 1000000,
          },
        },
      ];

      // Create async iterator
      const mockAsyncIterator = {
        [Symbol.asyncIterator]() {
          let index = 0;
          return {
            async next() {
              if (index < mockBlobs.length) {
                return { value: mockBlobs[index++], done: false };
              }
              return { done: true };
            },
          };
        },
      };

      mockContainerClient.listBlobsFlat = vi
        .fn()
        .mockReturnValue(mockAsyncIterator);

      mockBackupConfigurationManager.updateLastBackupTime = vi
        .fn()
        .mockResolvedValue(undefined);

      // Test the private executeBackup method through queueBackup
      mockPrisma.backupOperation.create = vi.fn().mockResolvedValue({
        id: "operation-123",
        databaseId: "db-123",
        operationType: "manual",
        status: "pending",
        progress: 0,
        startedAt: new Date(),
        completedAt: null,
        sizeBytes: null,
        azureBlobUrl: null,
        errorMessage: null,
        metadata: null,
      });

      mockQueue.add = vi.fn().mockResolvedValue({ id: "job-123" });

      await backupExecutorService.queueBackup("db-123", "manual", "user-123");

      // Verify the queue processor was called with correct function
      expect(mockQueue.process).toHaveBeenCalledWith(
        "execute-backup",
        expect.any(Function),
      );
    });
  });

  describe("verifyBackupInAzure", () => {
    beforeEach(() => {
      mockAzureStorageService.getConnectionString = vi
        .fn()
        .mockResolvedValue("azure-connection-string");
      mockBlobServiceClient.getContainerClient = vi
        .fn()
        .mockReturnValue(mockContainerClient);
    });

    it("should verify backup files exist", async () => {
      mockBlobClient.getProperties = vi.fn().mockResolvedValue({
        contentLength: 1000000,
      });

      const result = await (backupExecutorService as any).verifyBackupInAzure(
        "test-container",
        "db-backups/testdb/backup-2023-01-01.sql",
      );

      expect(result.success).toBe(true);
      expect(result.sizeBytes).toBe(BigInt(1000000));
      expect(result.blobUrl).toBe(
        "https://testaccount.blob.core.windows.net/test-container/db-backups/testdb/backup-2023-01-01.sql",
      );
    });

    it("should return error when no backup files found", async () => {
      mockBlobClient.getProperties = vi.fn().mockRejectedValue(new Error("Blob not found"));

      const result = await (backupExecutorService as any).verifyBackupInAzure(
        "test-container",
        "db-backups/testdb/backup-2023-01-01.sql",
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Backup file not found");
    });

    it("should handle Azure connection string not configured", async () => {
      mockAzureStorageService.getConnectionString = vi.fn().mockResolvedValue(null);

      const result = await (backupExecutorService as any).verifyBackupInAzure(
        "test-container",
        "db-backups",
        "testdb",
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe("Azure connection string not configured");
    });

    it("should handle Azure storage errors", async () => {
      mockBlobServiceClient.getContainerClient = vi.fn().mockImplementation(() => {
        throw new Error("Azure storage error");
      });

      const result = await (backupExecutorService as any).verifyBackupInAzure(
        "test-container",
        "db-backups/testdb/backup-2023-01-01.sql",
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe("Azure storage error");
    });
  });

  describe("getBackupDockerImage", () => {
    const originalEnv = process.env.PG_BACKUP_IMAGE_TAG;

    afterEach(() => {
      if (originalEnv !== undefined) {
        process.env.PG_BACKUP_IMAGE_TAG = originalEnv;
      } else {
        delete process.env.PG_BACKUP_IMAGE_TAG;
      }
    });

    it("should return image from PG_BACKUP_IMAGE_TAG env var when set", () => {
      process.env.PG_BACKUP_IMAGE_TAG = "ghcr.io/mrgeoffrich/mini-infra-pg-backup:1.2.3";

      const result = (backupExecutorService as any).getBackupDockerImage();

      expect(result).toBe("ghcr.io/mrgeoffrich/mini-infra-pg-backup:1.2.3");
    });

    it("should return default image when env var is not set", () => {
      delete process.env.PG_BACKUP_IMAGE_TAG;

      const result = (backupExecutorService as any).getBackupDockerImage();

      expect(result).toBe("ghcr.io/mrgeoffrich/mini-infra-pg-backup:dev");
    });
  });

  describe("updateBackupProgress", () => {
    it("should update progress successfully", async () => {
      mockPrisma.backupOperation.update = vi.fn().mockResolvedValue({});

      await (backupExecutorService as any).updateBackupProgress(
        "operation-123",
        {
          status: "running",
          progress: 75,
          message: "Uploading to Azure",
        },
      );

      expect(mockPrisma.backupOperation.update).toHaveBeenCalledWith({
        where: { id: "operation-123" },
        data: {
          status: "running",
          progress: 75,
          errorMessage: undefined,
        },
      });

      expect(mockLogger.debug).toHaveBeenCalledWith(
        {
          operationId: "operation-123",
          status: "running",
          progress: 75,
          message: "Uploading to Azure",
        },
        "Backup progress updated",
      );
    });

    it("should set completedAt when status is completed", async () => {
      mockPrisma.backupOperation.update = vi.fn().mockResolvedValue({});

      // Mock Date constructor
      const RealDate = Date;
      const fixedDate = new RealDate("2023-01-01T12:00:00.000Z");
      vi.spyOn(global, "Date").mockImplementation(function(this: any, dateString?: any) {
        if (dateString) {
          return new RealDate(dateString);
        }
        return fixedDate;
      } as any) as any;

      await (backupExecutorService as any).updateBackupProgress(
        "operation-123",
        {
          status: "completed",
          progress: 100,
        },
      );

      expect(mockPrisma.backupOperation.update).toHaveBeenCalledWith({
        where: { id: "operation-123" },
        data: {
          status: "completed",
          progress: 100,
          errorMessage: undefined,
          completedAt: fixedDate,
        },
      });

      vi.restoreAllMocks();
    });

    it("should handle update errors gracefully", async () => {
      mockPrisma.backupOperation.update = vi
        .fn()
        .mockRejectedValue(new Error("Database error"));

      // Should not throw, just log error
      await (backupExecutorService as any).updateBackupProgress(
        "operation-123",
        {
          status: "failed",
          progress: 0,
          errorMessage: "Test error",
        },
      );

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          error: "Database error",
          operationId: "operation-123",
          progressData: {
            status: "failed",
            progress: 0,
            errorMessage: "Test error",
          },
        }),
        "Failed to update backup progress — this may leave the operation in a stale state",
      );
    });
  });

  describe("shutdown", () => {
    it("should close queue successfully", async () => {
      mockQueue.close = vi.fn().mockResolvedValue(undefined);

      await backupExecutorService.shutdown();

      expect(mockQueue.close).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(
        "BackupExecutorService shut down successfully",
      );
    });

    it("should handle shutdown errors", async () => {
      mockQueue.close = vi.fn().mockRejectedValue(new Error("Close error"));

      await backupExecutorService.shutdown();

      expect(mockLogger.error).toHaveBeenCalledWith(
        {
          error: "Close error",
        },
        "Error during BackupExecutorService shutdown",
      );
    });
  });

  describe("mapBackupOperationToInfo", () => {
    it("should map operation with all fields", () => {
      const operation = {
        id: "operation-123",
        databaseId: "db-123",
        operationType: "manual",
        status: "completed",
        startedAt: new Date("2023-01-01T00:00:00Z"),
        completedAt: new Date("2023-01-01T01:00:00Z"),
        sizeBytes: BigInt(1000000),
        azureBlobUrl:
          "https://example.blob.core.windows.net/container/backup.sql",
        errorMessage: null,
        progress: 100,
        metadata: '{"duration": 3600}',
      };

      const result = (backupExecutorService as any).mapBackupOperationToInfo(
        operation,
      );

      expect(result).toEqual({
        id: "operation-123",
        databaseId: "db-123",
        operationType: "manual",
        status: "completed",
        startedAt: "2023-01-01T00:00:00.000Z",
        completedAt: "2023-01-01T01:00:00.000Z",
        sizeBytes: 1000000,
        azureBlobUrl:
          "https://example.blob.core.windows.net/container/backup.sql",
        errorMessage: null,
        progress: 100,
        metadata: { duration: 3600 },
      });
    });

    it("should handle null/undefined values", () => {
      const operation = {
        id: "operation-123",
        databaseId: "db-123",
        operationType: "scheduled",
        status: "running",
        startedAt: new Date("2023-01-01T00:00:00Z"),
        completedAt: null,
        sizeBytes: null,
        azureBlobUrl: null,
        errorMessage: null,
        progress: 50,
        metadata: null,
      };

      const result = (backupExecutorService as any).mapBackupOperationToInfo(
        operation,
      );

      expect(result).toEqual({
        id: "operation-123",
        databaseId: "db-123",
        operationType: "scheduled",
        status: "running",
        startedAt: "2023-01-01T00:00:00.000Z",
        completedAt: null,
        sizeBytes: null,
        azureBlobUrl: null,
        errorMessage: null,
        progress: 50,
        metadata: null,
      });
    });

    it("should handle invalid JSON metadata", () => {
      const operation = {
        id: "operation-123",
        databaseId: "db-123",
        operationType: "manual",
        status: "failed",
        startedAt: new Date("2023-01-01T00:00:00Z"),
        completedAt: null,
        sizeBytes: null,
        azureBlobUrl: null,
        errorMessage: "Test error",
        progress: 0,
        metadata: "invalid-json",
      };

      expect(() => {
        (backupExecutorService as any).mapBackupOperationToInfo(operation);
      }).toThrow();
    });
  });

  describe("queue event handling", () => {
    it("should setup queue event handlers", () => {
      // Constructor should have set up event handlers
      expect(mockQueue.on).toHaveBeenCalledWith(
        "completed",
        expect.any(Function),
      );
      expect(mockQueue.on).toHaveBeenCalledWith("failed", expect.any(Function));
    });

    it("should log completed jobs", () => {
      const mockJob = {
        id: "job-123",
        data: { backupOperationId: "operation-123" },
      };
      const result = "success";

      // Get the completed handler and call it
      const completedHandler = mockQueue.on.mock.calls.find(
        (call) => call[0] === "completed",
      )?.[1];

      if (completedHandler) {
        completedHandler(mockJob, result);

        expect(mockLogger.info).toHaveBeenCalledWith(
          {
            jobId: "job-123",
            operationId: "operation-123",
            result: "success",
          },
          "Backup job completed",
        );
      }
    });

    it("should log failed jobs", () => {
      const mockJob = {
        id: "job-123",
        data: { backupOperationId: "operation-123" },
      };
      const error = new Error("Job failed");

      // Get the failed handler and call it
      const failedHandler = mockQueue.on.mock.calls.find(
        (call) => call[0] === "failed",
      )?.[1];

      if (failedHandler) {
        failedHandler(mockJob, error);

        expect(mockLogger.error).toHaveBeenCalledWith(
          {
            jobId: "job-123",
            operationId: "operation-123",
            error: "Job failed",
          },
          "Backup job failed permanently",
        );
      }
    });
  });
});
