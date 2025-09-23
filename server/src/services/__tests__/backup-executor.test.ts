import { jest } from "@jest/globals";
import prisma from "../../lib/prisma";
import { PrismaClient } from "../../generated/prisma";
import { BackupExecutorService } from "../backup-executor";
import { DockerExecutorService } from "../docker-executor";
import { BackupConfigService } from "../backup-config";
import { DatabaseConfigService } from "../postgres-config";
import { AzureConfigService } from "../azure-config";
import { InMemoryQueue } from "../../lib/in-memory-queue";

// Mock InMemoryQueue
const mockQueue = {
  add: jest.fn(),
  process: jest.fn(),
  getJobs: jest.fn(),
  close: jest.fn(),
  on: jest.fn(),
  remove: jest.fn(),
  getStats: jest.fn().mockReturnValue({
    pending: 0,
    active: 0,
    completed: 0,
    failed: 0,
    total: 0,
  }),
};

jest.mock("../../lib/in-memory-queue", () => {
  return {
    InMemoryQueue: jest.fn().mockImplementation(() => mockQueue),
  };
});

// Mock all the services
jest.mock("../docker-executor");
jest.mock("../backup-config");
jest.mock("../postgres-config");
jest.mock("../azure-config");

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

// Mock Azure Storage Blob
const mockBlobServiceClient = {
  accountName: "testaccount",
  getContainerClient: jest.fn(),
};

const mockBlobClient = {
  getProperties: jest.fn(),
  url: "https://testaccount.blob.core.windows.net/test-container/db-backups/testdb/backup-2023-01-01.sql",
};

const mockContainerClient = {
  listBlobsFlat: jest.fn(),
  getBlobClient: jest.fn(() => mockBlobClient),
};

jest.mock("@azure/storage-blob", () => ({
  BlobServiceClient: {
    fromConnectionString: jest.fn(() => mockBlobServiceClient),
  },
}));

// Get reference to the mocked logger
const { servicesLogger } = require("../../lib/logger-factory");
const mockLogger = servicesLogger();

