import prisma from "../../lib/prisma";
import { PrismaClient } from "../../generated/prisma/client";
import { BackupExecutorService, BackupConfigurationManager } from "../backup";
import { DockerExecutorService } from "../docker-executor";
import { PostgresDatabaseManager } from "../postgres";
import { StorageService } from "../storage/storage-service";
import type { StorageBackend } from "@mini-infra/types";
import { BackupSubject } from "@mini-infra/types";
import * as loggerFactory from "../../lib/logger-factory";
import { NatsBus } from "../nats/nats-bus";
import type { BackupRunRequest, BackupRunReply } from "../nats/payload-schemas";

// ── NatsBus mock ──────────────────────────────────────────────────────────────
// Capture the respond handler so tests can invoke it directly to simulate
// a NATS request round-trip without a live NATS server.
type RespondHandler = (req: BackupRunRequest) => Promise<BackupRunReply>;

const { mockBus } = vi.hoisted(() => {
  let _respondHandler: RespondHandler | null = null;
  const bus = {
    respond: vi.fn((subject: string, handler: RespondHandler) => {
      _respondHandler = handler;
      return () => {};
    }),
    request: vi.fn(async (_subject: string, req: BackupRunRequest) => {
      if (!_respondHandler) throw new Error("No respond handler registered");
      return _respondHandler(req);
    }),
    publish: vi.fn().mockResolvedValue(undefined),
    jetstream: {
      publish: vi.fn().mockResolvedValue({}),
      ensureStream: vi.fn().mockResolvedValue(undefined),
      ensureConsumer: vi.fn().mockResolvedValue(undefined),
    },
    getHealth: vi.fn().mockReturnValue({ state: "connected" }),
    getRespondHandler: () => _respondHandler,
  };
  return { mockBus: bus };
});

vi.mock("../nats/nats-bus", () => ({
  NatsBus: { getInstance: vi.fn(() => mockBus) },
}));

vi.mock("../docker-executor");
vi.mock("../backup/backup-configuration-manager");
vi.mock("../postgres/postgres-database-manager");
vi.mock("../backup/database-network-resolver", () => ({
  resolveDatabaseNetworkName: vi.fn().mockResolvedValue("mini-infra-postgres-backup"),
}));
vi.mock("../backup/sidecar-env", () => ({
  buildSidecarUploadEnv: vi.fn().mockReturnValue({ AZURE_SAS_URL: "https://example.com/sas" }),
  redactSidecarEnv: vi.fn().mockReturnValue({ AZURE_SAS_URL: "[REDACTED]" }),
}));

vi.mock("../../lib/logger-factory", () => {
  const mockLoggerInstance = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  };
  return {
    getLogger: vi.fn(() => mockLoggerInstance),
    clearLoggerCache: vi.fn(),
    createChildLogger: vi.fn(() => mockLoggerInstance),
    selfBackupLogger: vi.fn(() => mockLoggerInstance),
    serializeError: (e: unknown) => e,
    appLogger: vi.fn(() => mockLoggerInstance),
    servicesLogger: vi.fn(() => mockLoggerInstance),
    httpLogger: vi.fn(() => mockLoggerInstance),
    prismaLogger: vi.fn(() => mockLoggerInstance),
    default: vi.fn(() => mockLoggerInstance),
  };
});

const { servicesLogger } = loggerFactory as unknown as { servicesLogger: () => typeof mockLogger };
const mockLogger = (servicesLogger as () => { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> })();

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

const mockDockerExecutor = {
  initialize: vi.fn(),
  executeContainerWithProgress: vi.fn(),
  pullImageWithAutoAuth: vi.fn().mockResolvedValue(undefined),
  createNetwork: vi.fn().mockResolvedValue(undefined),
} as unknown as DockerExecutorService;

const mockBackupConfigurationManager = {
  getBackupConfigByDatabaseId: vi.fn(),
  updateLastBackupTime: vi.fn(),
} as unknown as BackupConfigurationManager;

