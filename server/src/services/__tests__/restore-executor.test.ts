import { jest } from "@jest/globals";
import prisma from "../../lib/prisma";
import { PrismaClient } from "../../generated/prisma";
import { RestoreExecutorService } from "../restore-executor";
import { DockerExecutorService } from "../docker-executor";
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
};

jest.mock("../../lib/in-memory-queue", () => {
  return {
    InMemoryQueue: jest.fn().mockImplementation(() => mockQueue),
  };
});

// Mock all the services
jest.mock("../docker-executor");
jest.mock("../postgres-config");
jest.mock("../azure-config");

// Mock logger factory
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

// Get the mocked logger
const { servicesLogger } = jest.requireMock("../../lib/logger-factory") as any;
const mockLogger = servicesLogger();

// Mock Azure Storage Blob
const mockBlobServiceClient = {
  accountName: "testaccount",
  getContainerClient: jest.fn(),
};

const mockBlobClient = {
  exists: jest.fn(),
  getProperties: jest.fn(),
  deleteIfExists: jest.fn(),
};

const mockContainerClient = {
  getBlobClient: jest.fn(() => mockBlobClient),
};

jest.mock("@azure/storage-blob", () => ({
  BlobServiceClient: {
    fromConnectionString: jest.fn(() => mockBlobServiceClient),
  },
}));

