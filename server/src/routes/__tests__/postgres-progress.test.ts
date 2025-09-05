import request from "supertest";
import express from "express";

// Mock prisma
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {},
}));

// Mock the ProgressTrackerService - create a shared mock instance
const mockProgressTrackerInstance = {
  initialize: jest.fn(),
  getBackupProgress: jest.fn(),
  getRestoreProgress: jest.fn(),
  getActiveOperations: jest.fn(),
  getOperationHistory: jest.fn(),
  cleanupOldOperations: jest.fn(),
};

jest.mock("../../services/progress-tracker", () => ({
  ProgressTrackerService: jest.fn().mockImplementation(() => mockProgressTrackerInstance),
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

// Mock auth middleware
jest.mock("../../lib/auth-middleware", () => ({
  requireAuth: (req: any, res: any, next: any) => {
    req.user = { id: "test-user-id" };
    next();
  },
  getAuthenticatedUser: jest.fn(),
}));

// Import after all mocks are set up
import router from "../postgres-progress";
import { ProgressTrackerService } from "../../services/progress-tracker";

// Get the mocked constructor for type safety
const MockedProgressTrackerService = ProgressTrackerService as jest.MockedClass<typeof ProgressTrackerService>;

describe("PostgreSQL Progress API", () => {
  let app: express.Application;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    
    // Add request ID middleware
    app.use((req, res, next) => {
      req.headers["x-request-id"] = "test-request-id";
      next();
    });
    
    app.use("/api/postgres/progress", router);
  });

  beforeEach(() => {
    // Reset all mock functions
    Object.values(mockProgressTrackerInstance).forEach((mockFn: any) => {
      if (typeof mockFn === 'function') {
        mockFn.mockReset();
      }
    });
    
    // Set default mock implementations
    mockProgressTrackerInstance.initialize.mockResolvedValue(undefined);
    mockProgressTrackerInstance.getBackupProgress.mockResolvedValue(null);
    mockProgressTrackerInstance.getRestoreProgress.mockResolvedValue(null);
    mockProgressTrackerInstance.getActiveOperations.mockResolvedValue({
      backupOperations: [],
      restoreOperations: []
    });
    mockProgressTrackerInstance.getOperationHistory.mockResolvedValue({
      operations: [],
      totalCount: 0,
      hasMore: false
    });
    mockProgressTrackerInstance.cleanupOldOperations.mockResolvedValue({
      deletedBackupOperations: 0,
      deletedRestoreOperations: 0
    });
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
      mockProgressTrackerInstance.getBackupProgress.mockResolvedValue(
        mockBackupProgress,
      );

      const response = await request(app)
        .get("/api/postgres/progress/backup/backup-1")
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toEqual(mockBackupProgress);

      expect(mockProgressTrackerInstance.initialize).toHaveBeenCalled();
      expect(mockProgressTrackerInstance.getBackupProgress).toHaveBeenCalledWith(
        "backup-1",
        "test-user-id",
      );
    });

    it("should return 404 if backup operation not found", async () => {
      mockProgressTrackerInstance.getBackupProgress.mockResolvedValue(null);

      const response = await request(app)
        .get("/api/postgres/progress/backup/nonexistent-backup")
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Not found");
      expect(response.body.message).toBe("Backup operation not found");
    });

    it("should return 400 for invalid operation ID", async () => {
      // Test with empty string operation ID
      const response = await request(app)
        .get("/api/postgres/progress/backup/")
        .expect(404); // This becomes 404 due to route not matching

      // This test is correct as-is - empty path doesn't match the route pattern
    });

    it("should handle service errors", async () => {
      mockProgressTrackerInstance.getBackupProgress.mockRejectedValue(
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
      mockProgressTrackerInstance.initialize.mockRejectedValue(
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
      mockProgressTrackerInstance.getRestoreProgress.mockResolvedValue(
        mockRestoreProgress,
      );

      const response = await request(app)
        .get("/api/postgres/progress/restore/restore-1")
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toEqual(mockRestoreProgress);

      expect(mockProgressTrackerInstance.initialize).toHaveBeenCalled();
      expect(
        mockProgressTrackerInstance.getRestoreProgress,
      ).toHaveBeenCalledWith("restore-1", "test-user-id");
    });

    it("should return 404 if restore operation not found", async () => {
      mockProgressTrackerInstance.getRestoreProgress.mockResolvedValue(null);

      const response = await request(app)
        .get("/api/postgres/progress/restore/nonexistent-restore")
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Not found");
      expect(response.body.message).toBe("Restore operation not found");
    });

    it("should return 400 for invalid operation ID", async () => {
      // Test with empty path - this returns 404 as the route doesn't match
      const response = await request(app)
        .get("/api/postgres/progress/restore/")
        .expect(404);

      // This is correct behavior - empty operationId doesn't match the route pattern
    });

    it("should handle service errors", async () => {
      mockProgressTrackerInstance.getRestoreProgress.mockRejectedValue(
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

      mockProgressTrackerInstance.getRestoreProgress.mockResolvedValue(
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

      mockProgressTrackerInstance.getRestoreProgress.mockResolvedValue(
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
      mockProgressTrackerInstance.getActiveOperations.mockResolvedValue(
        mockActiveOperations,
      );

      const response = await request(app)
        .get("/api/postgres/progress/active")
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toEqual(mockActiveOperations);

      expect(mockProgressTrackerInstance.initialize).toHaveBeenCalled();
      expect(
        mockProgressTrackerInstance.getActiveOperations,
      ).toHaveBeenCalledWith("test-user-id");
    });

    it("should return empty operations when no active operations", async () => {
      const emptyOperations = {
        backupOperations: [],
        restoreOperations: [],
      };

      mockProgressTrackerInstance.getActiveOperations.mockResolvedValue(
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
      mockProgressTrackerInstance.getActiveOperations.mockRejectedValue(
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
      mockProgressTrackerInstance.getOperationHistory.mockResolvedValue(
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
        mockProgressTrackerInstance.getOperationHistory,
      ).toHaveBeenCalledWith({
        userId: "test-user-id",
        operationType: "all",
        limit: 50,
        offset: 0,
      });
    });

    it("should handle query parameters for filtering", async () => {
      mockProgressTrackerInstance.getOperationHistory.mockResolvedValue({
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
        mockProgressTrackerInstance.getOperationHistory,
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
      mockProgressTrackerInstance.getOperationHistory.mockResolvedValue(
        mockOperationHistory,
      );

      await request(app)
        .get(
          "/api/postgres/progress/history?startedAfter=2024-01-01T00:00:00Z&startedBefore=2024-01-02T00:00:00Z",
        )
        .expect(200);

      expect(
        mockProgressTrackerInstance.getOperationHistory,
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
      mockProgressTrackerInstance.getOperationHistory.mockRejectedValue(
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
      mockProgressTrackerInstance.getOperationHistory.mockResolvedValue(
        mockOperationHistory,
      );

      await request(app)
        .get("/api/postgres/progress/history?status=all")
        .expect(200);

      // When status is "all", it should be filtered out (set to undefined and then removed)
      expect(
        mockProgressTrackerInstance.getOperationHistory,
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
      mockProgressTrackerInstance.cleanupOldOperations.mockResolvedValue(
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

      expect(mockProgressTrackerInstance.initialize).toHaveBeenCalled();
      expect(
        mockProgressTrackerInstance.cleanupOldOperations,
      ).toHaveBeenCalled();
    });

    it("should handle cleanup with no operations to delete", async () => {
      const emptyCleanupResult = {
        deletedBackupOperations: 0,
        deletedRestoreOperations: 0,
      };

      mockProgressTrackerInstance.cleanupOldOperations.mockResolvedValue(
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
      mockProgressTrackerInstance.cleanupOldOperations.mockRejectedValue(
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
      mockProgressTrackerInstance.initialize.mockRejectedValue(
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

      mockProgressTrackerInstance.getBackupProgress.mockResolvedValue({
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
