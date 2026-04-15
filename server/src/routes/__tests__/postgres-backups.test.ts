import request from "supertest";
import express from "express";
import { PrismaClient } from "../../generated/prisma/client";
import router from "../postgres-backups";
import { BackupExecutorService } from "../../services/backup";

const { mockPrismaDefault, mockBackupExecutorService } = vi.hoisted(() => ({
  mockPrismaDefault: {
    postgresDatabase: {
      findFirst: vi.fn(),
    },
    backupConfiguration: {
      findFirst: vi.fn(),
    },
    backupOperation: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      delete: vi.fn(),
    },
  },
  mockBackupExecutorService: {
    queueBackup: vi.fn(),
  },
}));

// Mock the Prisma module
vi.mock("../../lib/prisma", () => ({
  default: mockPrismaDefault,
}));

// Mock the PrismaClient for type exports
vi.mock("../../generated/prisma/client", () => ({
  PrismaClient: vi.fn(function() { return mockPrismaDefault; }),
}));

// Get the mock client for use in tests
const mockPrismaClient = mockPrismaDefault;

// Mock the BackupExecutorService
vi.mock("../../services/backup/backup-executor", () => ({
  BackupExecutorService: vi.fn(function() { return mockBackupExecutorService; }),
}));

// Mock logger
vi.mock("../../lib/logger-factory", () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
  clearLoggerCache: vi.fn(),
  createChildLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
  selfBackupLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
  serializeError: (e: unknown) => e,
  appLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
  servicesLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
  httpLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
  prismaLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
  default: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

// Mock the centralized auth middleware
vi.mock("../../middleware/auth", () => ({
  requireSessionOrApiKey: (req: any, res: any, next: any) => {
    // Set up authenticated user context for tests
    req.apiKey = {
      userId: "test-user-id",
      id: "test-key-id",
      user: { id: "test-user-id", email: "test@example.com" }
    };
    res.locals = {
      user: { id: "test-user-id", email: "test@example.com" },
      requestId: "test-request-id",
    };
    next();
  },
  getAuthenticatedUser: (req: any) => ({ id: "test-user-id", email: "test@example.com" }),
  getCurrentUserId: (req: any) => "test-user-id",
  requireAuth: (req: any, res: any, next: any) => {
    res.locals = {
      user: { id: "test-user-id" },
      requestId: "test-request-id",
    };
    next();
  },
  requirePermission: () => (req: any, res: any, next: any) => {
    req.apiKey = {
      userId: "test-user-id",
      id: "test-key-id",
      user: { id: "test-user-id", email: "test@example.com" },
      permissions: null,
    };
    res.locals = {
      user: { id: "test-user-id", email: "test@example.com" },
      requestId: "test-request-id",
    };
    next();
  },
}));

const app = express();
app.use(express.json());
app.use("/api/postgres", router);

describe("PostgreSQL Backups API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /api/postgres/backups/:databaseId", () => {
    const mockDatabase = {
      id: "test-db-id",
      userId: "test-user-id",
      name: "Test Database",
    };

    const mockBackupOperations = [
      {
        id: "backup-1",
        databaseId: "test-db-id",
        operationType: "manual",
        status: "completed",
        startedAt: new Date("2024-01-01T00:00:00Z"),
        completedAt: new Date("2024-01-01T00:05:00Z"),
        sizeBytes: BigInt(1024000),
        azureBlobUrl:
          "https://storage.blob.core.windows.net/backups/backup-1.sql",
        errorMessage: null,
        progress: 100,
        metadata: JSON.stringify({ currentStep: "Upload", totalSteps: 3 }),
      },
      {
        id: "backup-2",
        databaseId: "test-db-id",
        operationType: "scheduled",
        status: "failed",
        startedAt: new Date("2024-01-02T00:00:00Z"),
        completedAt: new Date("2024-01-02T00:02:00Z"),
        sizeBytes: null,
        azureBlobUrl: null,
        errorMessage: "Connection timeout",
        progress: 25,
        metadata: null,
      },
    ];

    it("should list backup operations for a database", async () => {
      mockPrismaClient.postgresDatabase.findFirst.mockResolvedValue(
        mockDatabase,
      );
      mockPrismaClient.backupOperation.count.mockResolvedValue(2);
      mockPrismaClient.backupOperation.findMany.mockResolvedValue(
        mockBackupOperations,
      );

      const response = await request(app)
        .get("/api/postgres/backups/test-db-id")
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveLength(2);
      expect(response.body.data[0]).toEqual({
        id: "backup-1",
        databaseId: "test-db-id",
        operationType: "manual",
        status: "completed",
        startedAt: "2024-01-01T00:00:00.000Z",
        completedAt: "2024-01-01T00:05:00.000Z",
        sizeBytes: 1024000,
        azureBlobUrl:
          "https://storage.blob.core.windows.net/backups/backup-1.sql",
        errorMessage: null,
        progress: 100,
        metadata: { currentStep: "Upload", totalSteps: 3 },
      });
      expect(response.body.pagination).toEqual({
        page: 1,
        limit: 20,
        totalCount: 2,
        hasMore: false,
      });
    });

    it("should handle pagination parameters", async () => {
      mockPrismaClient.postgresDatabase.findFirst.mockResolvedValue(
        mockDatabase,
      );
      mockPrismaClient.backupOperation.count.mockResolvedValue(50);
      mockPrismaClient.backupOperation.findMany.mockResolvedValue([
        mockBackupOperations[0],
      ]);

      const response = await request(app)
        .get("/api/postgres/backups/test-db-id?page=2&limit=10")
        .expect(200);

      expect(mockPrismaClient.backupOperation.findMany).toHaveBeenCalledWith({
        where: { databaseId: "test-db-id" },
        orderBy: { startedAt: "desc" },
        skip: 10,
        take: 10,
      });

      expect(response.body.pagination).toEqual({
        page: 2,
        limit: 10,
        totalCount: 50,
        hasMore: true,
      });
    });

    it("should handle filter parameters", async () => {
      mockPrismaClient.postgresDatabase.findFirst.mockResolvedValue(
        mockDatabase,
      );
      mockPrismaClient.backupOperation.count.mockResolvedValue(1);
      mockPrismaClient.backupOperation.findMany.mockResolvedValue([
        mockBackupOperations[0],
      ]);

      await request(app)
        .get(
          "/api/postgres/backups/test-db-id?status=completed&operationType=manual&startedAfter=2024-01-01T00:00:00Z&startedBefore=2024-01-02T00:00:00Z",
        )
        .expect(200);

      expect(mockPrismaClient.backupOperation.count).toHaveBeenCalledWith({
        where: {
          databaseId: "test-db-id",
          status: "completed",
          operationType: "manual",
          startedAt: {
            gte: new Date("2024-01-01T00:00:00Z"),
            lte: new Date("2024-01-02T00:00:00Z"),
          },
        },
      });
    });

    it("should handle sort parameters", async () => {
      mockPrismaClient.postgresDatabase.findFirst.mockResolvedValue(
        mockDatabase,
      );
      mockPrismaClient.backupOperation.count.mockResolvedValue(2);
      mockPrismaClient.backupOperation.findMany.mockResolvedValue(
        mockBackupOperations,
      );

      await request(app)
        .get("/api/postgres/backups/test-db-id?sortBy=sizeBytes&sortOrder=asc")
        .expect(200);

      expect(mockPrismaClient.backupOperation.findMany).toHaveBeenCalledWith({
        where: { databaseId: "test-db-id" },
        orderBy: { sizeBytes: "asc" },
        skip: 0,
        take: 20,
      });
    });

    it("should return 404 if database not found", async () => {
      mockPrismaClient.postgresDatabase.findFirst.mockResolvedValue(null);

      const response = await request(app)
        .get("/api/postgres/backups/nonexistent-db-id")
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Database not found");
    });

    it("should return 404 if user doesn't have access to database", async () => {
      mockPrismaClient.postgresDatabase.findFirst.mockResolvedValue(null);

      const response = await request(app)
        .get("/api/postgres/backups/other-user-db-id")
        .expect(404);

      expect(mockPrismaClient.postgresDatabase.findFirst).toHaveBeenCalledWith({
        where: {
          id: "other-user-db-id",
        },
      });

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Database not found");
    });

    it("should handle validation errors for query parameters", async () => {
      mockPrismaClient.postgresDatabase.findFirst.mockResolvedValue(
        mockDatabase,
      );

      const response = await request(app)
        .get("/api/postgres/backups/test-db-id?page=0&limit=101&status=invalid")
        .expect(500);

      expect(response.body.success).toBe(false);
    });

    it("should handle database errors", async () => {
      mockPrismaClient.postgresDatabase.findFirst.mockRejectedValue(
        new Error("Database connection failed"),
      );

      const response = await request(app)
        .get("/api/postgres/backups/test-db-id")
        .expect(500);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Internal server error");
    });
  });

  describe("POST /api/postgres/backups/:databaseId/manual", () => {
    const mockDatabase = {
      id: "test-db-id",
      userId: "test-user-id",
      name: "Test Database",
    };

    const mockBackupConfig = {
      id: "config-1",
      databaseId: "test-db-id",
      azureContainerName: "backups",
      schedule: "0 2 * * *",
      enabled: true,
    };

    const mockQueuedBackup = {
      id: "backup-operation-1",
      status: "pending",
      databaseId: "test-db-id",
      operationType: "manual",
    };

    it("should trigger manual backup successfully", async () => {
      mockPrismaClient.postgresDatabase.findFirst.mockResolvedValue(
        mockDatabase,
      );
      mockPrismaClient.backupConfiguration.findFirst.mockResolvedValue(
        mockBackupConfig,
      );
      mockPrismaClient.backupOperation.findFirst.mockResolvedValue(null);
      mockBackupExecutorService.queueBackup.mockResolvedValue(mockQueuedBackup);

      const response = await request(app)
        .post("/api/postgres/backups/test-db-id/manual")
        .expect(201);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toEqual({
        operationId: "backup-operation-1",
        status: "pending",
        message: "Backup operation queued successfully",
      });

      expect(mockBackupExecutorService.queueBackup).toHaveBeenCalledWith(
        "test-db-id",
        "manual",
        "test-user-id",
      );
    });

    it("should return 404 if database not found", async () => {
      mockPrismaClient.postgresDatabase.findFirst.mockResolvedValue(null);

      const response = await request(app)
        .post("/api/postgres/backups/nonexistent-db-id/manual")
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Database not found");
    });

    it("should return 400 if backup configuration not found", async () => {
      mockPrismaClient.postgresDatabase.findFirst.mockResolvedValue(
        mockDatabase,
      );
      mockPrismaClient.backupConfiguration.findFirst.mockResolvedValue(null);

      const response = await request(app)
        .post("/api/postgres/backups/test-db-id/manual")
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Backup configuration required");
      expect(response.body.message).toBe(
        "Please configure backup settings before creating a backup",
      );
    });

    it("should return 409 if backup already in progress", async () => {
      const runningBackup = {
        id: "running-backup-1",
        status: "running",
        databaseId: "test-db-id",
      };

      mockPrismaClient.postgresDatabase.findFirst.mockResolvedValue(
        mockDatabase,
      );
      mockPrismaClient.backupConfiguration.findFirst.mockResolvedValue(
        mockBackupConfig,
      );
      mockPrismaClient.backupOperation.findFirst.mockResolvedValue(
        runningBackup,
      );

      const response = await request(app)
        .post("/api/postgres/backups/test-db-id/manual")
        .expect(409);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Backup in progress");
      expect(response.body.message).toBe(
        "A backup is already in progress for this database",
      );

      expect(mockPrismaClient.backupOperation.findFirst).toHaveBeenCalledWith({
        where: {
          databaseId: "test-db-id",
          status: { in: ["pending", "running"] },
        },
      });
    });

    it("should handle errors from backup executor service", async () => {
      mockPrismaClient.postgresDatabase.findFirst.mockResolvedValue(
        mockDatabase,
      );
      mockPrismaClient.backupConfiguration.findFirst.mockResolvedValue(
        mockBackupConfig,
      );
      mockPrismaClient.backupOperation.findFirst.mockResolvedValue(null);
      mockBackupExecutorService.queueBackup.mockRejectedValue(
        new Error("Queue service unavailable"),
      );

      const response = await request(app)
        .post("/api/postgres/backups/test-db-id/manual")
        .expect(500);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Internal server error");
      expect(response.body.message).toBe("Failed to trigger backup operation");
    });

    it("should handle database errors", async () => {
      mockPrismaClient.postgresDatabase.findFirst.mockRejectedValue(
        new Error("Database connection failed"),
      );

      const response = await request(app)
        .post("/api/postgres/backups/test-db-id/manual")
        .expect(500);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Internal server error");
    });
  });

  describe("GET /api/postgres/backups/:backupId/status", () => {
    const mockBackupOperation = {
      id: "backup-1",
      databaseId: "test-db-id",
      status: "running",
      progress: 75,
      startedAt: new Date("2024-01-01T00:00:00Z"),
      completedAt: null,
      errorMessage: null,
      sizeBytes: null,
      azureBlobUrl: null,
      metadata: JSON.stringify({ currentStep: "Uploading", totalSteps: 3 }),
      database: {
        id: "test-db-id",
        userId: "test-user-id",
      },
    };

    it("should return backup operation status", async () => {
      mockPrismaClient.backupOperation.findFirst.mockResolvedValue(
        mockBackupOperation,
      );

      const response = await request(app)
        .get("/api/postgres/backups/backup-1/status")
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toEqual({
        id: "backup-1",
        status: "running",
        progress: 75,
        startedAt: "2024-01-01T00:00:00.000Z",
        completedAt: null,
        errorMessage: null,
        sizeBytes: null,
        azureBlobUrl: null,
        metadata: { currentStep: "Uploading", totalSteps: 3 },
      });
      expect(response.body.message).toBe("Backup operation is running");

      expect(mockPrismaClient.backupOperation.findFirst).toHaveBeenCalledWith({
        where: {
          id: "backup-1",
        },
        include: {
          database: true,
        },
      });
    });

    it("should return completed backup operation status", async () => {
      const completedOperation = {
        ...mockBackupOperation,
        status: "completed",
        progress: 100,
        completedAt: new Date("2024-01-01T00:05:00Z"),
        sizeBytes: BigInt(2048000),
        azureBlobUrl:
          "https://storage.blob.core.windows.net/backups/backup-1.sql",
      };

      mockPrismaClient.backupOperation.findFirst.mockResolvedValue(
        completedOperation,
      );

      const response = await request(app)
        .get("/api/postgres/backups/backup-1/status")
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.status).toBe("completed");
      expect(response.body.data.progress).toBe(100);
      expect(response.body.data.completedAt).toBe("2024-01-01T00:05:00.000Z");
      expect(response.body.data.sizeBytes).toBe(2048000);
      expect(response.body.data.azureBlobUrl).toBe(
        "https://storage.blob.core.windows.net/backups/backup-1.sql",
      );
    });

    it("should return 404 if backup operation not found", async () => {
      mockPrismaClient.backupOperation.findFirst.mockResolvedValue(null);

      const response = await request(app)
        .get("/api/postgres/backups/nonexistent-backup/status")
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Backup operation not found");
    });

    it("should return 404 if user doesn't have access to backup operation", async () => {
      mockPrismaClient.backupOperation.findFirst.mockResolvedValue(null);

      const response = await request(app)
        .get("/api/postgres/backups/other-user-backup/status")
        .expect(404);

      expect(mockPrismaClient.backupOperation.findFirst).toHaveBeenCalledWith({
        where: {
          id: "other-user-backup",
        },
        include: {
          database: true,
        },
      });

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Backup operation not found");
    });

    it("should handle database errors", async () => {
      mockPrismaClient.backupOperation.findFirst.mockRejectedValue(
        new Error("Database connection failed"),
      );

      const response = await request(app)
        .get("/api/postgres/backups/backup-1/status")
        .expect(500);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Internal server error");
    });
  });

  describe("DELETE /api/postgres/backups/:backupId", () => {
    const mockBackupOperation = {
      id: "backup-1",
      databaseId: "test-db-id",
      status: "completed",
      azureBlobUrl:
        "https://storage.blob.core.windows.net/backups/backup-1.sql",
      database: {
        id: "test-db-id",
        userId: "test-user-id",
      },
    };

    it("should delete backup operation successfully", async () => {
      mockPrismaClient.backupOperation.findFirst.mockResolvedValue(
        mockBackupOperation,
      );
      mockPrismaClient.backupOperation.delete.mockResolvedValue(
        mockBackupOperation,
      );

      const response = await request(app)
        .delete("/api/postgres/backups/backup-1")
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe(
        "Backup operation deleted successfully",
      );

      expect(mockPrismaClient.backupOperation.delete).toHaveBeenCalledWith({
        where: { id: "backup-1" },
      });
    });

    it("should return 404 if backup operation not found", async () => {
      mockPrismaClient.backupOperation.findFirst.mockResolvedValue(null);

      const response = await request(app)
        .delete("/api/postgres/backups/nonexistent-backup")
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Backup operation not found");
    });

    it("should return 400 if trying to delete running backup", async () => {
      const runningOperation = {
        ...mockBackupOperation,
        status: "running",
      };

      mockPrismaClient.backupOperation.findFirst.mockResolvedValue(
        runningOperation,
      );

      const response = await request(app)
        .delete("/api/postgres/backups/backup-1")
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Backup in progress");
      expect(response.body.message).toBe(
        "Cannot delete a backup operation that is currently running",
      );

      expect(mockPrismaClient.backupOperation.delete).not.toHaveBeenCalled();
    });

    it("should return 400 if trying to delete pending backup", async () => {
      const pendingOperation = {
        ...mockBackupOperation,
        status: "pending",
      };

      mockPrismaClient.backupOperation.findFirst.mockResolvedValue(
        pendingOperation,
      );

      const response = await request(app)
        .delete("/api/postgres/backups/backup-1")
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Backup in progress");
    });

    it("should handle database errors during deletion", async () => {
      mockPrismaClient.backupOperation.findFirst.mockResolvedValue(
        mockBackupOperation,
      );
      mockPrismaClient.backupOperation.delete.mockRejectedValue(
        new Error("Database delete failed"),
      );

      const response = await request(app)
        .delete("/api/postgres/backups/backup-1")
        .expect(500);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Internal server error");
    });

    it("should handle database errors during lookup", async () => {
      mockPrismaClient.backupOperation.findFirst.mockRejectedValue(
        new Error("Database connection failed"),
      );

      const response = await request(app)
        .delete("/api/postgres/backups/backup-1")
        .expect(500);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Internal server error");
    });
  });

  describe("GET /api/postgres/backups/:backupId/progress", () => {
    const mockBackupOperation = {
      id: "backup-1",
      databaseId: "test-db-id",
      status: "running",
      progress: 60,
      startedAt: new Date("2024-01-01T00:00:00Z"),
      completedAt: null,
      errorMessage: null,
      metadata: JSON.stringify({
        currentStep: "Uploading to Azure",
        totalSteps: 3,
        completedSteps: 2,
      }),
      database: {
        id: "test-db-id",
        userId: "test-user-id",
      },
    };

    it("should return detailed progress information", async () => {
      mockPrismaClient.backupOperation.findFirst.mockResolvedValue(
        mockBackupOperation,
      );

      const response = await request(app)
        .get("/api/postgres/backups/backup-1/progress")
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toEqual({
        id: "backup-1",
        databaseId: "test-db-id",
        status: "running",
        progress: 60,
        startedAt: "2024-01-01T00:00:00.000Z",
        estimatedCompletion: expect.any(String),
        currentStep: "Uploading to Azure",
        totalSteps: 3,
        completedSteps: 2,
        errorMessage: undefined,
        metadata: {
          currentStep: "Uploading to Azure",
          totalSteps: 3,
          completedSteps: 2,
        },
      });
    });

    it("should calculate estimated completion time for running operations", async () => {
      const currentTime = Date.now();
      const startTime = new Date(currentTime - 60000); // Started 1 minute ago
      const operationWithProgress = {
        ...mockBackupOperation,
        progress: 50,
        startedAt: startTime,
      };

      mockPrismaClient.backupOperation.findFirst.mockResolvedValue(
        operationWithProgress,
      );

      const response = await request(app)
        .get("/api/postgres/backups/backup-1/progress")
        .expect(200);

      expect(response.body.data.estimatedCompletion).toBeDefined();

      // The estimated completion should be roughly 1 minute in the future
      // (since we're 50% done and it took 1 minute so far)
      const estimatedTime = new Date(response.body.data.estimatedCompletion);
      const expectedTime = new Date(currentTime + 60000);
      expect(
        Math.abs(estimatedTime.getTime() - expectedTime.getTime()),
      ).toBeLessThan(10000); // Within 10 seconds
    });

    it("should not calculate estimated completion for completed operations", async () => {
      const completedOperation = {
        ...mockBackupOperation,
        status: "completed",
        progress: 100,
        completedAt: new Date("2024-01-01T00:05:00Z"),
      };

      mockPrismaClient.backupOperation.findFirst.mockResolvedValue(
        completedOperation,
      );

      const response = await request(app)
        .get("/api/postgres/backups/backup-1/progress")
        .expect(200);

      expect(response.body.data.estimatedCompletion).toBeUndefined();
    });

    it("should not calculate estimated completion for operations with zero progress", async () => {
      const zeroProgressOperation = {
        ...mockBackupOperation,
        progress: 0,
      };

      mockPrismaClient.backupOperation.findFirst.mockResolvedValue(
        zeroProgressOperation,
      );

      const response = await request(app)
        .get("/api/postgres/backups/backup-1/progress")
        .expect(200);

      expect(response.body.data.estimatedCompletion).toBeUndefined();
    });

    it("should handle operations with no metadata", async () => {
      const operationWithoutMetadata = {
        ...mockBackupOperation,
        metadata: null,
      };

      mockPrismaClient.backupOperation.findFirst.mockResolvedValue(
        operationWithoutMetadata,
      );

      const response = await request(app)
        .get("/api/postgres/backups/backup-1/progress")
        .expect(200);

      expect(response.body.data.currentStep).toBeUndefined();
      expect(response.body.data.totalSteps).toBeUndefined();
      expect(response.body.data.completedSteps).toBeUndefined();
      expect(response.body.data.metadata).toBeNull();
    });

    it("should handle failed operations with error messages", async () => {
      const failedOperation = {
        ...mockBackupOperation,
        status: "failed",
        progress: 25,
        errorMessage: "Connection to database timed out",
        completedAt: new Date("2024-01-01T00:02:30Z"),
      };

      mockPrismaClient.backupOperation.findFirst.mockResolvedValue(
        failedOperation,
      );

      const response = await request(app)
        .get("/api/postgres/backups/backup-1/progress")
        .expect(200);

      expect(response.body.data.status).toBe("failed");
      expect(response.body.data.errorMessage).toBe(
        "Connection to database timed out",
      );
      expect(response.body.data.estimatedCompletion).toBeUndefined();
    });

    it("should return 404 if backup operation not found", async () => {
      mockPrismaClient.backupOperation.findFirst.mockResolvedValue(null);

      const response = await request(app)
        .get("/api/postgres/backups/nonexistent-backup/progress")
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Backup operation not found");
    });

    it("should return 404 if user doesn't have access to backup operation", async () => {
      mockPrismaClient.backupOperation.findFirst.mockResolvedValue(null);

      const response = await request(app)
        .get("/api/postgres/backups/other-user-backup/progress")
        .expect(404);

      expect(mockPrismaClient.backupOperation.findFirst).toHaveBeenCalledWith({
        where: {
          id: "other-user-backup",
        },
        include: {
          database: true,
        },
      });

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Backup operation not found");
    });

    it("should handle database errors", async () => {
      mockPrismaClient.backupOperation.findFirst.mockRejectedValue(
        new Error("Database connection failed"),
      );

      const response = await request(app)
        .get("/api/postgres/backups/backup-1/progress")
        .expect(500);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Internal server error");
    });
  });
});