// Mock Prisma client
const mockPrisma = {
  restoreOperation: {
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
  executeContainer: jest.fn(),
  executeContainerWithProgress: jest.fn(),
} as unknown as DockerExecutorService;

const mockDatabaseConfigService = {
  getDatabaseById: jest.fn(),
  getConnectionConfig: jest.fn(),
  testConnection: jest.fn(),
} as unknown as DatabaseConfigService;

const mockAzureConfigService = {
  get: jest.fn(),
} as unknown as AzureConfigService;


describe("RestoreExecutorService", () => {
  let restoreExecutorService: RestoreExecutorService;

  beforeEach(() => {
    jest.clearAllMocks();
    restoreExecutorService = new RestoreExecutorService(mockPrisma);

    // Mock service instances
    (restoreExecutorService as any).dockerExecutor = mockDockerExecutor;
    (restoreExecutorService as any).databaseConfigService =
      mockDatabaseConfigService;
    (restoreExecutorService as any).azureConfigService = mockAzureConfigService;
    (restoreExecutorService as any).restoreQueue = mockQueue;
  });

  afterAll(() => {
    // Clean up the static NodeCache in AzureConfigService to prevent timer leaks
    AzureConfigService.cleanupCache();
  });

  describe("constructor", () => {
    it("should initialize with Prisma client and create queue", () => {
      expect(restoreExecutorService).toBeInstanceOf(RestoreExecutorService);
      expect(InMemoryQueue).toHaveBeenCalledWith(
        "postgres-restore",
        expect.objectContaining({
          defaultJobOptions: expect.objectContaining({
            attempts: 2,
            backoff: expect.objectContaining({
              type: "exponential",
              delay: 60000,
            }),
            removeOnComplete: 10,
            removeOnFail: 25,
          }),
        }),
      );
    });
  });

  describe("initialize", () => {
    it("should initialize Docker executor successfully", async () => {
      mockDockerExecutor.initialize = jest.fn().mockResolvedValue(undefined);

      await restoreExecutorService.initialize();

      expect(mockDockerExecutor.initialize).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(
        "RestoreExecutorService initialized successfully",
      );
    });

    it("should handle initialization failure", async () => {
      mockDockerExecutor.initialize = jest
        .fn()
        .mockRejectedValue(new Error("Docker initialization failed"));

      await expect(restoreExecutorService.initialize()).rejects.toThrow(
        "Docker initialization failed",
      );

      expect(mockLogger.error).toHaveBeenCalledWith(
        {
          error: "Docker initialization failed",
        },
        "Failed to initialize RestoreExecutorService",
      );
    });

    it("should not reinitialize if already initialized", async () => {
      mockDockerExecutor.initialize = jest.fn().mockResolvedValue(undefined);

      // Initialize twice
      await restoreExecutorService.initialize();
      await restoreExecutorService.initialize();

      // Should only call initialize once
      expect(mockDockerExecutor.initialize).toHaveBeenCalledTimes(1);
    });
  });

  describe("queueRestore", () => {
    const mockRestoreOperation = {
      id: "operation-123",
      databaseId: "db-123",
      backupUrl: "https://account.blob.core.windows.net/container/backup.sql",
      status: "pending",
      progress: 0,
      startedAt: new Date("2023-01-01T00:00:00Z"),
      completedAt: null,
      errorMessage: null,
    };

    beforeEach(() => {
      mockDockerExecutor.initialize = jest.fn().mockResolvedValue(undefined);
    });

    it("should create and queue restore operation", async () => {
      mockPrisma.restoreOperation.create = jest
        .fn()
        .mockResolvedValue(mockRestoreOperation);
      mockQueue.add = jest.fn().mockResolvedValue({ id: "job-123" });

      const result = await restoreExecutorService.queueRestore(
        "db-123",
        "https://account.blob.core.windows.net/container/backup.sql",
        "user-123",
      );

      expect(result).toEqual({
        id: "operation-123",
        databaseId: "db-123",
        backupUrl: "https://account.blob.core.windows.net/container/backup.sql",
        status: "pending",
        startedAt: "2023-01-01T00:00:00.000Z",
        completedAt: null,
        errorMessage: null,
        progress: 0,
      });

      expect(mockPrisma.restoreOperation.create).toHaveBeenCalledWith({
        data: {
          databaseId: "db-123",
          backupUrl:
            "https://account.blob.core.windows.net/container/backup.sql",
          status: "pending",
          progress: 0,
        },
      });

      expect(mockQueue.add).toHaveBeenCalledWith(
        "execute-restore",
        {
          restoreOperationId: "operation-123",
          databaseId: "db-123",
          backupUrl:
            "https://account.blob.core.windows.net/container/backup.sql",
          userId: "user-123",
        },
        { delay: 0 },
      );
    });

    it("should initialize if not already initialized", async () => {
      // Set as not initialized
      (restoreExecutorService as any).isInitialized = false;

      mockPrisma.restoreOperation.create = jest
        .fn()
        .mockResolvedValue(mockRestoreOperation);
      mockQueue.add = jest.fn().mockResolvedValue({ id: "job-123" });

      await restoreExecutorService.queueRestore(
        "db-123",
        "https://account.blob.core.windows.net/container/backup.sql",
        "user-123",
      );

      expect(mockDockerExecutor.initialize).toHaveBeenCalled();
    });

    it("should handle database operation creation failure", async () => {
      mockPrisma.restoreOperation.create = jest
        .fn()
        .mockRejectedValue(new Error("Database error"));

      await expect(
        restoreExecutorService.queueRestore(
          "db-123",
          "https://account.blob.core.windows.net/container/backup.sql",
          "user-123",
        ),
      ).rejects.toThrow("Database error");

      expect(mockLogger.error).toHaveBeenCalledWith(
        {
          error: "Database error",
          databaseId: "db-123",
          backupUrl:
            "https://account.blob.core.windows.net/container/backup.sql",
          userId: "user-123",
        },
        "Failed to queue restore operation",
      );
    });
  });

  describe("getRestoreStatus", () => {
    const mockOperation = {
      id: "operation-123",
      databaseId: "db-123",
      backupUrl: "https://account.blob.core.windows.net/container/backup.sql",
      status: "running",
      progress: 50,
      startedAt: new Date("2023-01-01T00:00:00Z"),
      completedAt: null,
      errorMessage: null,
    };

    it("should return restore operation status", async () => {
      mockPrisma.restoreOperation.findUnique = jest
        .fn()
        .mockResolvedValue(mockOperation);

      const result =
        await restoreExecutorService.getRestoreStatus("operation-123");

      expect(result).toEqual({
        id: "operation-123",
        databaseId: "db-123",
        backupUrl: "https://account.blob.core.windows.net/container/backup.sql",
        status: "running",
        startedAt: "2023-01-01T00:00:00.000Z",
        completedAt: null,
        errorMessage: null,
        progress: 50,
      });
    });

    it("should return null for non-existent operation", async () => {
      mockPrisma.restoreOperation.findUnique = jest
        .fn()
        .mockResolvedValue(null);

      const result =
        await restoreExecutorService.getRestoreStatus("nonexistent");

      expect(result).toBeNull();
    });

    it("should handle database query errors", async () => {
      mockPrisma.restoreOperation.findUnique = jest
        .fn()
        .mockRejectedValue(new Error("Database error"));

      await expect(
        restoreExecutorService.getRestoreStatus("operation-123"),
      ).rejects.toThrow("Database error");

      expect(mockLogger.error).toHaveBeenCalledWith(
        {
          error: "Database error",
          operationId: "operation-123",
        },
        "Failed to get restore status",
      );
    });
  });

  describe("cancelRestore", () => {
    const mockOperation = {
      id: "operation-123",
      status: "running",
      progress: 50,
    };

    const mockJob = {
      id: "job-123",
      data: { restoreOperationId: "operation-123" },
      remove: jest.fn(),
    };

    it("should cancel restore operation successfully", async () => {
      mockPrisma.restoreOperation.findUnique = jest
        .fn()
        .mockResolvedValue(mockOperation);
      mockPrisma.restoreOperation.update = jest.fn().mockResolvedValue({});
      mockQueue.getJobs = jest.fn().mockResolvedValue([mockJob]);

      const result =
        await restoreExecutorService.cancelRestore("operation-123");

      expect(result).toBe(true);
      expect(mockPrisma.restoreOperation.update).toHaveBeenCalledWith({
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
      mockPrisma.restoreOperation.findUnique = jest
        .fn()
        .mockResolvedValue(null);

      const result = await restoreExecutorService.cancelRestore("nonexistent");

      expect(result).toBe(false);
    });

    it("should return false for completed operation", async () => {
      const completedOperation = { ...mockOperation, status: "completed" };
      mockPrisma.restoreOperation.findUnique = jest
        .fn()
        .mockResolvedValue(completedOperation);

      const result =
        await restoreExecutorService.cancelRestore("operation-123");

      expect(result).toBe(false);
    });
  });

  describe("validateBackupFile", () => {
    const backupUrl =
      "https://account.blob.core.windows.net/container/backup.sql";

    beforeEach(() => {
      mockAzureConfigService.get = jest
        .fn()
        .mockResolvedValue("azure-connection-string");
      mockBlobServiceClient.getContainerClient = jest
        .fn()
        .mockReturnValue(mockContainerClient);
    });

    it("should validate backup file successfully", async () => {
      mockBlobClient.exists = jest.fn().mockResolvedValue(true);
      mockBlobClient.getProperties = jest.fn().mockResolvedValue({
        contentLength: 1000000,
        lastModified: new Date("2023-01-01T02:00:00Z"),
        contentType: "application/octet-stream",
        etag: '"0x8D9ABC123"',
        contentEncoding: "gzip",
      });

      const result = await (restoreExecutorService as any).validateBackupFile(
        backupUrl,
      );

      expect(result.isValid).toBe(true);
      expect(result.sizeBytes).toBe(1000000);
      expect(result.lastModified).toEqual(new Date("2023-01-01T02:00:00Z"));
      expect(result.metadata).toEqual({
        contentType: "application/octet-stream",
        etag: '"0x8D9ABC123"',
        contentEncoding: "gzip",
      });
    });

    it("should return error when backup file not found", async () => {
      mockBlobClient.exists = jest.fn().mockResolvedValue(false);

      const result = await (restoreExecutorService as any).validateBackupFile(
        backupUrl,
      );

      expect(result.isValid).toBe(false);
      expect(result.error).toBe("Backup file not found in Azure Storage");
    });

    it("should return error for file too small", async () => {
      mockBlobClient.exists = jest.fn().mockResolvedValue(true);
      mockBlobClient.getProperties = jest.fn().mockResolvedValue({
        contentLength: 50, // Too small
        lastModified: new Date("2023-01-01T02:00:00Z"),
      });

      const result = await (restoreExecutorService as any).validateBackupFile(
        backupUrl,
      );

      expect(result.isValid).toBe(false);
      expect(result.error).toBe(
        "Backup file appears to be too small or corrupted",
      );
    });

    it("should warn about old backup files", async () => {
      const oldDate = new Date();
      oldDate.setFullYear(oldDate.getFullYear() - 2); // 2 years old

      mockBlobClient.exists = jest.fn().mockResolvedValue(true);
      mockBlobClient.getProperties = jest.fn().mockResolvedValue({
        contentLength: 1000000,
        lastModified: oldDate,
      });

      const result = await (restoreExecutorService as any).validateBackupFile(
        backupUrl,
      );

      expect(result.isValid).toBe(true);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          backupUrl,
          ageInDays: expect.any(Number),
          maxAgeInDays: 365,
        }),
        "Warning: Backup file is quite old",
      );
    });

    it("should handle Azure connection string not configured", async () => {
      mockAzureConfigService.get = jest.fn().mockResolvedValue(null);

      const result = await (restoreExecutorService as any).validateBackupFile(
        backupUrl,
      );

      expect(result.isValid).toBe(false);
      expect(result.error).toBe("Azure connection string not configured");
    });

    it("should handle Azure storage errors", async () => {
      mockBlobClient.exists = jest
        .fn()
        .mockRejectedValue(new Error("Azure error"));

      const result = await (restoreExecutorService as any).validateBackupFile(
        backupUrl,
      );

      expect(result.isValid).toBe(false);
      expect(result.error).toBe("Azure error");
    });
  });

  describe("parseBackupUrl", () => {
    it("should parse valid backup URL", () => {
      const url =
        "https://account.blob.core.windows.net/container/folder/backup.sql";

      const result = (restoreExecutorService as any).parseBackupUrl(url);

      expect(result).toEqual({
        containerName: "container",
        blobName: "folder/backup.sql",
      });
    });

    it("should handle URL with single level path", () => {
      const url = "https://account.blob.core.windows.net/container/backup.sql";

      const result = (restoreExecutorService as any).parseBackupUrl(url);

      expect(result).toEqual({
        containerName: "container",
        blobName: "backup.sql",
      });
    });

    it("should throw error for invalid URL", () => {
      const invalidUrl = "not-a-valid-url";

      expect(() => {
        (restoreExecutorService as any).parseBackupUrl(invalidUrl);
      }).toThrow("Invalid backup URL format");
    });
  });

  describe("extractContainerFromUrl", () => {
    it("should extract container name from URL", () => {
      const url =
        "https://account.blob.core.windows.net/test-container/backup.sql";

      const result = (restoreExecutorService as any).extractContainerFromUrl(
        url,
      );

      expect(result).toBe("test-container");
    });
  });

  describe("getStorageAccountFromConnectionString", () => {
    it("should extract account name from connection string", () => {
      const connectionString =
        "DefaultEndpointsProtocol=https;AccountName=teststorage;AccountKey=key123;EndpointSuffix=core.windows.net";

      const result = (
        restoreExecutorService as any
      ).getStorageAccountFromConnectionString(connectionString);

      expect(result).toBe("teststorage");
    });

    it("should throw error for connection string without AccountName", () => {
      const connectionString =
        "DefaultEndpointsProtocol=https;AccountKey=key123;EndpointSuffix=core.windows.net";

      expect(() => {
        (restoreExecutorService as any).getStorageAccountFromConnectionString(
          connectionString,
        );
      }).toThrow("Failed to parse Azure storage account name");
    });

    it("should handle malformed connection string", () => {
      const connectionString = "invalid-connection-string";

      expect(() => {
        (restoreExecutorService as any).getStorageAccountFromConnectionString(
          connectionString,
        );
      }).toThrow("Failed to parse Azure storage account name");
    });
  });

  describe("getRestoreDockerImage", () => {
    it("should return restore-specific Docker image from settings", async () => {
      mockPrisma.systemSettings.findFirst = jest
        .fn()
        .mockResolvedValueOnce({ value: "custom-restore:latest" }) // First call for restore image
        .mockResolvedValueOnce(null); // Second call for backup image fallback

      const result = await (
        restoreExecutorService as any
      ).getRestoreDockerImage();

      expect(result).toBe("custom-restore:latest");
      expect(mockPrisma.systemSettings.findFirst).toHaveBeenCalledWith({
        where: {
          category: "postgres",
          key: "restore_docker_image",
        },
      });
    });

    it("should fallback to backup Docker image", async () => {
      mockPrisma.systemSettings.findFirst = jest
        .fn()
        .mockResolvedValueOnce(null) // No restore-specific image
        .mockResolvedValueOnce({ value: "backup-image:latest" }); // Backup image

      const result = await (
        restoreExecutorService as any
      ).getRestoreDockerImage();

      expect(result).toBe("backup-image:latest");
    });

    it("should return default image when no settings found", async () => {
      mockPrisma.systemSettings.findFirst = jest.fn().mockResolvedValue(null); // No settings found

      const result = await (
        restoreExecutorService as any
      ).getRestoreDockerImage();

      expect(result).toBe("postgres:15-alpine");
    });

    it("should handle database query errors", async () => {
      mockPrisma.systemSettings.findFirst = jest
        .fn()
        .mockRejectedValue(new Error("Database error"));

      const result = await (
        restoreExecutorService as any
      ).getRestoreDockerImage();

      expect(result).toBe("postgres:15-alpine");
      expect(mockLogger.warn).toHaveBeenCalledWith(
        {
          error: "Database error",
        },
        "Failed to get restore Docker image from settings, using default",
      );
    });
  });

  describe("createRollbackBackup", () => {
    const connectionConfig = {
      host: "localhost",
      username: "testuser",
      password: "testpass",
      database: "testdb",
    };

    it("should create rollback backup successfully", async () => {
      mockDockerExecutor.executeContainer = jest.fn().mockResolvedValue({
        exitCode: 0,
        stdout: "Backup completed",
        stderr: "",
      });

      const azureConnectionString = "DefaultEndpointsProtocol=https;AccountName=testaccount;AccountKey=testkey;EndpointSuffix=core.windows.net";

      const result = await (restoreExecutorService as any).createRollbackBackup(
        connectionConfig,
        azureConnectionString,
        "postgres:15-alpine",
        "testdb",
      );

      expect(result).toContain("rollback-backups/testdb/rollback-");
      expect(result).toContain("testaccount.blob.core.windows.net");
      expect(mockDockerExecutor.executeContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          image: "postgres:15-alpine",
          env: expect.objectContaining({
            POSTGRES_HOST: "localhost",
            POSTGRES_USER: "testuser",
            POSTGRES_PASSWORD: "testpass",
            POSTGRES_DATABASE: "testdb",
            AZURE_STORAGE_ACCOUNT_CONNECTION_STRING: azureConnectionString,
            AZURE_CONTAINER_NAME: "rollback-backups",
          }),
          timeout: 30 * 60 * 1000,
        }),
      );
    });

    it("should throw error when rollback backup fails", async () => {
      mockDockerExecutor.executeContainer = jest.fn().mockResolvedValue({
        exitCode: 1,
        stdout: "",
        stderr: "Backup failed",
      });

      const azureConnectionString = "DefaultEndpointsProtocol=https;AccountName=testaccount;AccountKey=testkey;EndpointSuffix=core.windows.net";

      await expect(
        (restoreExecutorService as any).createRollbackBackup(
          connectionConfig,
          azureConnectionString,
          "postgres:15-alpine",
          "testdb",
        ),
      ).rejects.toThrow("Failed to create rollback backup: Backup failed");
    });
  });

  describe("executeRollback", () => {
    const connectionConfig = {
      host: "localhost",
      username: "testuser",
      password: "testpass",
      database: "testdb",
    };

    const rollbackUrl =
      "https://account.blob.core.windows.net/rollback-backups/testdb/rollback-123.sql";

    it("should execute rollback successfully", async () => {
      mockDockerExecutor.executeContainer = jest.fn().mockResolvedValue({
        exitCode: 0,
        stdout: "Restore completed",
        stderr: "",
      });

      const azureConnectionString = "DefaultEndpointsProtocol=https;AccountName=testaccount;AccountKey=testkey;EndpointSuffix=core.windows.net";

      await (restoreExecutorService as any).executeRollback(
        connectionConfig,
        rollbackUrl,
        azureConnectionString,
        "postgres:15-alpine",
      );

      expect(mockDockerExecutor.executeContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          image: "postgres:15-alpine",
          env: expect.objectContaining({
            POSTGRES_HOST: "localhost",
            POSTGRES_USER: "testuser",
            POSTGRES_PASSWORD: "testpass",
            POSTGRES_DATABASE: "testdb",
            AZURE_STORAGE_ACCOUNT_CONNECTION_STRING: azureConnectionString,
            AZURE_CONTAINER_NAME: "rollback-backups",
            RESTORE: "yes",
            DROP_PUBLIC: "yes",
            BACKUP_FILE_URL: rollbackUrl,
          }),
          timeout: 60 * 60 * 1000,
        }),
      );

      expect(mockLogger.info).toHaveBeenCalledWith(
        { rollbackBackupUrl: rollbackUrl },
        "Rollback executed successfully",
      );
    });

    it("should throw error when rollback fails", async () => {
      mockDockerExecutor.executeContainer = jest.fn().mockResolvedValue({
        exitCode: 1,
        stdout: "",
        stderr: "Rollback failed",
      });

      const azureConnectionString = "DefaultEndpointsProtocol=https;AccountName=testaccount;AccountKey=testkey;EndpointSuffix=core.windows.net";

      await expect(
        (restoreExecutorService as any).executeRollback(
          connectionConfig,
          rollbackUrl,
          azureConnectionString,
          "postgres:15-alpine",
        ),
      ).rejects.toThrow("Rollback execution failed: Rollback failed");
    });
  });

  describe("verifyRestoredDatabase", () => {
    const connectionConfig = {
      host: "localhost",
      username: "testuser",
      password: "testpass",
      database: "testdb",
    };

    it("should verify database successfully", async () => {
      mockDatabaseConfigService.testConnection = jest.fn().mockResolvedValue({
        isValid: true,
        message: "Connection successful",
      });

      const result = await (
        restoreExecutorService as any
      ).verifyRestoredDatabase(connectionConfig);

      expect(result.isValid).toBe(true);
      expect(mockLogger.info).toHaveBeenCalledWith(
        { database: "testdb" },
        "Restored database verified successfully",
      );
    });

    it("should return error when database connection fails", async () => {
      mockDatabaseConfigService.testConnection = jest.fn().mockResolvedValue({
        isValid: false,
        message: "Connection failed",
      });

      const result = await (
        restoreExecutorService as any
      ).verifyRestoredDatabase(connectionConfig);

      expect(result.isValid).toBe(false);
      expect(result.error).toBe(
        "Database connection failed: Connection failed",
      );
    });

    it("should handle test connection errors", async () => {
      mockDatabaseConfigService.testConnection = jest
        .fn()
        .mockRejectedValue(new Error("Test error"));

      const result = await (
        restoreExecutorService as any
      ).verifyRestoredDatabase(connectionConfig);

      expect(result.isValid).toBe(false);
      expect(result.error).toBe("Test error");
    });
  });

  describe("cleanupRollbackBackup", () => {
    const rollbackUrl =
      "https://account.blob.core.windows.net/rollback-backups/testdb/rollback-123.sql";

    beforeEach(() => {
      mockAzureConfigService.get = jest
        .fn()
        .mockResolvedValue("azure-connection-string");
      mockBlobServiceClient.getContainerClient = jest
        .fn()
        .mockReturnValue(mockContainerClient);
    });

    it("should cleanup rollback backup successfully", async () => {
      mockBlobClient.deleteIfExists = jest
        .fn()
        .mockResolvedValue({ succeeded: true });

      await (restoreExecutorService as any).cleanupRollbackBackup(rollbackUrl);

      expect(mockBlobClient.deleteIfExists).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(
        { rollbackBackupUrl: rollbackUrl },
        "Rollback backup cleaned up successfully",
      );
    });

    it("should handle cleanup errors gracefully", async () => {
      mockBlobClient.deleteIfExists = jest
        .fn()
        .mockRejectedValue(new Error("Delete error"));

      // Should not throw, just log warning
      await (restoreExecutorService as any).cleanupRollbackBackup(rollbackUrl);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        {
          error: "Delete error",
          rollbackBackupUrl: rollbackUrl,
        },
        "Failed to clean up rollback backup",
      );
    });

    it("should handle missing Azure connection string", async () => {
      mockAzureConfigService.get = jest.fn().mockResolvedValue(null);

      await (restoreExecutorService as any).cleanupRollbackBackup(rollbackUrl);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        "Azure connection string not available for cleanup",
      );
    });
  });

  describe("updateRestoreProgress", () => {
    it("should update progress successfully", async () => {
      mockPrisma.restoreOperation.update = jest.fn().mockResolvedValue({});

      await (restoreExecutorService as any).updateRestoreProgress(
        "operation-123",
        {
          status: "running",
          progress: 75,
          message: "Restoring database",
        },
      );

      expect(mockPrisma.restoreOperation.update).toHaveBeenCalledWith({
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
          message: "Restoring database",
        },
        "Restore progress updated",
      );
    });

    it("should set completedAt when status is completed", async () => {
      mockPrisma.restoreOperation.update = jest.fn().mockResolvedValue({});

      await (restoreExecutorService as any).updateRestoreProgress(
        "operation-123",
        {
          status: "completed",
          progress: 100,
        },
      );

      expect(mockPrisma.restoreOperation.update).toHaveBeenCalledWith({
        where: { id: "operation-123" },
        data: {
          status: "completed",
          progress: 100,
          errorMessage: undefined,
          completedAt: expect.any(Date),
        },
      });
    });

    it("should handle update errors gracefully", async () => {
      mockPrisma.restoreOperation.update = jest
        .fn()
        .mockRejectedValue(new Error("Database error"));

      // Should not throw, just log error
      await (restoreExecutorService as any).updateRestoreProgress(
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
        "Failed to update restore progress",
      );
    });
  });

  describe("mapRestoreOperationToInfo", () => {
    it("should map operation with all fields", () => {
      const operation = {
        id: "operation-123",
        databaseId: "db-123",
        backupUrl: "https://account.blob.core.windows.net/container/backup.sql",
        status: "completed",
        startedAt: new Date("2023-01-01T00:00:00Z"),
        completedAt: new Date("2023-01-01T01:00:00Z"),
        errorMessage: null,
        progress: 100,
      };

      const result = (restoreExecutorService as any).mapRestoreOperationToInfo(
        operation,
      );

      expect(result).toEqual({
        id: "operation-123",
        databaseId: "db-123",
        backupUrl: "https://account.blob.core.windows.net/container/backup.sql",
        status: "completed",
        startedAt: "2023-01-01T00:00:00.000Z",
        completedAt: "2023-01-01T01:00:00.000Z",
        errorMessage: null,
        progress: 100,
      });
    });

    it("should handle null/undefined values", () => {
      const operation = {
        id: "operation-123",
        databaseId: "db-123",
        backupUrl: "https://account.blob.core.windows.net/container/backup.sql",
        status: "running",
        startedAt: new Date("2023-01-01T00:00:00Z"),
        completedAt: null,
        errorMessage: null,
        progress: 50,
      };

      const result = (restoreExecutorService as any).mapRestoreOperationToInfo(
        operation,
      );

      expect(result).toEqual({
        id: "operation-123",
        databaseId: "db-123",
        backupUrl: "https://account.blob.core.windows.net/container/backup.sql",
        status: "running",
        startedAt: "2023-01-01T00:00:00.000Z",
        completedAt: null,
        errorMessage: null,
        progress: 50,
      });
    });
  });

  describe("shutdown", () => {
    it("should close queue successfully", async () => {
      mockQueue.close = jest.fn().mockResolvedValue(undefined);

      await restoreExecutorService.shutdown();

      expect(mockQueue.close).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(
        "RestoreExecutorService shut down successfully",
      );
    });

    it("should handle shutdown errors", async () => {
      mockQueue.close = jest.fn().mockRejectedValue(new Error("Close error"));

      await restoreExecutorService.shutdown();

      expect(mockLogger.error).toHaveBeenCalledWith(
        {
          error: "Close error",
        },
        "Error during RestoreExecutorService shutdown",
      );
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
        data: { restoreOperationId: "operation-123" },
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
          "Restore job completed",
        );
      }
    });

    it("should log failed jobs", () => {
      const mockJob = {
        id: "job-123",
        data: { restoreOperationId: "operation-123" },
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
          "Restore job failed permanently",
        );
      }
    });
  });
});