const mockPostgresDatabaseManager = {
  getDatabaseById: vi.fn(),
  getConnectionConfig: vi.fn(),
} as unknown as PostgresDatabaseManager;

const mockStorageBackend = {
  providerId: "azure",
  mintUploadHandle: vi.fn().mockResolvedValue({
    kind: "azure-sas-url",
    payload: {
      sasUrl: "https://acc.blob.core.windows.net/cont/blob?sas",
      containerName: "cont",
      blobName: "blob",
    },
    expiresAt: new Date(Date.now() + 3600 * 1000),
  }),
  head: vi.fn().mockResolvedValue({
    name: "blob",
    size: 1024,
    contentType: "application/octet-stream",
  }),
  getDownloadHandle: vi.fn().mockResolvedValue({
    redirectUrl: "https://acc.blob.core.windows.net/cont/blob?dl-sas",
  }),
} as unknown as StorageBackend;

vi.spyOn(StorageService, "getInstance").mockReturnValue({
  getActiveBackend: vi.fn().mockResolvedValue(mockStorageBackend),
} as unknown as StorageService);

describe("BackupExecutorService", () => {
  let backupExecutorService: BackupExecutorService;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the respond handler captured in the hoisted mock
    (mockBus.respond as ReturnType<typeof vi.fn>).mockImplementation((subject: string, handler: RespondHandler) => {
      (mockBus as unknown as { getRespondHandler: () => RespondHandler }).getRespondHandler = () => handler;
      // Re-wire request to use the new handler
      (mockBus.request as ReturnType<typeof vi.fn>).mockImplementation(async (_subject: string, req: BackupRunRequest) => {
        return handler(req);
      });
      return () => {};
    });

    backupExecutorService = new BackupExecutorService(mockPrisma);
    vi.spyOn(StorageService, "getInstance").mockReturnValue({
      getActiveBackend: vi.fn().mockResolvedValue(mockStorageBackend),
    } as unknown as StorageService);

    (backupExecutorService as unknown as { dockerExecutor: DockerExecutorService }).dockerExecutor = mockDockerExecutor;
    (backupExecutorService as unknown as { backupConfigService: BackupConfigurationManager }).backupConfigService =
      mockBackupConfigurationManager;
    (backupExecutorService as unknown as { databaseConfigService: PostgresDatabaseManager }).databaseConfigService =
      mockPostgresDatabaseManager;
  });

  describe("constructor", () => {
    it("should initialize with Prisma client", () => {
      expect(backupExecutorService).toBeInstanceOf(BackupExecutorService);
    });
  });

  describe("initialize", () => {
    it("should initialize Docker executor successfully", async () => {
      mockDockerExecutor.initialize = vi.fn().mockResolvedValue(undefined);

      await backupExecutorService.initialize();

      expect(mockDockerExecutor.initialize).toHaveBeenCalled();
      expect(mockBus.respond).toHaveBeenCalledWith(
        BackupSubject.run,
        expect.any(Function),
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          initializationTimeMs: expect.any(Number),
          maxConcurrent: 2,
          timeoutMs: 7200000,
        }),
        "BackupExecutorService initialized successfully",
      );
    });

    it("should handle Docker initialization failure gracefully", async () => {
      mockDockerExecutor.initialize = vi
        .fn()
        .mockRejectedValue(new Error("Docker initialization failed"));

      await backupExecutorService.initialize();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        { error: "Docker initialization failed" },
        "Failed to initialize Docker executor - backup operations will be unavailable until Docker is configured",
      );
      // NATS responder should still be registered despite Docker failure
      expect(mockBus.respond).toHaveBeenCalledWith(BackupSubject.run, expect.any(Function));
    });

    it("should not reinitialize if already initialized", async () => {
      mockDockerExecutor.initialize = vi.fn().mockResolvedValue(undefined);

      await backupExecutorService.initialize();
      await backupExecutorService.initialize();

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
      storageObjectUrl: null,
      storageProviderAtCreation: null,
      errorMessage: null,
      metadata: null,
    };

    beforeEach(() => {
      mockDockerExecutor.initialize = vi.fn().mockResolvedValue(undefined);
      mockPrisma.backupOperation.create = vi.fn().mockResolvedValue(mockBackupOperation);
      mockPrisma.backupOperation.findUnique = vi.fn().mockResolvedValue(mockBackupOperation);
    });

    it("should create and return backup operation via NATS request", async () => {
      await backupExecutorService.initialize();

      const result = await backupExecutorService.queueBackup("db-123", "manual", "user-123");

      expect(result).toMatchObject({
        id: "operation-123",
        databaseId: "db-123",
        operationType: "manual",
        status: "pending",
        startedAt: "2023-01-01T00:00:00.000Z",
        completedAt: null,
        sizeBytes: null,
        storageObjectUrl: null,
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
    });

    it("should initialize if not already initialized", async () => {
      (backupExecutorService as unknown as { isInitialized: boolean }).isInitialized = false;

      await backupExecutorService.queueBackup("db-123", "manual", "user-123");

      expect(mockDockerExecutor.initialize).toHaveBeenCalled();
    });

    it("should throw when at max concurrency", async () => {
      await backupExecutorService.initialize();
      // Saturate the concurrency counter
      (backupExecutorService as unknown as { activeOperationCount: number }).activeOperationCount = 2;

      await expect(
        backupExecutorService.queueBackup("db-123", "manual", "user-123"),
      ).rejects.toThrow(/max concurrent backups/);
    });

    it("should handle database operation creation failure", async () => {
      await backupExecutorService.initialize();
      mockPrisma.backupOperation.create = vi
        .fn()
        .mockRejectedValue(new Error("Database error"));

      await expect(
        backupExecutorService.queueBackup("db-123", "manual", "user-123"),
      ).rejects.toThrow("Database error");
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
      storageObjectUrl: null,
      storageProviderAtCreation: null,
      errorMessage: null,
      metadata: null,
    };

    it("should return backup operation status", async () => {
      mockPrisma.backupOperation.findUnique = vi.fn().mockResolvedValue(mockOperation);

      const result = await backupExecutorService.getBackupStatus("operation-123");

      expect(result).toMatchObject({
        id: "operation-123",
        databaseId: "db-123",
        status: "running",
        progress: 50,
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
        { error: "Database error", operationId: "operation-123" },
        "Failed to get backup status",
      );
    });
  });

  describe("cancelBackup", () => {
    const mockOperation = {
      id: "operation-123",
      databaseId: "db-123",
      status: "running",
      progress: 50,
    };

    it("should cancel backup operation successfully", async () => {
      mockPrisma.backupOperation.findUnique = vi.fn().mockResolvedValue(mockOperation);
      mockPrisma.backupOperation.update = vi.fn().mockResolvedValue({});

      const result = await backupExecutorService.cancelBackup("operation-123");

      expect(result).toBe(true);
      expect(mockPrisma.backupOperation.update).toHaveBeenCalledWith({
        where: { id: "operation-123" },
        data: expect.objectContaining({
          status: "failed",
          errorMessage: "Operation cancelled by user",
        }),
      });
    });

    it("should return false for non-existent operation", async () => {
      mockPrisma.backupOperation.findUnique = vi.fn().mockResolvedValue(null);

      const result = await backupExecutorService.cancelBackup("nonexistent");

      expect(result).toBe(false);
    });

    it("should return false for completed operation", async () => {
      const completedOperation = { ...mockOperation, status: "completed" };
      mockPrisma.backupOperation.findUnique = vi.fn().mockResolvedValue(completedOperation);

      const result = await backupExecutorService.cancelBackup("operation-123");

      expect(result).toBe(false);
    });

    it("should handle errors during cancellation", async () => {
      mockPrisma.backupOperation.findUnique = vi
        .fn()
        .mockRejectedValue(new Error("Database error"));

      const result = await backupExecutorService.cancelBackup("operation-123");

      expect(result).toBe(false);
      expect(mockLogger.error).toHaveBeenCalledWith(
        { error: "Database error", operationId: "operation-123" },
        "Failed to cancel backup operation",
      );
    });
  });

  describe("backup execution", () => {
    const mockDatabase = { id: "db-123", name: "test-db", database: "testdb" };

    const mockBackupConfig = {
      id: "config-123",
      storageLocationId: "test-backups",
      storagePathPrefix: "db-backups/",
      backupFormat: "custom",
      compressionLevel: 6,
    };

    const mockConnectionConfig = {
      host: "localhost",
      port: 5432,
      username: "testuser",
      password: "testpass",
      database: "testdb",
    };

    const mockBackupOperation = {
      id: "operation-123",
      databaseId: "db-123",
      operationType: "manual",
      status: "pending",
      progress: 0,
      startedAt: new Date(),
      completedAt: null,
      sizeBytes: null,
      storageObjectUrl: null,
      storageProviderAtCreation: null,
      errorMessage: null,
      metadata: null,
    };

    beforeEach(() => {
      mockPostgresDatabaseManager.getDatabaseById = vi.fn().mockResolvedValue(mockDatabase);
      mockBackupConfigurationManager.getBackupConfigByDatabaseId = vi.fn().mockResolvedValue(mockBackupConfig);
      mockPostgresDatabaseManager.getConnectionConfig = vi.fn().mockResolvedValue(mockConnectionConfig);
      mockStorageBackend.mintUploadHandle = vi.fn().mockResolvedValue({
        kind: "azure-sas-url",
        payload: { sasUrl: "https://acc.blob.core.windows.net/cont/blob?sas", containerName: "cont", blobName: "blob" },
        expiresAt: new Date(Date.now() + 3600 * 1000),
      });
      mockStorageBackend.head = vi.fn().mockResolvedValue({ name: "blob", size: 1000000 });
      mockStorageBackend.getDownloadHandle = vi.fn().mockResolvedValue({
        redirectUrl: "https://acc.blob.core.windows.net/cont/blob?dl-sas",
      });
      mockPrisma.backupOperation.create = vi.fn().mockResolvedValue(mockBackupOperation);
      mockPrisma.backupOperation.findUnique = vi.fn().mockResolvedValue(mockBackupOperation);
      mockPrisma.backupOperation.update = vi.fn().mockResolvedValue({});
      mockBackupConfigurationManager.updateLastBackupTime = vi.fn().mockResolvedValue(undefined);
    });

    it("should execute backup successfully and publish completed event", async () => {
      mockDockerExecutor.executeContainerWithProgress = vi
        .fn()
        .mockImplementation(async (_config: unknown, progressCallback: (p: { status: string; errorMessage?: string }) => void) => {
          progressCallback({ status: "starting" });
          progressCallback({ status: "running" });
          progressCallback({ status: "completed" });
          return { exitCode: 0, stdout: "Backup completed", stderr: "" };
        });

      await backupExecutorService.initialize();
      await backupExecutorService.queueBackup("db-123", "manual", "user-123");

      // Give the async fire-and-forget execution a tick to complete
      await new Promise((r) => setTimeout(r, 50));

      // Final DB write must capture the storage provider
      expect(mockPrisma.backupOperation.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "operation-123" },
          data: expect.objectContaining({ storageProviderAtCreation: "azure" }),
        }),
      );

      // JetStream publish for completed event
      expect(mockBus.jetstream.publish).toHaveBeenCalledWith(
        BackupSubject.completed,
        expect.objectContaining({ operationId: "operation-123", databaseId: "db-123" }),
      );
    });

    it("should publish failed event on container non-zero exit", async () => {
      mockDockerExecutor.executeContainerWithProgress = vi
        .fn()
        .mockResolvedValue({ exitCode: 1, stdout: "", stderr: "pg_dump failed" });

      await backupExecutorService.initialize();
      await backupExecutorService.queueBackup("db-123", "manual", "user-123");

      await new Promise((r) => setTimeout(r, 50));

      expect(mockBus.jetstream.publish).toHaveBeenCalledWith(
        BackupSubject.failed,
        expect.objectContaining({ operationId: "operation-123", errorMessage: expect.stringContaining("pg_dump failed") }),
      );
    });
  });

  describe("verifyBackupInStorage", () => {
    it("should verify backup files exist", async () => {
      mockStorageBackend.head = vi.fn().mockResolvedValue({
        name: "db-backups/testdb/backup.sql",
        size: 1000000,
      });
      mockStorageBackend.getDownloadHandle = vi.fn().mockResolvedValue({
        redirectUrl: "https://testaccount.blob.core.windows.net/test-container/backup.sql?sas",
      });

      const result = await (backupExecutorService as unknown as {
        verifyBackupInStorage: (b: StorageBackend, loc: string, obj: string) => Promise<{ success: boolean; sizeBytes?: bigint; objectUrl?: string }>;
      }).verifyBackupInStorage(
        mockStorageBackend,
        "test-container",
        "db-backups/testdb/backup.sql",
      );

      expect(result.success).toBe(true);
      expect(result.sizeBytes).toBe(BigInt(1000000));
      expect(result.objectUrl).toContain("test-container");
    });

    it("should return error when backup object is missing", async () => {
      mockStorageBackend.head = vi.fn().mockResolvedValue(null);

      const result = await (backupExecutorService as unknown as {
        verifyBackupInStorage: (b: StorageBackend, loc: string, obj: string) => Promise<{ success: boolean; error?: string }>;
      }).verifyBackupInStorage(
        mockStorageBackend,
        "test-container",
        "db-backups/testdb/backup.sql",
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Backup object not found");
    });

    it("should propagate backend errors as a failure result", async () => {
      mockStorageBackend.head = vi
        .fn()
        .mockRejectedValue(new Error("Storage backend unreachable"));

      const result = await (backupExecutorService as unknown as {
        verifyBackupInStorage: (b: StorageBackend, loc: string, obj: string) => Promise<{ success: boolean; error?: string }>;
      }).verifyBackupInStorage(
        mockStorageBackend,
        "test-container",
        "db-backups/testdb/backup.sql",
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Storage backend unreachable");
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

      const result = (backupExecutorService as unknown as { getBackupDockerImage: () => string }).getBackupDockerImage();

      expect(result).toBe("ghcr.io/mrgeoffrich/mini-infra-pg-backup:1.2.3");
    });

    it("should return default image when env var is not set", () => {
      delete process.env.PG_BACKUP_IMAGE_TAG;

      const result = (backupExecutorService as unknown as { getBackupDockerImage: () => string }).getBackupDockerImage();

      expect(result).toBe("ghcr.io/mrgeoffrich/mini-infra-pg-backup:dev");
    });
  });

  describe("updateBackupProgress", () => {
    it("should update progress and publish NATS event for running status", async () => {
      mockPrisma.backupOperation.update = vi.fn().mockResolvedValue({});

      await (backupExecutorService as unknown as {
        updateBackupProgress: (id: string, dbId: string, data: { status: string; progress: number; message?: string }) => Promise<void>;
      }).updateBackupProgress("operation-123", "db-123", {
        status: "running",
        progress: 75,
        message: "Uploading to Azure",
      });

      expect(mockPrisma.backupOperation.update).toHaveBeenCalledWith({
        where: { id: "operation-123" },
        data: {
          status: "running",
          progress: 75,
          errorMessage: undefined,
        },
      });

      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          operationId: "operation-123",
          status: "running",
          progress: 75,
          message: "Uploading to Azure",
        }),
        "Backup progress updated",
      );

      // NATS progress event published for running status
      expect(mockBus.publish).toHaveBeenCalledWith(
        `${BackupSubject.progressPrefix}.operation-123`,
        expect.objectContaining({ operationId: "operation-123", status: "running", progress: 75 }),
        { unchecked: true },
      );
    });

    it("should set completedAt when status is completed", async () => {
      mockPrisma.backupOperation.update = vi.fn().mockResolvedValue({});

      const RealDate = Date;
      const fixedDate = new RealDate("2023-01-01T12:00:00.000Z");
      vi.spyOn(global, "Date").mockImplementation(function(this: unknown, dateString?: unknown) {
        if (dateString) return new RealDate(dateString as string);
        return fixedDate;
      } as unknown as DateConstructor);

      await (backupExecutorService as unknown as {
        updateBackupProgress: (id: string, dbId: string, data: { status: string; progress: number }) => Promise<void>;
      }).updateBackupProgress("operation-123", "db-123", {
        status: "completed",
        progress: 100,
      });

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

      await (backupExecutorService as unknown as {
        updateBackupProgress: (id: string, dbId: string, data: { status: string; progress: number; errorMessage?: string }) => Promise<void>;
      }).updateBackupProgress("operation-123", "db-123", {
        status: "failed",
        progress: 0,
        errorMessage: "Test error",
      });

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
    it("should log shutdown successfully", async () => {
      await backupExecutorService.shutdown();

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ activeOperationCount: 0 }),
        "BackupExecutorService shut down successfully",
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
        storageObjectUrl: "https://example.blob.core.windows.net/container/backup.sql",
        storageProviderAtCreation: "azure",
        errorMessage: null,
        progress: 100,
        metadata: '{"duration": 3600}',
      };

      const result = (backupExecutorService as unknown as {
        mapBackupOperationToInfo: (op: typeof operation) => BackupOperationInfo;
      }).mapBackupOperationToInfo(operation);

      expect(result).toEqual({
        id: "operation-123",
        databaseId: "db-123",
        operationType: "manual",
        status: "completed",
        startedAt: "2023-01-01T00:00:00.000Z",
        completedAt: "2023-01-01T01:00:00.000Z",
        sizeBytes: 1000000,
        storageObjectUrl: "https://example.blob.core.windows.net/container/backup.sql",
        storageProviderAtCreation: "azure",
        errorMessage: null,
        progress: 100,
        metadata: { duration: 3600 },
      });
    });

    it("should handle null completedAt", () => {
      const operation = {
        id: "operation-123",
        databaseId: "db-123",
        operationType: "manual",
        status: "running",
        startedAt: new Date("2023-01-01T00:00:00Z"),
        completedAt: null,
        sizeBytes: null,
        storageObjectUrl: null,
        storageProviderAtCreation: null,
        errorMessage: null,
        progress: 50,
        metadata: null,
      };

      const result = (backupExecutorService as unknown as {
        mapBackupOperationToInfo: (op: typeof operation) => BackupOperationInfo;
      }).mapBackupOperationToInfo(operation);

      expect(result.completedAt).toBeNull();
      expect(result.sizeBytes).toBeNull();
      expect(result.metadata).toBeNull();
    });
  });

  describe("getActiveOperationCount", () => {
    it("should return zero initially", () => {
      expect(backupExecutorService.getActiveOperationCount()).toBe(0);
    });
  });
});

type BackupOperationInfo = {
  id: string;
  databaseId: string;
  operationType: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  sizeBytes: number | null;
  storageObjectUrl: string | null | undefined;
  storageProviderAtCreation: string | null | undefined;
  errorMessage: string | null | undefined;
  progress: number;
  metadata: Record<string, unknown> | null;
};
