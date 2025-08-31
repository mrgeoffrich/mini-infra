import request from "supertest";
import express from "express";
import router from "../postgres-progress";
import { ProgressTrackerService } from "../../services/progress-tracker";
import prisma from "../../lib/prisma";

// Mock prisma
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {},
}));

// Mock the ProgressTrackerService
const mockProgressTrackerService = {
  initialize: jest.fn(),
  getBackupProgress: jest.fn(),
  getRestoreProgress: jest.fn(),
  getActiveOperations: jest.fn(),
  getOperationHistory: jest.fn(),
  cleanupOldOperations: jest.fn(),
};

jest.mock("../../services/progress-tracker", () => ({
  ProgressTrackerService: jest.fn(() => mockProgressTrackerService),
}));

// Mock logger
jest.mock("../../lib/logger", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

// Mock auth middleware
jest.mock("../../lib/auth-middleware", () => ({
  requireAuth: (req: any, res: any, next: any) => {
    req.user = { id: "test-user-id" };
    next();
  },
  getAuthenticatedUser: jest.fn(),
}));

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  req.headers["x-request-id"] = "test-request-id";
  next();
});
app.use("/api/postgres/progress", router);

describe("PostgreSQL Progress API", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockProgressTrackerService.initialize.mockResolvedValue(undefined);
  });

  describe("GET /api/postgres/progress/backup/:operationId", () => {
    const mockBackupProgress = {
      id: "backup-1",
      databaseId: "test-db-id",
      operationType: "backup",
      status: "running",
      progress: 75,
      startedAt: "2024-01-01T00:00:00.000Z",
      estimatedCompletion: "2024-01-01T00:20:00.000Z",
      currentStep: "Uploading to Azure",
      totalSteps: 3,
      completedSteps: 2,
      metadata: {
        databaseName: "testdb",
        backupSize: 1024000,
      },
    };

    it("should return backup progress for valid operation", async () => {
      mockProgressTrackerService.getBackupProgress.mockResolvedValue(
        mockBackupProgress,
      );

      const response = await request(app)
        .get("/api/postgres/progress/backup/backup-1")
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toEqual(mockBackupProgress);

      expect(mockProgressTrackerService.initialize).toHaveBeenCalled();
      expect(mockProgressTrackerService.getBackupProgress).toHaveBeenCalledWith(
        "backup-1",
        "test-user-id",
      );
    });

    it("should return 404 if backup operation not found", async () => {
      mockProgressTrackerService.getBackupProgress.mockResolvedValue(null);

      const response = await request(app)
        .get("/api/postgres/progress/backup/nonexistent-backup")
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Not found");
      expect(response.body.message).toBe("Backup operation not found");
    });

    it("should return 400 for invalid operation ID", async () => {
      const response = await request(app)
        .get("/api/postgres/progress/backup/")
        .expect(404); // This becomes 404 due to route not matching

      // Test with empty string parameter in a way that matches the route
      const emptyResponse = await request(app)
        .get("/api/postgres/progress/backup/ ")
        .expect(400);

      expect(emptyResponse.body.success).toBe(false);
      expect(emptyResponse.body.error).toBe("Validation failed");
    });

    it("should handle service errors", async () => {
      mockProgressTrackerService.getBackupProgress.mockRejectedValue(
        new Error("Service unavailable"),
      );

      const response = await request(app)
        .get("/api/postgres/progress/backup/backup-1")
        .expect(500);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Internal server error");
      expect(response.body.message).toBe("Failed to retrieve backup progress");
    });

    it("should handle initialization errors", async () => {
      mockProgressTrackerService.initialize.mockRejectedValue(
        new Error("Initialization failed"),
      );

      const response = await request(app)
        .get("/api/postgres/progress/backup/backup-1")
        .expect(500);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Internal server error");
    });
  });

  describe("GET /api/postgres/progress/restore/:operationId", () => {
    const mockRestoreProgress = {
      id: "restore-1",
      databaseId: "test-db-id",
      operationType: "restore",
      status: "running",
      progress: 45,
      startedAt: "2024-01-01T00:00:00.000Z",
      estimatedCompletion: "2024-01-01T00:25:00.000Z",
      currentStep: "Downloading backup",
      totalSteps: 4,
      completedSteps: 1,
      backupUrl: "https://storage.blob.core.windows.net/backups/backup.sql",
      metadata: {
        databaseName: "testdb",
        backupSize: 2048000,
      },
    };

    it("should return restore progress for valid operation", async () => {
      mockProgressTrackerService.getRestoreProgress.mockResolvedValue(
        mockRestoreProgress,
      );

      const response = await request(app)
        .get("/api/postgres/progress/restore/restore-1")
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toEqual(mockRestoreProgress);

      expect(mockProgressTrackerService.initialize).toHaveBeenCalled();
      expect(
        mockProgressTrackerService.getRestoreProgress,
      ).toHaveBeenCalledWith("restore-1", "test-user-id");
    });

    it("should return 404 if restore operation not found", async () => {
      mockProgressTrackerService.getRestoreProgress.mockResolvedValue(null);

      const response = await request(app)
        .get("/api/postgres/progress/restore/nonexistent-restore")
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Not found");
      expect(response.body.message).toBe("Restore operation not found");
    });

    it("should return 400 for invalid operation ID", async () => {
      const response = await request(app)
        .get("/api/postgres/progress/restore/ ")
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Validation failed");
    });

    it("should handle service errors", async () => {
      mockProgressTrackerService.getRestoreProgress.mockRejectedValue(
        new Error("Service unavailable"),
      );

      const response = await request(app)
        .get("/api/postgres/progress/restore/restore-1")
        .expect(500);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Internal server error");
      expect(response.body.message).toBe("Failed to retrieve restore progress");
    });

    it("should handle completed restore operation", async () => {
      const completedRestore = {
        ...mockRestoreProgress,
        status: "completed",
        progress: 100,
        completedAt: "2024-01-01T00:20:00.000Z",
        estimatedCompletion: undefined,
      };

      mockProgressTrackerService.getRestoreProgress.mockResolvedValue(
        completedRestore,
      );

      const response = await request(app)
        .get("/api/postgres/progress/restore/restore-1")
        .expect(200);

      expect(response.body.data.status).toBe("completed");
      expect(response.body.data.progress).toBe(100);
    });

    it("should handle failed restore operation", async () => {
      const failedRestore = {
        ...mockRestoreProgress,
        status: "failed",
        progress: 30,
        errorMessage: "Database connection failed",
        completedAt: "2024-01-01T00:10:00.000Z",
      };

      mockProgressTrackerService.getRestoreProgress.mockResolvedValue(
        failedRestore,
      );

      const response = await request(app)
        .get("/api/postgres/progress/restore/restore-1")
        .expect(200);

      expect(response.body.data.status).toBe("failed");
      expect(response.body.data.errorMessage).toBe(
        "Database connection failed",
      );
    });
  });

  describe("GET /api/postgres/progress/active", () => {
    const mockActiveOperations = {
      backupOperations: [
        {
          id: "backup-1",
          databaseId: "test-db-id",
          status: "running",
          progress: 60,
          startedAt: "2024-01-01T00:00:00.000Z",
        },
        {
          id: "backup-2",
          databaseId: "test-db-id-2",
          status: "pending",
          progress: 0,
          startedAt: "2024-01-01T00:05:00.000Z",
        },
      ],
      restoreOperations: [
        {
          id: "restore-1",
          databaseId: "test-db-id",
          status: "running",
          progress: 25,
          startedAt: "2024-01-01T00:10:00.000Z",
        },
      ],
    };

    it("should return active operations for authenticated user", async () => {
      mockProgressTrackerService.getActiveOperations.mockResolvedValue(
        mockActiveOperations,
      );

      const response = await request(app)
        .get("/api/postgres/progress/active")
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toEqual(mockActiveOperations);

      expect(mockProgressTrackerService.initialize).toHaveBeenCalled();
      expect(
        mockProgressTrackerService.getActiveOperations,
      ).toHaveBeenCalledWith("test-user-id");
    });

    it("should return empty operations when no active operations", async () => {
      const emptyOperations = {
        backupOperations: [],
        restoreOperations: [],
      };

      mockProgressTrackerService.getActiveOperations.mockResolvedValue(
        emptyOperations,
      );

      const response = await request(app)
        .get("/api/postgres/progress/active")
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.backupOperations).toHaveLength(0);
      expect(response.body.data.restoreOperations).toHaveLength(0);
    });

    it("should handle service errors", async () => {
      mockProgressTrackerService.getActiveOperations.mockRejectedValue(
        new Error("Service unavailable"),
      );

      const response = await request(app)
        .get("/api/postgres/progress/active")
        .expect(500);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Internal server error");
      expect(response.body.message).toBe(
        "Failed to retrieve active operations",
      );
    });
  });

  describe("GET /api/postgres/progress/history", () => {
    const mockOperationHistory = {
      operations: [
        {
          id: "backup-1",
          databaseId: "test-db-id",
          operationType: "backup",
          status: "completed",
          progress: 100,
          startedAt: "2024-01-01T00:00:00.000Z",
          completedAt: "2024-01-01T00:10:00.000Z",
        },
        {
          id: "restore-1",
          databaseId: "test-db-id",
          operationType: "restore",
          status: "failed",
          progress: 45,
          startedAt: "2024-01-01T00:15:00.000Z",
          completedAt: "2024-01-01T00:20:00.000Z",
          errorMessage: "Connection timeout",
        },
      ],
      totalCount: 15,
      hasMore: true,
    };

    it("should return operation history with default parameters", async () => {
      mockProgressTrackerService.getOperationHistory.mockResolvedValue(
        mockOperationHistory,
      );

      const response = await request(app)
        .get("/api/postgres/progress/history")
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toEqual(mockOperationHistory.operations);
      expect(response.body.pagination).toEqual({
        offset: 0,
        limit: 50,
        totalCount: 15,
        hasMore: true,
      });

      expect(
        mockProgressTrackerService.getOperationHistory,
      ).toHaveBeenCalledWith({
        userId: "test-user-id",
        operationType: "all",
        limit: 50,
        offset: 0,
      });
    });

    it("should handle query parameters for filtering", async () => {
      mockProgressTrackerService.getOperationHistory.mockResolvedValue({
        operations: [mockOperationHistory.operations[0]],
        totalCount: 1,
        hasMore: false,
      });

      const response = await request(app)
        .get(
          "/api/postgres/progress/history?databaseId=test-db-id&operationType=backup&status=completed&limit=10&offset=5",
        )
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveLength(1);
      expect(response.body.pagination).toEqual({
        offset: 5,
        limit: 10,
        totalCount: 1,
        hasMore: false,
      });

      expect(
        mockProgressTrackerService.getOperationHistory,
      ).toHaveBeenCalledWith({
        userId: "test-user-id",
        databaseId: "test-db-id",
        operationType: "backup",
        status: "completed",
        limit: 10,
        offset: 5,
      });
    });

    it("should handle date range filtering", async () => {
      mockProgressTrackerService.getOperationHistory.mockResolvedValue(
        mockOperationHistory,
      );

      await request(app)
        .get(
          "/api/postgres/progress/history?startedAfter=2024-01-01T00:00:00Z&startedBefore=2024-01-02T00:00:00Z",
        )
        .expect(200);

      expect(
        mockProgressTrackerService.getOperationHistory,
      ).toHaveBeenCalledWith({
        userId: "test-user-id",
        operationType: "all",
        startedAfter: new Date("2024-01-01T00:00:00Z"),
        startedBefore: new Date("2024-01-02T00:00:00Z"),
        limit: 50,
        offset: 0,
      });
    });

    it("should return 400 for invalid query parameters", async () => {
      const response = await request(app)
        .get(
          "/api/postgres/progress/history?limit=101&offset=-1&operationType=invalid",
        )
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Validation failed");
      expect(response.body.message).toBe("Invalid query parameters");
      expect(response.body.details).toBeDefined();
    });

    it("should return 400 for invalid date format", async () => {
      const response = await request(app)
        .get("/api/postgres/progress/history?startedAfter=invalid-date")
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Validation failed");
    });

    it("should handle service errors", async () => {
      mockProgressTrackerService.getOperationHistory.mockRejectedValue(
        new Error("Service unavailable"),
      );

      const response = await request(app)
        .get("/api/postgres/progress/history")
        .expect(500);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Internal server error");
      expect(response.body.message).toBe(
        "Failed to retrieve operation history",
      );
    });

    it("should filter out undefined values from filter object", async () => {
      mockProgressTrackerService.getOperationHistory.mockResolvedValue(
        mockOperationHistory,
      );

      await request(app)
        .get("/api/postgres/progress/history?status=all")
        .expect(200);

      // When status is "all", it should be filtered out (set to undefined and then removed)
      expect(
        mockProgressTrackerService.getOperationHistory,
      ).toHaveBeenCalledWith({
        userId: "test-user-id",
        operationType: "all",
        limit: 50,
        offset: 0,
      });
    });
  });

  describe("POST /api/postgres/progress/cleanup", () => {
    const mockCleanupResult = {
      deletedBackupOperations: 15,
      deletedRestoreOperations: 8,
    };

    it("should perform cleanup successfully", async () => {
      mockProgressTrackerService.cleanupOldOperations.mockResolvedValue(
        mockCleanupResult,
      );

      const response = await request(app)
        .post("/api/postgres/progress/cleanup")
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toEqual({
        deletedBackupOperations: 15,
        deletedRestoreOperations: 8,
        message: "Cleanup completed successfully",
      });

      expect(mockProgressTrackerService.initialize).toHaveBeenCalled();
      expect(
        mockProgressTrackerService.cleanupOldOperations,
      ).toHaveBeenCalled();
    });

    it("should handle cleanup with no operations to delete", async () => {
      const emptyCleanupResult = {
        deletedBackupOperations: 0,
        deletedRestoreOperations: 0,
      };

      mockProgressTrackerService.cleanupOldOperations.mockResolvedValue(
        emptyCleanupResult,
      );

      const response = await request(app)
        .post("/api/postgres/progress/cleanup")
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.deletedBackupOperations).toBe(0);
      expect(response.body.data.deletedRestoreOperations).toBe(0);
    });

    it("should handle cleanup service errors", async () => {
      mockProgressTrackerService.cleanupOldOperations.mockRejectedValue(
        new Error("Cleanup failed"),
      );

      const response = await request(app)
        .post("/api/postgres/progress/cleanup")
        .expect(500);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Internal server error");
      expect(response.body.message).toBe("Failed to perform cleanup");
    });

    it("should handle initialization errors during cleanup", async () => {
      mockProgressTrackerService.initialize.mockRejectedValue(
        new Error("Initialization failed"),
      );

      const response = await request(app)
        .post("/api/postgres/progress/cleanup")
        .expect(500);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Internal server error");
    });
  });

  describe("Authentication", () => {
    beforeEach(() => {
      // Clear the mock and create a new app without auth for these tests
    });

    it("should return 401 for unauthenticated requests", async () => {
      // Create a new app without auth middleware for this test
      const unauthenticatedApp = express();
      unauthenticatedApp.use(express.json());
      unauthenticatedApp.use((req, res, next) => {
        req.headers["x-request-id"] = "test-request-id";
        req.user = undefined; // No authenticated user
        next();
      });

      // Mock auth middleware to not set user
      jest.doMock("../../lib/auth-middleware", () => ({
        requireAuth: (req: any, res: any, next: any) => {
          req.user = undefined; // Simulate no user
          next();
        },
        getAuthenticatedUser: jest.fn(),
      }));

      unauthenticatedApp.use("/api/postgres/progress", router);

      const response = await request(unauthenticatedApp)
        .get("/api/postgres/progress/backup/backup-1")
        .expect(401);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Authentication required");
    });
  });

  describe("Request ID handling", () => {
    it("should handle missing request ID header", async () => {
      const appWithoutRequestId = express();
      appWithoutRequestId.use(express.json());
      appWithoutRequestId.use("/api/postgres/progress", router);

      mockProgressTrackerService.getBackupProgress.mockResolvedValue({
        id: "backup-1",
        status: "running",
        progress: 50,
      });

      const response = await request(appWithoutRequestId)
        .get("/api/postgres/progress/backup/backup-1")
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.requestId).toBeUndefined();
    });
  });
});
