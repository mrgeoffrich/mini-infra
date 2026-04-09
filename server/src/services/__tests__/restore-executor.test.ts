import prisma from "../../lib/prisma";
import { PrismaClient } from "../../generated/prisma";
import { RestoreExecutorService } from "../restore-executor";
import { DockerExecutorService } from "../docker-executor";
import { PostgresDatabaseManager } from "../postgres";
import { AzureStorageService } from "../azure-storage-service";
import { InMemoryQueue } from "../../lib/in-memory-queue";

// Hoist mock variables used inside vi.mock() factory functions
const { mockQueue, mockBlobServiceClient, mockBlobClient, mockContainerClient } = vi.hoisted(() => {
  const mockBlobClient = {
    exists: vi.fn(),
    getProperties: vi.fn(),
    deleteIfExists: vi.fn(),
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
vi.mock("../postgres/postgres-database-manager");
vi.mock("../azure-storage-service");

// Mock logger factory
vi.mock("../../lib/logger-factory", () => {
  const mockLoggerInstance = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  };
  return {
    appLogger: vi.fn(function() { return mockLoggerInstance; }),
    servicesLogger: vi.fn(function() { return mockLoggerInstance; }),
    dockerExecutorLogger: vi.fn(function() { return mockLoggerInstance; }),
    httpLogger: vi.fn(function() { return mockLoggerInstance; }),
    prismaLogger: vi.fn(function() { return mockLoggerInstance; }),
    default: vi.fn(function() { return mockLoggerInstance; }),
  };
});

// Get the mocked logger (defined in vi.mock factory above)
import * as loggerFactory from "../../lib/logger-factory";
const mockLogger = (vi.mocked(loggerFactory).servicesLogger as any)();

vi.mock("@azure/storage-blob", () => ({
  BlobServiceClient: {
    fromConnectionString: vi.fn(function() { return mockBlobServiceClient; }),
  },
}));

// Mock Prisma client
const mockPrisma = {
  restoreOperation: {
    create: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  systemSettings: {
    findFirst: vi.fn(),
  },
  infraResource: {
    findFirst: vi.fn().mockResolvedValue(null),
  },
} as unknown as typeof prisma;

// Mock service instances
const mockDockerExecutor = {
  initialize: vi.fn(),
  executeContainer: vi.fn(),
  executeContainerWithProgress: vi.fn(),
} as unknown as DockerExecutorService;

const mockPostgresDatabaseManager = {
  getDatabaseById: vi.fn(),
  getConnectionConfig: vi.fn(),
  testConnection: vi.fn(),
} as unknown as PostgresDatabaseManager;

const mockAzureStorageService = {
  get: vi.fn(),
  getConnectionString: vi.fn(),
  generateBlobSasUrl: vi.fn().mockResolvedValue("https://testaccount.blob.core.windows.net/container/blob?sas-token"),
} as unknown as AzureStorageService;

describe("RestoreExecutorService", () => {
  let restoreExecutorService: RestoreExecutorService;

  beforeEach(() => {
    vi.clearAllMocks();
    restoreExecutorService = new RestoreExecutorService(mockPrisma);

    // Mock service instances
    (restoreExecutorService as any).dockerExecutor = mockDockerExecutor;
    (restoreExecutorService as any).databaseConfigService =
      mockPostgresDatabaseManager;
    (restoreExecutorService as any).azureConfigService = mockAzureStorageService;
    (restoreExecutorService as any).restoreQueue = mockQueue;
  });

  afterAll(() => {
    // Clean up the static NodeCache in AzureStorageService to prevent timer leaks
    AzureStorageService.cleanupCache();
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
      mockDockerExecutor.initialize = vi.fn().mockResolvedValue(undefined);

      await restoreExecutorService.initialize();

      expect(mockDockerExecutor.initialize).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          initializationTimeMs: expect.any(Number),
          queueConcurrency: 1,
          maxRetries: 2,
          timeoutMs: 10800000,
        }),
        "RestoreExecutorService initialized successfully",
      );
    });

    it("should handle initialization failure", async () => {
      mockDockerExecutor.initialize = vi
        .fn()
        .mockRejectedValue(new Error("Docker initialization failed"));

      // The service should still initialize even if Docker fails
      await restoreExecutorService.initialize();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        {
          error: "Docker initialization failed",
        },
        "Failed to initialize Docker executor - restore operations will be unavailable until Docker is configured",
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          initializationTimeMs: expect.any(Number),
          queueConcurrency: 1,
          maxRetries: 2,
          timeoutMs: 10800000,
        }),
        "RestoreExecutorService initialized successfully",
      );
    });

    it("should not reinitialize if already initialized", async () => {
      mockDockerExecutor.initialize = vi.fn().mockResolvedValue(undefined);

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
      mockDockerExecutor.initialize = vi.fn().mockResolvedValue(undefined);
    });

    it("should create and queue restore operation", async () => {
      mockPrisma.restoreOperation.create = vi
        .fn()
        .mockResolvedValue(mockRestoreOperation);
      mockQueue.add = vi.fn().mockResolvedValue({ id: "job-123" });

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

      mockPrisma.restoreOperation.create = vi
        .fn()
        .mockResolvedValue(mockRestoreOperation);
      mockQueue.add = vi.fn().mockResolvedValue({ id: "job-123" });

      await restoreExecutorService.queueRestore(
        "db-123",
        "https://account.blob.core.windows.net/container/backup.sql",
        "user-123",
      );

      expect(mockDockerExecutor.initialize).toHaveBeenCalled();
    });

    it("should handle database operation creation failure", async () => {
      mockPrisma.restoreOperation.create = vi
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
        expect.objectContaining({
          error: "Database error",
          databaseId: "db-123",
          backupUrl:
            "https://account.blob.core.windows.net/container/backup.sql",
          userId: "user-123",
          queueingTimeMs: expect.any(Number),
        }),
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
      mockPrisma.restoreOperation.findUnique = vi
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
      mockPrisma.restoreOperation.findUnique = vi
        .fn()
        .mockResolvedValue(null);

      const result =
        await restoreExecutorService.getRestoreStatus("nonexistent");

      expect(result).toBeNull();
    });

    it("should handle database query errors", async () => {
      mockPrisma.restoreOperation.findUnique = vi
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
      remove: vi.fn(),
    };

    it("should cancel restore operation successfully", async () => {
      mockPrisma.restoreOperation.findUnique = vi
        .fn()
        .mockResolvedValue(mockOperation);
      mockPrisma.restoreOperation.update = vi.fn().mockResolvedValue({});
      mockQueue.getJobs = vi.fn().mockResolvedValue([mockJob]);

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
      mockPrisma.restoreOperation.findUnique = vi
        .fn()
        .mockResolvedValue(null);

      const result = await restoreExecutorService.cancelRestore("nonexistent");

      expect(result).toBe(false);
    });

    it("should return false for completed operation", async () => {
      const completedOperation = { ...mockOperation, status: "completed" };
      mockPrisma.restoreOperation.findUnique = vi
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
      mockAzureStorageService.get = vi
        .fn()
        .mockResolvedValue("azure-connection-string");
      mockBlobServiceClient.getContainerClient = vi
        .fn()
        .mockReturnValue(mockContainerClient);
    });

    it("should validate backup file successfully", async () => {
      mockBlobClient.exists = vi.fn().mockResolvedValue(true);
      mockBlobClient.getProperties = vi.fn().mockResolvedValue({
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
      expect(result.metadata).toEqual(
        expect.objectContaining({
          contentType: "application/octet-stream",
          etag: '"0x8D9ABC123"',
          contentEncoding: "gzip",
        }),
      );
    });

    it("should return error when backup file not found", async () => {
      mockBlobClient.exists = vi.fn().mockResolvedValue(false);

      const result = await (restoreExecutorService as any).validateBackupFile(
        backupUrl,
      );

      expect(result.isValid).toBe(false);
      expect(result.error).toContain("Backup file not found in Azure Storage");
    });

    it("should return error for file too small", async () => {
      mockBlobClient.exists = vi.fn().mockResolvedValue(true);
      mockBlobClient.getProperties = vi.fn().mockResolvedValue({
        contentLength: 50, // Too small
        lastModified: new Date("2023-01-01T02:00:00Z"),
      });

      const result = await (restoreExecutorService as any).validateBackupFile(
        backupUrl,
      );

      expect(result.isValid).toBe(false);
      expect(result.error).toContain(
        "Backup file appears to be too small",
      );
    });

    it("should warn about old backup files", async () => {
      const oldDate = new Date();
      oldDate.setFullYear(oldDate.getFullYear() - 2); // 2 years old

      mockBlobClient.exists = vi.fn().mockResolvedValue(true);
      mockBlobClient.getProperties = vi.fn().mockResolvedValue({
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
      mockAzureStorageService.get = vi.fn().mockResolvedValue(null);

      const result = await (restoreExecutorService as any).validateBackupFile(
        backupUrl,
      );

      expect(result.isValid).toBe(false);
      expect(result.error).toBe("Azure connection string not configured");
    });

    it("should handle Azure storage errors", async () => {
      mockBlobClient.exists = vi
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
      const mockSettingsConfig = {
        getRestoreDockerImage: vi.fn().mockResolvedValue("custom-restore:latest"),
      };
      (restoreExecutorService as any).postgresSettingsConfigService = mockSettingsConfig;

      // Access through dbOps since getRestoreDockerImage is on DbOperations
      const dbOps = (restoreExecutorService as any).dbOps;
      dbOps.postgresSettingsConfigService = mockSettingsConfig;

      const result = await dbOps.getRestoreDockerImage();

      expect(result).toBe("custom-restore:latest");
      expect(mockSettingsConfig.getRestoreDockerImage).toHaveBeenCalled();
    });

    it("should fallback to backup Docker image", async () => {
      const mockSettingsConfig = {
        getRestoreDockerImage: vi.fn().mockResolvedValue("backup-image:latest"),
      };
      (restoreExecutorService as any).postgresSettingsConfigService = mockSettingsConfig;
      const dbOps = (restoreExecutorService as any).dbOps;
      dbOps.postgresSettingsConfigService = mockSettingsConfig;

      const result = await dbOps.getRestoreDockerImage();

      expect(result).toBe("backup-image:latest");
    });

    it("should return default image when no settings found", async () => {
      const mockSettingsConfig = {
        getRestoreDockerImage: vi.fn().mockResolvedValue("postgres:15-alpine"),
      };
      (restoreExecutorService as any).postgresSettingsConfigService = mockSettingsConfig;
      const dbOps = (restoreExecutorService as any).dbOps;
      dbOps.postgresSettingsConfigService = mockSettingsConfig;

      const result = await dbOps.getRestoreDockerImage();

      expect(result).toBe("postgres:15-alpine");
    });

    it("should handle database query errors", async () => {
      const mockSettingsConfig = {
        getRestoreDockerImage: vi.fn().mockRejectedValue(new Error("Database error")),
      };
      (restoreExecutorService as any).postgresSettingsConfigService = mockSettingsConfig;
      const dbOps = (restoreExecutorService as any).dbOps;
      dbOps.postgresSettingsConfigService = mockSettingsConfig;

      await expect(dbOps.getRestoreDockerImage()).rejects.toThrow(
        "Restore Docker image not configured in system settings"
      );
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          error: "Database error",
        }),
        expect.stringContaining("Failed to get restore Docker image"),
      );
    });
  });

  describe("createRollbackBackup", () => {
    const connectionConfig = {
      host: "localhost",
      port: 5432,
      username: "testuser",
      password: "testpass",
      database: "testdb",
    };

    it("should create rollback backup successfully", async () => {
      mockDockerExecutor.executeContainer = vi.fn().mockResolvedValue({
        exitCode: 0,
        stdout: "Backup completed",
        stderr: "",
      });

      const azureConnectionString =
        "DefaultEndpointsProtocol=https;AccountName=testaccount;AccountKey=testkey;EndpointSuffix=core.windows.net";

      const result = await (restoreExecutorService as any).createRollbackBackup(
        connectionConfig,
        azureConnectionString,
        "postgres:15-alpine",
        "testdb",
        "https://testaccount.blob.core.windows.net/backups/testdb/backup.sql",
      );

      expect(result).toContain("testdb/rollback-");
      expect(result).toContain("testaccount.blob.core.windows.net");
      expect(mockAzureStorageService.generateBlobSasUrl).toHaveBeenCalledWith(
        "backups",
        expect.stringContaining("testdb/rollback-"),
        expect.any(Number),
        "write",
      );
      expect(mockDockerExecutor.executeContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          image: "postgres:15-alpine",
          env: expect.objectContaining({
            POSTGRES_HOST: "localhost",
            POSTGRES_PORT: "5432",
            POSTGRES_USER: "testuser",
            POSTGRES_PASSWORD: "testpass",
            POSTGRES_DATABASE: "testdb",
            AZURE_SAS_URL: expect.stringContaining("sas-token"),
          }),
          timeout: 30 * 60 * 1000,
        }),
      );
    });

    it("should throw error when rollback backup fails", async () => {
      mockDockerExecutor.executeContainer = vi.fn().mockResolvedValue({
        exitCode: 1,
        stdout: "",
        stderr: "Backup failed",
      });

      const azureConnectionString =
        "DefaultEndpointsProtocol=https;AccountName=testaccount;AccountKey=testkey;EndpointSuffix=core.windows.net";

      await expect(
        (restoreExecutorService as any).createRollbackBackup(
          connectionConfig,
          azureConnectionString,
          "postgres:15-alpine",
          "testdb",
          "https://testaccount.blob.core.windows.net/backups/testdb/backup.sql",
        ),
      ).rejects.toThrow("Failed to create rollback backup: Backup failed");
    });
  });

  describe("executeRollback", () => {
    const connectionConfig = {
      host: "localhost",
      port: 5432,
      username: "testuser",
      password: "testpass",
      database: "testdb",
    };

    const rollbackUrl =
      "https://account.blob.core.windows.net/rollback-backups/testdb/rollback-123.sql";

    it("should execute rollback successfully", async () => {
      mockDockerExecutor.executeContainer = vi.fn().mockResolvedValue({
        exitCode: 0,
        stdout: "Restore completed",
        stderr: "",
      });

      const azureConnectionString =
        "DefaultEndpointsProtocol=https;AccountName=testaccount;AccountKey=testkey;EndpointSuffix=core.windows.net";

      await (restoreExecutorService as any).executeRollback(
        connectionConfig,
        rollbackUrl,
        azureConnectionString,
        "postgres:15-alpine",
      );

      expect(mockAzureStorageService.generateBlobSasUrl).toHaveBeenCalledWith(
        "rollback-backups",
        "testdb/rollback-123.sql",
        expect.any(Number),
        "read",
      );
      expect(mockDockerExecutor.executeContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          image: "postgres:15-alpine",
          env: expect.objectContaining({
            POSTGRES_HOST: "localhost",
            POSTGRES_USER: "testuser",
            POSTGRES_PASSWORD: "testpass",
            POSTGRES_DATABASE: "testdb",
            AZURE_SAS_URL: expect.stringContaining("sas-token"),
            RESTORE: "yes",
            DROP_PUBLIC: "yes",
          }),
          timeout: 60 * 60 * 1000,
        }),
      );

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          rollbackBackupUrl: rollbackUrl,
          executionTimeMs: expect.any(Number),
          exitCode: 0,
          stderrLength: expect.any(Number),
          stdoutLength: expect.any(Number),
        }),
        "Rollback container execution completed",
      );
    });

    it("should throw error when rollback fails", async () => {
      mockDockerExecutor.executeContainer = vi.fn().mockResolvedValue({
        exitCode: 1,
        stdout: "",
        stderr: "Rollback failed",
      });

      const azureConnectionString =
        "DefaultEndpointsProtocol=https;AccountName=testaccount;AccountKey=testkey;EndpointSuffix=core.windows.net";

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
      port: 5432,
      username: "testuser",
      password: "testpass",
      database: "testdb",
    };

    it("should verify database successfully", async () => {
      mockPostgresDatabaseManager.testConnection = vi.fn().mockResolvedValue({
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
      mockPostgresDatabaseManager.testConnection = vi.fn().mockResolvedValue({
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
      mockPostgresDatabaseManager.testConnection = vi
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
      mockAzureStorageService.get = vi
        .fn()
        .mockResolvedValue("azure-connection-string");
      mockBlobServiceClient.getContainerClient = vi
        .fn()
        .mockReturnValue(mockContainerClient);
    });

    it("should cleanup rollback backup successfully", async () => {
      mockBlobClient.exists = vi.fn().mockResolvedValue(true);
      mockBlobClient.deleteIfExists = vi
        .fn()
        .mockResolvedValue({ succeeded: true });

      await (restoreExecutorService as any).cleanupRollbackBackup(rollbackUrl);

      expect(mockBlobClient.deleteIfExists).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          rollbackBackupUrl: rollbackUrl,
          cleanupTimeMs: expect.any(Number),
        }),
        "Rollback backup deleted successfully",
      );
    });

    it("should handle cleanup errors gracefully", async () => {
      mockBlobClient.exists = vi.fn().mockResolvedValue(true);
      mockBlobClient.deleteIfExists = vi
        .fn()
        .mockRejectedValue(new Error("Azure error"));

      // Should not throw, just log warning
      await (restoreExecutorService as any).cleanupRollbackBackup(rollbackUrl);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          error: "Azure error",
          stack: expect.any(String),
          rollbackBackupUrl: rollbackUrl,
          cleanupTimeMs: expect.any(Number),
        }),
        "Failed to clean up rollback backup",
      );
    });

    it("should handle missing Azure connection string", async () => {
      mockAzureStorageService.get = vi.fn().mockResolvedValue(null);

      await (restoreExecutorService as any).cleanupRollbackBackup(rollbackUrl);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        {
          rollbackBackupUrl: rollbackUrl,
        },
        "Azure connection string not available for cleanup",
      );
    });
  });

  describe("updateRestoreProgress", () => {
    it("should update progress successfully", async () => {
      mockPrisma.restoreOperation.update = vi.fn().mockResolvedValue({});

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
      mockPrisma.restoreOperation.update = vi.fn().mockResolvedValue({});

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
      mockPrisma.restoreOperation.update = vi
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
      mockQueue.close = vi.fn().mockResolvedValue(undefined);

      await restoreExecutorService.shutdown();

      expect(mockQueue.close).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(
        "RestoreExecutorService shut down successfully",
      );
    });

    it("should handle shutdown errors", async () => {
      mockQueue.close = vi.fn().mockRejectedValue(new Error("Close error"));

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
