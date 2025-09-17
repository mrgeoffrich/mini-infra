// Mock the PrismaClient BEFORE any imports
const mockPrismaInstance = {
  postgresDatabase: {
    findFirst: jest.fn(),
  },
  restoreOperation: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
  },
};

jest.mock("../../generated/prisma", () => ({
  PrismaClient: jest.fn(() => mockPrismaInstance),
}));

// Mock the prisma instance that the route actually imports
jest.mock("../../lib/prisma", () => mockPrismaInstance);

// Mock all services that RestoreExecutorService depends on
jest.mock("../../services/docker-executor");
jest.mock("../../services/postgres-config");

// Create mock service instances
const mockRestoreExecutorService = {
  queueRestore: jest.fn(),
};

const mockAzureConfigService = {
  get: jest.fn(),
};

// Mock the RestoreExecutorService
jest.mock("../../services/restore-executor", () => ({
  RestoreExecutorService: jest.fn(() => mockRestoreExecutorService),
}));

// Mock the restore executor instance functions
jest.mock("../../services/restore-executor-instance", () => ({
  getRestoreExecutorService: jest.fn(() => mockRestoreExecutorService),
  setRestoreExecutorService: jest.fn(),
}));

// Mock the AzureConfigService
jest.mock("../../services/azure-config", () => ({
  AzureConfigService: jest.fn(() => mockAzureConfigService),
}));

// Create Azure Storage mock instances
const mockContainerClient = {
  listBlobsFlat: jest.fn(),
  getBlobClient: jest.fn((blobName: string) => ({
    url: `https://storage.blob.core.windows.net/backups/${blobName}`,
  })),
};

const mockBlobServiceClient = {
  getContainerClient: jest.fn(() => mockContainerClient),
};

// Mock Azure Storage
jest.mock("@azure/storage-blob", () => ({
  BlobServiceClient: {
    fromConnectionString: jest.fn(() => mockBlobServiceClient),
  },
}));

// Mock logger
jest.mock("../../lib/logger-factory", () => ({
  appLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  })),
  servicesLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  })),
  httpLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  })),
  prismaLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  })),
  __esModule: true,
  default: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  })),
}));

// Mock auth middleware - need to mock the api-key-middleware functions that are re-exported through middleware/auth
jest.mock("../../lib/api-key-middleware", () => ({
  requireSessionOrApiKey: (req: any, res: any, next: any) => {
    // Set up authenticated user context for tests
    req.apiKey = {
      userId: "test-user-id",
      id: "test-key-id",
      user: { id: "test-user-id", email: "test@example.com" }
    };
    res.locals = {
      requestId: "test-request-id",
    };
    next();
  },
  getCurrentUserId: (req: any) => "test-user-id",
  getCurrentUser: (req: any) => ({ id: "test-user-id", email: "test@example.com" })
}));

// Mock auth middleware functions
jest.mock("../../lib/auth-middleware", () => ({
  getAuthenticatedUser: (req: any) => ({ id: "test-user-id", email: "test@example.com" }),
}));

// Mock InMemoryQueue
jest.mock("../../lib/in-memory-queue", () => {
  return {
    InMemoryQueue: jest.fn().mockImplementation(() => ({
      add: jest.fn(),
      process: jest.fn(),
      getJobs: jest.fn(),
      close: jest.fn(),
      on: jest.fn(),
      remove: jest.fn(),
    })),
  };
});

import request from "supertest";
import express from "express";
import { PrismaClient } from "../../generated/prisma";
import { RestoreExecutorService } from "../../services/restore-executor";
import { AzureConfigService } from "../../services/azure-config";
import { BlobServiceClient } from "@azure/storage-blob";
import router from "../postgres-restore";

// Get the mocked instances
const mockPrismaClient = mockPrismaInstance;
// Use the shared mock instances defined above
// mockRestoreExecutorService and mockAzureConfigService are already defined