// Mock Prisma client
const mockPrisma = {
  backupOperation: {
    create: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  systemSettings: {
    findFirst: jest.fn(),
  },
} as unknown as typeof prisma;

// Mock service instances
const mockDockerExecutor = {
  initialize: jest.fn(),
  executeContainerWithProgress: jest.fn(),
} as unknown as DockerExecutorService;

const mockBackupConfigService = {
  getBackupConfigByDatabaseId: jest.fn(),
  updateLastBackupTime: jest.fn(),
} as unknown as BackupConfigService;

const mockDatabaseConfigService = {
  getDatabaseById: jest.fn(),
  getConnectionConfig: jest.fn(),
} as unknown as DatabaseConfigService;

const mockAzureConfigService = {
  get: jest.fn(),
} as unknown as AzureConfigService;

describe("BackupExecutorService", () => {
  let backupExecutorService: BackupExecutorService;

  beforeEach(() => {
    jest.clearAllMocks();
    backupExecutorService = new BackupExecutorService(mockPrisma);

    // Mock service instances
    (backupExecutorService as any).dockerExecutor = mockDockerExecutor;
    (backupExecutorService as any).backupConfigService =
      mockBackupConfigService;
    (backupExecutorService as any).databaseConfigService =
      mockDatabaseConfigService;
    (backupExecutorService as any).azureConfigService = mockAzureConfigService;
    (backupExecutorService as any).backupQueue = mockQueue;
  });

  afterAll(() => {
    // Clean up the static NodeCache in AzureConfigService to prevent timer leaks
    AzureConfigService.cleanupCache();
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
      mockDockerExecutor.initialize = jest.fn().mockResolvedValue(undefined);

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
      mockDockerExecutor.initialize = jest
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
      mockDockerExecutor.initialize = jest.fn().mockResolvedValue(undefined);

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
      mockDockerExecutor.initialize = jest.fn().mockResolvedValue(undefined);
    });

    it("should create and queue backup operation", async () => {
      mockPrisma.backupOperation.create = jest
        .fn()
        .mockResolvedValue(mockBackupOperation);
      mockQueue.add = jest.fn().mockResolvedValue({ id: "job-123" });

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

      mockPrisma.backupOperation.create = jest
        .fn()
        .mockResolvedValue(mockBackupOperation);
      mockQueue.add = jest.fn().mockResolvedValue({ id: "job-123" });

      await backupExecutorService.queueBackup("db-123", "manual", "user-123");

      expect(mockDockerExecutor.initialize).toHaveBeenCalled();
    });

    it("should handle database operation creation failure", async () => {
      mockPrisma.backupOperation.create = jest
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
      mockPrisma.backupOperation.create = jest
        .fn()
        .mockResolvedValue(mockBackupOperation);
      mockQueue.add = jest.fn().mockRejectedValue(new Error("Queue error"));

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
      mockPrisma.backupOperation.findUnique = jest
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
      mockPrisma.backupOperation.findUnique = jest.fn().mockResolvedValue(null);

      const result = await backupExecutorService.getBackupStatus("nonexistent");

      expect(result).toBeNull();
    });

    it("should handle database query errors", async () => {
      mockPrisma.backupOperation.findUnique = jest
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
      remove: jest.fn(),
    };

    it("should cancel backup operation successfully", async () => {
      mockPrisma.backupOperation.findUnique = jest
        .fn()
        .mockResolvedValue(mockOperation);
      mockPrisma.backupOperation.update = jest.fn().mockResolvedValue({});
      mockQueue.getJobs = jest.fn().mockResolvedValue([mockJob]);

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
      mockPrisma.backupOperation.findUnique = jest.fn().mockResolvedValue(null);

      const result = await backupExecutorService.cancelBackup("nonexistent");

      expect(result).toBe(false);
    });

    it("should return false for completed operation", async () => {
      const completedOperation = { ...mockOperation, status: "completed" };
      mockPrisma.backupOperation.findUnique = jest
        .fn()
        .mockResolvedValue(completedOperation);

      const result = await backupExecutorService.cancelBackup("operation-123");

      expect(result).toBe(false);
    });

    it("should handle cancellation when job not in queue", async () => {
      mockPrisma.backupOperation.findUnique = jest
        .fn()
        .mockResolvedValue(mockOperation);
      mockPrisma.backupOperation.update = jest.fn().mockResolvedValue({});
      mockQueue.getJobs = jest.fn().mockResolvedValue([]); // No jobs in queue

      const result = await backupExecutorService.cancelBackup("operation-123");

      expect(result).toBe(true);
      expect(mockPrisma.backupOperation.update).toHaveBeenCalled();
    });

    it("should handle errors during cancellation", async () => {
      mockPrisma.backupOperation.findUnique = jest
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
      mockDatabaseConfigService.getDatabaseById = jest
        .fn()
        .mockResolvedValue(mockDatabase);
      mockBackupConfigService.getBackupConfigByDatabaseId = jest
        .fn()
        .mockResolvedValue(mockBackupConfig);
      mockDatabaseConfigService.getConnectionConfig = jest
        .fn()
        .mockResolvedValue(mockConnectionConfig);
      mockAzureConfigService.get = jest
        .fn()
        .mockResolvedValue("azure-connection-string");
      mockPrisma.systemSettings.findFirst = jest.fn().mockResolvedValue({
        value: "postgres:15-alpine",
      });
      mockPrisma.backupOperation.update = jest.fn().mockResolvedValue({});
    });

    it("should execute backup successfully", async () => {
      // Mock container execution
      mockDockerExecutor.executeContainerWithProgress = jest
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
      mockBlobServiceClient.getContainerClient = jest
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

      mockContainerClient.listBlobsFlat = jest
        .fn()
        .mockReturnValue(mockAsyncIterator);

      mockBackupConfigService.updateLastBackupTime = jest
        .fn()
        .mockResolvedValue(undefined);

      // Test the private executeBackup method through queueBackup
      mockPrisma.backupOperation.create = jest.fn().mockResolvedValue({
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

      mockQueue.add = jest.fn().mockResolvedValue({ id: "job-123" });

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
      mockAzureConfigService.get = jest
        .fn()
        .mockResolvedValue("azure-connection-string");
      mockBlobServiceClient.getContainerClient = jest
        .fn()
        .mockReturnValue(mockContainerClient);
    });

    it("should verify backup files exist", async () => {
      mockBlobClient.getProperties = jest.fn().mockResolvedValue({
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
      mockBlobClient.getProperties = jest.fn().mockRejectedValue(new Error("Blob not found"));

      const result = await (backupExecutorService as any).verifyBackupInAzure(
        "test-container",
        "db-backups/testdb/backup-2023-01-01.sql",
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Backup file not found");
    });

    it("should handle Azure connection string not configured", async () => {
      mockAzureConfigService.get = jest.fn().mockResolvedValue(null);

      const result = await (backupExecutorService as any).verifyBackupInAzure(
        "test-container",
        "db-backups",
        "testdb",
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe("Azure connection string not configured");
    });

    it("should handle Azure storage errors", async () => {
      mockBlobServiceClient.getContainerClient = jest.fn().mockImplementation(() => {
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
    it("should return Docker image from PostgreSQL settings when configured", async () => {
      // Mock the PostgreSQL settings service to return a configured image
      const mockPostgresSettingsService = {
        getBackupDockerImage: jest.fn().mockResolvedValue("custom-postgres:latest"),
      };

      (backupExecutorService as any).postgresSettingsConfigService = mockPostgresSettingsService;

      const result = await (
        backupExecutorService as any
      ).getBackupDockerImage();

      expect(result).toBe("custom-postgres:latest");
      expect(mockPostgresSettingsService.getBackupDockerImage).toHaveBeenCalled();
    });

    it("should throw error when setting not found", async () => {
      // Mock the PostgreSQL settings service to throw an error when not configured
      const mockPostgresSettingsService = {
        getBackupDockerImage: jest.fn().mockRejectedValue(new Error("Backup Docker image not configured in system settings. Please configure it at /settings/system")),
      };

      (backupExecutorService as any).postgresSettingsConfigService = mockPostgresSettingsService;

      await expect(
        (backupExecutorService as any).getBackupDockerImage()
      ).rejects.toThrow("Backup Docker image not configured in system settings. Please configure PostgreSQL backup settings at /settings/system before running backup operations");
    });

    it("should throw error when setting has no value", async () => {
      // Mock the PostgreSQL settings service to throw an error when value is empty
      const mockPostgresSettingsService = {
        getBackupDockerImage: jest.fn().mockRejectedValue(new Error("Backup Docker image not configured in system settings. Please configure it at /settings/system")),
      };

      (backupExecutorService as any).postgresSettingsConfigService = mockPostgresSettingsService;

      await expect(
        (backupExecutorService as any).getBackupDockerImage()
      ).rejects.toThrow("Backup Docker image not configured in system settings. Please configure PostgreSQL backup settings at /settings/system before running backup operations");
    });

    it("should handle PostgreSQL settings service errors", async () => {
      // Mock the PostgreSQL settings service to throw a database error
      const mockPostgresSettingsService = {
        getBackupDockerImage: jest.fn().mockRejectedValue(new Error("Database error")),
      };

      (backupExecutorService as any).postgresSettingsConfigService = mockPostgresSettingsService;

      await expect(
        (backupExecutorService as any).getBackupDockerImage()
      ).rejects.toThrow("Backup Docker image not configured in system settings. Please configure PostgreSQL backup settings at /settings/system before running backup operations. Error: Database error");
    });
  });

  describe("updateBackupProgress", () => {
    it("should update progress successfully", async () => {
      mockPrisma.backupOperation.update = jest.fn().mockResolvedValue({});

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
      mockPrisma.backupOperation.update = jest.fn().mockResolvedValue({});

      // Mock Date constructor
      const RealDate = Date;
      const fixedDate = new Date("2023-01-01T12:00:00.000Z");
      jest.spyOn(global, "Date").mockImplementation((dateString?: any) => {
        if (dateString) {
          return new RealDate(dateString);
        }
        return fixedDate;
      }) as any;

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

      jest.restoreAllMocks();
    });

    it("should handle update errors gracefully", async () => {
      mockPrisma.backupOperation.update = jest
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

      expect(mockLogger.error).toHaveBeenCalledWith(
        {
          error: "Database error",
          operationId: "operation-123",
          progressData: {
            status: "failed",
            progress: 0,
            errorMessage: "Test error",
          },
        },
        "Failed to update backup progress",
      );
    });
  });

  describe("shutdown", () => {
    it("should close queue successfully", async () => {
      mockQueue.close = jest.fn().mockResolvedValue(undefined);

      await backupExecutorService.shutdown();

      expect(mockQueue.close).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(
        "BackupExecutorService shut down successfully",
      );
    });

    it("should handle shutdown errors", async () => {
      mockQueue.close = jest.fn().mockRejectedValue(new Error("Close error"));

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