// Azure Storage mock instances are now defined above in the mock setup section

const app = express();
app.use(express.json());
app.use("/api/postgres", router);

describe("PostgreSQL Restore API", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("POST /api/postgres/restore/:databaseId", () => {
    const mockDatabase = {
      id: "test-db-id",
      userId: "test-user-id",
      database: "testdb",
      name: "Test Database",
    };

    const mockQueuedRestore = {
      id: "restore-operation-1",
      status: "pending",
      databaseId: "test-db-id",
      backupUrl: "https://storage.blob.core.windows.net/backups/backup.sql",
    };

    it("should initiate restore operation successfully", async () => {
      mockPrismaClient.postgresDatabase.findFirst.mockResolvedValue(
        mockDatabase,
      );
      mockPrismaClient.restoreOperation.findFirst.mockResolvedValue(null);
      mockRestoreExecutorService.queueRestore.mockResolvedValue(
        mockQueuedRestore,
      );

      const response = await request(app)
        .post("/api/postgres/restore/test-db-id")
        .send({
          backupUrl: "https://storage.blob.core.windows.net/backups/backup.sql",
          confirmRestore: true,
        })
        .expect(201);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toEqual({
        operationId: "restore-operation-1",
        status: "pending",
        message: "Restore operation queued successfully",
        backupUrl: "https://storage.blob.core.windows.net/backups/backup.sql",
        databaseName: "testdb",
      });

      expect(mockRestoreExecutorService.queueRestore).toHaveBeenCalledWith(
        "test-db-id",
        "https://storage.blob.core.windows.net/backups/backup.sql",
        "test-user-id",
        undefined,
      );
    });

    it("should return 404 if database not found", async () => {
      mockPrismaClient.postgresDatabase.findFirst.mockResolvedValue(null);

      const response = await request(app)
        .post("/api/postgres/restore/nonexistent-db-id")
        .send({
          backupUrl: "https://storage.blob.core.windows.net/backups/backup.sql",
          confirmRestore: true,
        })
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Database not found");
    });

    it("should return 400 if confirmation not provided", async () => {
      mockPrismaClient.postgresDatabase.findFirst.mockResolvedValue(
        mockDatabase,
      );

      const response = await request(app)
        .post("/api/postgres/restore/test-db-id")
        .send({
          backupUrl: "https://storage.blob.core.windows.net/backups/backup.sql",
        })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Confirmation required");
      expect(response.body.message).toBe(
        "Restore operations require explicit confirmation. Set confirmRestore to true.",
      );
    });

    it("should return 400 if confirmation is false", async () => {
      mockPrismaClient.postgresDatabase.findFirst.mockResolvedValue(
        mockDatabase,
      );

      const response = await request(app)
        .post("/api/postgres/restore/test-db-id")
        .send({
          backupUrl: "https://storage.blob.core.windows.net/backups/backup.sql",
          confirmRestore: false,
        })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Confirmation required");
    });

    it("should return 409 if restore already in progress", async () => {
      const runningRestore = {
        id: "running-restore-1",
        status: "running",
        databaseId: "test-db-id",
      };

      mockPrismaClient.postgresDatabase.findFirst.mockResolvedValue(
        mockDatabase,
      );
      mockPrismaClient.restoreOperation.findFirst.mockResolvedValue(
        runningRestore,
      );

      const response = await request(app)
        .post("/api/postgres/restore/test-db-id")
        .send({
          backupUrl: "https://storage.blob.core.windows.net/backups/backup.sql",
          confirmRestore: true,
        })
        .expect(409);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Restore in progress");
      expect(response.body.message).toBe(
        "A restore is already in progress for this database",
      );

      expect(mockPrismaClient.restoreOperation.findFirst).toHaveBeenCalledWith({
        where: {
          databaseId: "test-db-id",
          status: { in: ["pending", "running"] },
        },
      });
    });

    it("should return 400 for invalid backup URL", async () => {
      mockPrismaClient.postgresDatabase.findFirst.mockResolvedValue(
        mockDatabase,
      );

      const response = await request(app)
        .post("/api/postgres/restore/test-db-id")
        .send({
          backupUrl: "invalid-url",
          confirmRestore: true,
        })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Validation error");
    });

    it("should return 400 for missing backup URL", async () => {
      mockPrismaClient.postgresDatabase.findFirst.mockResolvedValue(
        mockDatabase,
      );

      const response = await request(app)
        .post("/api/postgres/restore/test-db-id")
        .send({
          confirmRestore: true,
        })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Validation error");
    });

    it("should handle errors from restore executor service", async () => {
      mockPrismaClient.postgresDatabase.findFirst.mockResolvedValue(
        mockDatabase,
      );
      mockPrismaClient.restoreOperation.findFirst.mockResolvedValue(null);
      mockRestoreExecutorService.queueRestore.mockRejectedValue(
        new Error("Queue service unavailable"),
      );

      const response = await request(app)
        .post("/api/postgres/restore/test-db-id")
        .send({
          backupUrl: "https://storage.blob.core.windows.net/backups/backup.sql",
          confirmRestore: true,
        })
        .expect(500);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Internal server error");
      expect(response.body.message).toBe("Failed to create restore operation");
    });

    it("should handle database errors", async () => {
      mockPrismaClient.postgresDatabase.findFirst.mockRejectedValue(
        new Error("Database connection failed"),
      );

      const response = await request(app)
        .post("/api/postgres/restore/test-db-id")
        .send({
          backupUrl: "https://storage.blob.core.windows.net/backups/backup.sql",
          confirmRestore: true,
        })
        .expect(500);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Internal server error");
    });
  });

  describe("GET /api/postgres/restore/:operationId/status", () => {
    const mockRestoreOperation = {
      id: "restore-1",
      databaseId: "test-db-id",
      status: "running",
      progress: 60,
      startedAt: new Date("2024-01-01T00:00:00Z"),
      completedAt: null,
      errorMessage: null,
      backupUrl: "https://storage.blob.core.windows.net/backups/backup.sql",
      database: {
        id: "test-db-id",
        userId: "test-user-id",
        database: "testdb",
      },
    };

    it("should return restore operation status", async () => {
      mockPrismaClient.restoreOperation.findFirst.mockResolvedValue(
        mockRestoreOperation,
      );

      const response = await request(app)
        .get("/api/postgres/restore/restore-1/status")
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toEqual({
        id: "restore-1",
        status: "running",
        progress: 60,
        startedAt: "2024-01-01T00:00:00.000Z",
        completedAt: null,
        errorMessage: null,
        backupUrl: "https://storage.blob.core.windows.net/backups/backup.sql",
        databaseName: "testdb",
      });
      expect(response.body.message).toBe("Restore operation is running");

      expect(mockPrismaClient.restoreOperation.findFirst).toHaveBeenCalledWith({
        where: {
          id: "restore-1",
          database: { userId: "test-user-id" },
        },
        include: {
          database: true,
        },
      });
    });

    it("should return completed restore operation status", async () => {
      const completedOperation = {
        ...mockRestoreOperation,
        status: "completed",
        progress: 100,
        completedAt: new Date("2024-01-01T00:15:00Z"),
      };

      mockPrismaClient.restoreOperation.findFirst.mockResolvedValue(
        completedOperation,
      );

      const response = await request(app)
        .get("/api/postgres/restore/restore-1/status")
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.status).toBe("completed");
      expect(response.body.data.progress).toBe(100);
      expect(response.body.data.completedAt).toBe("2024-01-01T00:15:00.000Z");
    });

    it("should return 404 if restore operation not found", async () => {
      mockPrismaClient.restoreOperation.findFirst.mockResolvedValue(null);

      const response = await request(app)
        .get("/api/postgres/restore/nonexistent-restore/status")
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Restore operation not found");
    });

    it("should return 404 if user doesn't have access to restore operation", async () => {
      mockPrismaClient.restoreOperation.findFirst.mockResolvedValue(null);

      const response = await request(app)
        .get("/api/postgres/restore/other-user-restore/status")
        .expect(404);

      expect(mockPrismaClient.restoreOperation.findFirst).toHaveBeenCalledWith({
        where: {
          id: "other-user-restore",
          database: { userId: "test-user-id" },
        },
        include: {
          database: true,
        },
      });

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Restore operation not found");
    });

    it("should handle database errors", async () => {
      mockPrismaClient.restoreOperation.findFirst.mockRejectedValue(
        new Error("Database connection failed"),
      );

      const response = await request(app)
        .get("/api/postgres/restore/restore-1/status")
        .expect(500);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Internal server error");
    });
  });

  describe("GET /api/postgres/restore/backups/:containerName", () => {
    const mockBlobs = [
      {
        name: "testdb/backup_2024-01-01_00-00-00.sql",
        properties: {
          contentLength: 1024000,
          createdOn: new Date("2024-01-01T00:00:00Z"),
          lastModified: new Date("2024-01-01T00:00:00Z"),
          contentType: "application/sql",
          etag: '"0x8D9A1B2C3D4E5F6"',
        },
        metadata: {
          databaseName: "testdb",
          backupType: "full",
        },
      },
      {
        name: "testdb/backup_2024-01-02_00-00-00.dump",
        properties: {
          contentLength: 2048000,
          createdOn: new Date("2024-01-02T00:00:00Z"),
          lastModified: new Date("2024-01-02T00:00:00Z"),
          contentType: "application/octet-stream",
          etag: '"0x8D9A1B2C3D4E5F7"',
        },
        metadata: {
          databaseName: "testdb",
          backupType: "incremental",
        },
      },
    ];

    // Azure Storage mock instances are defined globally above

    beforeEach(() => {
      mockAzureConfigService.get.mockResolvedValue(
        "DefaultEndpointsProtocol=https;AccountName=test;AccountKey=key;EndpointSuffix=core.windows.net",
      );
    });

    it("should list available backups", async () => {
      const mockAsyncIterable = {
        async *[Symbol.asyncIterator]() {
          for (const blob of mockBlobs) {
            yield blob;
          }
        },
      };

      mockContainerClient.listBlobsFlat.mockReturnValue(mockAsyncIterable);

      const response = await request(app)
        .get("/api/postgres/restore/backups/test-container")
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveLength(2);
      expect(response.body.data[0]).toEqual({
        name: "testdb/backup_2024-01-02_00-00-00.dump",
        url: "https://storage.blob.core.windows.net/backups/testdb/backup_2024-01-02_00-00-00.dump",
        sizeBytes: 2048000,
        createdAt: "2024-01-02T00:00:00.000Z",
        lastModified: "2024-01-02T00:00:00.000Z",
        metadata: {
          databaseName: "testdb",
          contentType: "application/octet-stream",
          etag: '"0x8D9A1B2C3D4E5F7"',
          backupType: "incremental",
        },
      });
      expect(response.body.pagination.totalCount).toBe(2);
    });

    it("should handle pagination parameters", async () => {
      const mockAsyncIterable = {
        async *[Symbol.asyncIterator]() {
          for (const blob of mockBlobs) {
            yield blob;
          }
        },
      };

      mockContainerClient.listBlobsFlat.mockReturnValue(mockAsyncIterable);

      const response = await request(app)
        .get("/api/postgres/restore/backups/test-container?page=1&limit=1")
        .expect(200);

      expect(response.body.data).toHaveLength(1);
      expect(response.body.pagination).toEqual({
        page: 1,
        limit: 1,
        totalCount: 2,
        hasMore: true,
      });
    });

    it("should handle filter parameters", async () => {
      const mockAsyncIterable = {
        async *[Symbol.asyncIterator]() {
          for (const blob of mockBlobs) {
            yield blob;
          }
        },
      };

      mockContainerClient.listBlobsFlat.mockReturnValue(mockAsyncIterable);

      const response = await request(app)
        .get(
          "/api/postgres/restore/backups/test-container?createdAfter=2024-01-01T12:00:00Z&sizeMin=1500000",
        )
        .expect(200);

      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].name).toBe(
        "testdb/backup_2024-01-02_00-00-00.dump",
      );
    });

    it("should handle sort parameters", async () => {
      const mockAsyncIterable = {
        async *[Symbol.asyncIterator]() {
          for (const blob of mockBlobs.reverse()) {
            // Reverse order to test sorting
            yield blob;
          }
        },
      };

      mockContainerClient.listBlobsFlat.mockReturnValue(mockAsyncIterable);

      const response = await request(app)
        .get(
          "/api/postgres/restore/backups/test-container?sortBy=sizeBytes&sortOrder=asc",
        )
        .expect(200);

      expect(response.body.data[0].sizeBytes).toBe(1024000);
      expect(response.body.data[1].sizeBytes).toBe(2048000);
    });

    it("should filter out non-backup files", async () => {
      const mixedBlobs = [
        ...mockBlobs,
        {
          name: "config.json",
          properties: {
            contentLength: 1000,
            createdOn: new Date("2024-01-03T00:00:00Z"),
            lastModified: new Date("2024-01-03T00:00:00Z"),
            contentType: "application/json",
          },
          metadata: {},
        },
      ];

      const mockAsyncIterable = {
        async *[Symbol.asyncIterator]() {
          for (const blob of mixedBlobs) {
            yield blob;
          }
        },
      };

      mockContainerClient.listBlobsFlat.mockReturnValue(mockAsyncIterable);

      const response = await request(app)
        .get("/api/postgres/restore/backups/test-container")
        .expect(200);

      expect(response.body.data).toHaveLength(2); // Should exclude config.json
    });

    it("should return 500 if Azure connection string not configured", async () => {
      mockAzureConfigService.get.mockResolvedValue(null);

      const response = await request(app)
        .get("/api/postgres/restore/backups/test-container")
        .expect(500);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Internal server error");
    });

    it("should handle Azure Storage errors", async () => {
      mockContainerClient.listBlobsFlat.mockImplementation(() => {
        throw new Error("Azure Storage connection failed");
      });

      const response = await request(app)
        .get("/api/postgres/restore/backups/test-container")
        .expect(500);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Internal server error");
    });

    it("should handle validation errors for query parameters", async () => {
      const response = await request(app)
        .get(
          "/api/postgres/restore/backups/test-container?page=0&limit=101&sizeMin=-1",
        )
        .expect(500);

      expect(response.body.success).toBe(false);
    });
  });

  describe("GET /api/postgres/restore/:databaseId/operations", () => {
    const mockDatabase = {
      id: "test-db-id",
      userId: "test-user-id",
      name: "Test Database",
    };

    const mockRestoreOperations = [
      {
        id: "restore-1",
        databaseId: "test-db-id",
        backupUrl: "https://storage.blob.core.windows.net/backups/backup-1.sql",
        status: "completed",
        startedAt: new Date("2024-01-01T00:00:00Z"),
        completedAt: new Date("2024-01-01T00:15:00Z"),
        errorMessage: null,
        progress: 100,
      },
      {
        id: "restore-2",
        databaseId: "test-db-id",
        backupUrl: "https://storage.blob.core.windows.net/backups/backup-2.sql",
        status: "failed",
        startedAt: new Date("2024-01-02T00:00:00Z"),
        completedAt: new Date("2024-01-02T00:05:00Z"),
        errorMessage: "Database connection timeout",
        progress: 30,
      },
    ];

    it("should list restore operations for a database", async () => {
      mockPrismaClient.postgresDatabase.findFirst.mockResolvedValue(
        mockDatabase,
      );
      mockPrismaClient.restoreOperation.count.mockResolvedValue(2);
      mockPrismaClient.restoreOperation.findMany.mockResolvedValue(
        mockRestoreOperations,
      );

      const response = await request(app)
        .get("/api/postgres/restore/test-db-id/operations")
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveLength(2);
      expect(response.body.data[0]).toEqual({
        id: "restore-1",
        databaseId: "test-db-id",
        backupUrl: "https://storage.blob.core.windows.net/backups/backup-1.sql",
        status: "completed",
        startedAt: "2024-01-01T00:00:00.000Z",
        completedAt: "2024-01-01T00:15:00.000Z",
        errorMessage: null,
        progress: 100,
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
      mockPrismaClient.restoreOperation.count.mockResolvedValue(50);
      mockPrismaClient.restoreOperation.findMany.mockResolvedValue([
        mockRestoreOperations[0],
      ]);

      const response = await request(app)
        .get("/api/postgres/restore/test-db-id/operations?page=2&limit=10")
        .expect(200);

      expect(mockPrismaClient.restoreOperation.findMany).toHaveBeenCalledWith({
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
      mockPrismaClient.restoreOperation.count.mockResolvedValue(1);
      mockPrismaClient.restoreOperation.findMany.mockResolvedValue([
        mockRestoreOperations[0],
      ]);

      await request(app)
        .get(
          "/api/postgres/restore/test-db-id/operations?status=completed&startedAfter=2024-01-01T00:00:00Z&startedBefore=2024-01-02T00:00:00Z",
        )
        .expect(200);

      expect(mockPrismaClient.restoreOperation.count).toHaveBeenCalledWith({
        where: {
          databaseId: "test-db-id",
          status: "completed",
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
      mockPrismaClient.restoreOperation.count.mockResolvedValue(2);
      mockPrismaClient.restoreOperation.findMany.mockResolvedValue(
        mockRestoreOperations,
      );

      await request(app)
        .get(
          "/api/postgres/restore/test-db-id/operations?sortBy=progress&sortOrder=asc",
        )
        .expect(200);

      expect(mockPrismaClient.restoreOperation.findMany).toHaveBeenCalledWith({
        where: { databaseId: "test-db-id" },
        orderBy: { progress: "asc" },
        skip: 0,
        take: 20,
      });
    });

    it("should return 404 if database not found", async () => {
      mockPrismaClient.postgresDatabase.findFirst.mockResolvedValue(null);

      const response = await request(app)
        .get("/api/postgres/restore/nonexistent-db-id/operations")
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Database not found");
    });

    it("should return 404 if user doesn't have access to database", async () => {
      mockPrismaClient.postgresDatabase.findFirst.mockResolvedValue(null);

      const response = await request(app)
        .get("/api/postgres/restore/other-user-db-id/operations")
        .expect(404);

      expect(mockPrismaClient.postgresDatabase.findFirst).toHaveBeenCalledWith({
        where: {
          id: "other-user-db-id",
          userId: "test-user-id",
        },
      });

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Database not found");
    });

    it("should handle database errors", async () => {
      mockPrismaClient.postgresDatabase.findFirst.mockRejectedValue(
        new Error("Database connection failed"),
      );

      const response = await request(app)
        .get("/api/postgres/restore/test-db-id/operations")
        .expect(500);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Internal server error");
    });
  });

  describe("GET /api/postgres/restore/:operationId/progress", () => {
    const mockRestoreOperation = {
      id: "restore-1",
      databaseId: "test-db-id",
      status: "running",
      progress: 75,
      startedAt: new Date("2024-01-01T00:00:00Z"),
      completedAt: null,
      errorMessage: null,
      backupUrl: "https://storage.blob.core.windows.net/backups/backup.sql",
      database: {
        id: "test-db-id",
        userId: "test-user-id",
      },
    };

    it("should return detailed progress information", async () => {
      mockPrismaClient.restoreOperation.findFirst.mockResolvedValue(
        mockRestoreOperation,
      );

      const response = await request(app)
        .get("/api/postgres/restore/restore-1/progress")
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toEqual({
        id: "restore-1",
        databaseId: "test-db-id",
        status: "running",
        progress: 75,
        startedAt: "2024-01-01T00:00:00.000Z",
        estimatedCompletion: expect.any(String),
        errorMessage: undefined,
        backupUrl: "https://storage.blob.core.windows.net/backups/backup.sql",
      });
    });

    it("should calculate estimated completion time for running operations", async () => {
      const currentTime = Date.now();
      const startTime = new Date(currentTime - 60000); // Started 1 minute ago
      const operationWithProgress = {
        ...mockRestoreOperation,
        progress: 50,
        startedAt: startTime,
      };

      mockPrismaClient.restoreOperation.findFirst.mockResolvedValue(
        operationWithProgress,
      );

      const response = await request(app)
        .get("/api/postgres/restore/restore-1/progress")
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
        ...mockRestoreOperation,
        status: "completed",
        progress: 100,
        completedAt: new Date("2024-01-01T00:15:00Z"),
      };

      mockPrismaClient.restoreOperation.findFirst.mockResolvedValue(
        completedOperation,
      );

      const response = await request(app)
        .get("/api/postgres/restore/restore-1/progress")
        .expect(200);

      expect(response.body.data.estimatedCompletion).toBeUndefined();
    });

    it("should not calculate estimated completion for operations with zero progress", async () => {
      const zeroProgressOperation = {
        ...mockRestoreOperation,
        progress: 0,
      };

      mockPrismaClient.restoreOperation.findFirst.mockResolvedValue(
        zeroProgressOperation,
      );

      const response = await request(app)
        .get("/api/postgres/restore/restore-1/progress")
        .expect(200);

      expect(response.body.data.estimatedCompletion).toBeUndefined();
    });

    it("should handle failed operations with error messages", async () => {
      const failedOperation = {
        ...mockRestoreOperation,
        status: "failed",
        progress: 40,
        errorMessage: "Database connection failed during restore",
        completedAt: new Date("2024-01-01T00:08:00Z"),
      };

      mockPrismaClient.restoreOperation.findFirst.mockResolvedValue(
        failedOperation,
      );

      const response = await request(app)
        .get("/api/postgres/restore/restore-1/progress")
        .expect(200);

      expect(response.body.data.status).toBe("failed");
      expect(response.body.data.errorMessage).toBe(
        "Database connection failed during restore",
      );
      expect(response.body.data.estimatedCompletion).toBeUndefined();
    });

    it("should return 404 if restore operation not found", async () => {
      mockPrismaClient.restoreOperation.findFirst.mockResolvedValue(null);

      const response = await request(app)
        .get("/api/postgres/restore/nonexistent-restore/progress")
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Restore operation not found");
    });

    it("should return 404 if user doesn't have access to restore operation", async () => {
      mockPrismaClient.restoreOperation.findFirst.mockResolvedValue(null);

      const response = await request(app)
        .get("/api/postgres/restore/other-user-restore/progress")
        .expect(404);

      expect(mockPrismaClient.restoreOperation.findFirst).toHaveBeenCalledWith({
        where: {
          id: "other-user-restore",
          database: { userId: "test-user-id" },
        },
        include: {
          database: true,
        },
      });

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Restore operation not found");
    });

    it("should handle database errors", async () => {
      mockPrismaClient.restoreOperation.findFirst.mockRejectedValue(
        new Error("Database connection failed"),
      );

      const response = await request(app)
        .get("/api/postgres/restore/restore-1/progress")
        .expect(500);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Internal server error");
    });
  });
});
