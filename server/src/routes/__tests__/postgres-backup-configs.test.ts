import request from "supertest";
import express from "express";
import { createId } from "@paralleldrive/cuid2";
import { BackupConfigurationInfo, BackupFormat } from "@mini-infra/types";

// Hoist mock variables that are used inside vi.mock() factory functions
const {
  mockBackupConfigurationManager,
  mockLogger,
  mockRequireSessionOrApiKey,
} = vi.hoisted(() => ({
  mockBackupConfigurationManager: {
    getBackupConfigByDatabaseId: vi.fn(),
    createBackupConfig: vi.fn(),
    deleteBackupConfig: vi.fn(),
  },
  mockLogger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
  mockRequireSessionOrApiKey: vi.fn((req: any, res: any, next: any) => {
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
  }),
}));

// Mock BackupConfigurationManager
vi.mock("../../services/backup/backup-configuration-manager", () => ({
  BackupConfigurationManager: vi
    .fn()
    .mockImplementation(function() { return mockBackupConfigurationManager; }),
}));

// Mock Prisma
vi.mock("../../lib/prisma", () => ({
  default: {},
}));

// Mock logger
vi.mock("../../lib/logger-factory", () => ({
  appLogger: vi.fn(function() { return mockLogger; }),
  servicesLogger: vi.fn(function() { return mockLogger; }),
  httpLogger: vi.fn(function() { return mockLogger; }),
  prismaLogger: vi.fn(function() { return mockLogger; }),
  default: vi.fn(function() { return mockLogger; }),
}));

// Mock auth middleware - need to mock the api-key-middleware functions that are re-exported through middleware/auth
vi.mock("../../lib/api-key-middleware", () => ({
  requireSessionOrApiKey: mockRequireSessionOrApiKey,
  getCurrentUserId: (req: any) => "test-user-id",
  getCurrentUser: (req: any) => ({ id: "test-user-id", email: "test@example.com" })
}));

// Mock auth middleware functions
vi.mock("../../lib/auth-middleware", () => ({
  requireAuth: (req: any, res: any, next: any) => {
    req.user = { id: "test-user-id", email: "test@example.com" };
    next();
  },
  getAuthenticatedUser: (req: any) => ({ id: "test-user-id", email: "test@example.com" }),
}));

import postgresBackupConfigsRouter from "../postgres-backup-configs";

describe("PostgreSQL Backup Configs API Routes", () => {
  let app: express.Application;

  beforeAll(() => {
    app = express();
    app.use(express.json());

    // Add request ID middleware for testing
    app.use((req: any, res: any, next: any) => {
      req.headers["x-request-id"] = req.headers["x-request-id"] || createId();
      req.get = vi.fn((header: string) => {
        if (header === "User-Agent") return "Test Agent";
        if (header === "X-Forwarded-For") return "127.0.0.1";
        return undefined;
      });
      next();
    });

    app.use("/api/postgres/backup-configs", postgresBackupConfigsRouter);

    // Add error handler for testing
    app.use((error: any, req: any, res: any, next: any) => {
      res.status(500).json({
        error: "Internal Server Error",
        message: error.message || "An unexpected error occurred",
        timestamp: new Date().toISOString(),
        requestId: req.headers["x-request-id"],
      });
    });
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /api/postgres/backup-configs/:databaseId", () => {
    const mockBackupConfig: BackupConfigurationInfo = {
      id: "config-123",
      databaseId: "db-123",
      schedule: "0 2 * * *",
      azureContainerName: "test-backups",
      azurePathPrefix: "db-backups/",
      retentionDays: 30,
      backupFormat: "custom",
      compressionLevel: 6,
      isEnabled: true,
      lastBackupAt: "2023-01-01T02:00:00.000Z",
      nextScheduledAt: "2023-01-02T02:00:00.000Z",
      createdAt: "2023-01-01T00:00:00.000Z",
      updatedAt: "2023-01-01T01:00:00.000Z",
    };

    it("should return backup configuration successfully", async () => {
      mockBackupConfigurationManager.getBackupConfigByDatabaseId.mockResolvedValue(
        mockBackupConfig,
      );

      const response = await request(app)
        .get("/api/postgres/backup-configs/db-123")
        .expect(200);

      expect(response.body).toMatchObject({
        success: true,
        data: mockBackupConfig,
      });

      expect(
        mockBackupConfigurationManager.getBackupConfigByDatabaseId,
      ).toHaveBeenCalledWith("db-123");
    });

    it("should return 404 when backup config not found", async () => {
      mockBackupConfigurationManager.getBackupConfigByDatabaseId.mockResolvedValue(
        null,
      );

      const response = await request(app)
        .get("/api/postgres/backup-configs/nonexistent")
        .expect(404);

      expect(response.body).toMatchObject({
        error: "Not Found",
        message:
          "Backup configuration for database with ID 'nonexistent' not found",
      });
    });

    it("should handle service errors", async () => {
      mockBackupConfigurationManager.getBackupConfigByDatabaseId.mockRejectedValue(
        new Error("Database error"),
      );

      const response = await request(app)
        .get("/api/postgres/backup-configs/db-123")
        .expect(500);

      expect(response.body).toMatchObject({
        error: "Internal Server Error",
        message: "Database error",
      });

      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe("POST /api/postgres/backup-configs", () => {
    const validCreateRequest = {
      databaseId: "db-123",
      schedule: "0 2 * * *",
      azureContainerName: "test-backups",
      azurePathPrefix: "db-backups/",
      retentionDays: 30,
      backupFormat: "custom" as BackupFormat,
      compressionLevel: 6,
      isEnabled: true,
    };

    const mockCreatedConfig: BackupConfigurationInfo = {
      id: "config-new",
      databaseId: "db-123",
      schedule: "0 2 * * *",
      azureContainerName: "test-backups",
      azurePathPrefix: "db-backups/",
      retentionDays: 30,
      backupFormat: "custom",
      compressionLevel: 6,
      isEnabled: true,
      lastBackupAt: null,
      nextScheduledAt: "2023-01-02T02:00:00.000Z",
      createdAt: "2023-01-01T00:00:00.000Z",
      updatedAt: "2023-01-01T00:00:00.000Z",
    };

    it("should create backup configuration successfully", async () => {
      mockBackupConfigurationManager.createBackupConfig.mockResolvedValue(
        mockCreatedConfig,
      );

      const response = await request(app)
        .post("/api/postgres/backup-configs")
        .send(validCreateRequest)
        .expect(201);

      expect(response.body).toMatchObject({
        success: true,
        message: "Backup configuration created successfully",
        data: mockCreatedConfig,
      });

      expect(mockBackupConfigurationManager.createBackupConfig).toHaveBeenCalledWith(
        "db-123",
        {
          schedule: "0 2 * * *",
          azureContainerName: "test-backups",
          azurePathPrefix: "db-backups/",
          retentionDays: 30,
          backupFormat: "custom",
          compressionLevel: 6,
          isEnabled: true,
        },
      );
    });

    it("should validate required fields", async () => {
      const invalidRequest = { ...validCreateRequest, azureContainerName: "" };

      const response = await request(app)
        .post("/api/postgres/backup-configs")
        .send(invalidRequest)
        .expect(400);

      expect(response.body).toMatchObject({
        error: "Bad Request",
        message: "Invalid request data",
      });
    });

    it("should handle duplicate configuration", async () => {
      mockBackupConfigurationManager.createBackupConfig.mockRejectedValue(
        new Error("Backup configuration already exists for this database"),
      );

      const response = await request(app)
        .post("/api/postgres/backup-configs")
        .send(validCreateRequest)
        .expect(409);

      expect(response.body).toMatchObject({
        error: "Conflict",
        message: "Backup configuration already exists for this database",
      });
    });

    it("should handle database not found", async () => {
      mockBackupConfigurationManager.createBackupConfig.mockRejectedValue(
        new Error("Database not found or access denied"),
      );

      const response = await request(app)
        .post("/api/postgres/backup-configs")
        .send(validCreateRequest)
        .expect(404);

      expect(response.body).toMatchObject({
        error: "Not Found",
        message: "Database not found or access denied",
      });
    });

    it("should handle invalid cron expression", async () => {
      mockBackupConfigurationManager.createBackupConfig.mockRejectedValue(
        new Error("Invalid cron expression"),
      );

      const invalidCronRequest = {
        ...validCreateRequest,
        schedule: "invalid cron",
      };

      const response = await request(app)
        .post("/api/postgres/backup-configs")
        .send(invalidCronRequest)
        .expect(400);

      expect(response.body).toMatchObject({
        error: "Bad Request",
        message: "Invalid cron expression",
      });
    });

    it("should handle Azure container validation failure", async () => {
      mockBackupConfigurationManager.createBackupConfig.mockRejectedValue(
        new Error("Database not found or access denied"),
      );

      const response = await request(app)
        .post("/api/postgres/backup-configs")
        .send(validCreateRequest)
        .expect(404);

      expect(response.body).toMatchObject({
        error: "Not Found",
      });
    });

    it("should create configuration without schedule", async () => {
      const configWithoutSchedule = {
        databaseId: "db-123",
        azureContainerName: "test-backups",
        azurePathPrefix: "db-backups/",
      };

      const mockConfigWithoutSchedule = {
        ...mockCreatedConfig,
        schedule: null,
        nextScheduledAt: null,
      };

      mockBackupConfigurationManager.createBackupConfig.mockResolvedValue(
        mockConfigWithoutSchedule,
      );

      const response = await request(app)
        .post("/api/postgres/backup-configs")
        .send(configWithoutSchedule)
        .expect(201);

      expect(response.body.data.schedule).toBeNull();
      expect(response.body.data.nextScheduledAt).toBeNull();
    });
  });

  describe("DELETE /api/postgres/backup-configs/:id", () => {
    it("should delete backup configuration successfully", async () => {
      mockBackupConfigurationManager.deleteBackupConfig.mockResolvedValue(undefined);

      const response = await request(app)
        .delete("/api/postgres/backup-configs/config-123")
        .expect(200);

      expect(response.body).toMatchObject({
        success: true,
        message: "Backup configuration deleted successfully",
      });

      expect(mockBackupConfigurationManager.deleteBackupConfig).toHaveBeenCalledWith(
        "config-123",
      );
    });

    it("should return 404 for non-existent configuration", async () => {
      mockBackupConfigurationManager.deleteBackupConfig.mockRejectedValue(
        new Error("Backup configuration not found"),
      );

      const response = await request(app)
        .delete("/api/postgres/backup-configs/nonexistent")
        .expect(404);

      expect(response.body).toMatchObject({
        error: "Not Found",
        message: "Backup configuration not found",
      });
    });

    it("should handle unauthorized access", async () => {
      mockBackupConfigurationManager.deleteBackupConfig.mockRejectedValue(
        new Error("Access denied"),
      );

      const response = await request(app)
        .delete("/api/postgres/backup-configs/config-123")
        .expect(404);

      expect(response.body).toMatchObject({
        error: "Not Found",
        message: "Access denied",
      });
    });
  });

  describe("validation edge cases", () => {
    it("should validate backup format values", async () => {
      const invalidFormatRequest = {
        databaseId: "db-123",
        azureContainerName: "test-backups",
        azurePathPrefix: "db-backups/",
        backupFormat: "invalid-format" as BackupFormat,
      };

      const response = await request(app)
        .post("/api/postgres/backup-configs")
        .send(invalidFormatRequest)
        .expect(400);

      expect(response.body).toMatchObject({
        error: "Bad Request",
        message: "Invalid request data",
      });
    });

    it("should validate compression level range", async () => {
      const invalidCompressionRequest = {
        databaseId: "db-123",
        azureContainerName: "test-backups",
        azurePathPrefix: "db-backups/",
        compressionLevel: 15, // Invalid, should be 0-9
      };

      mockBackupConfigurationManager.createBackupConfig.mockRejectedValue(
        new Error("Compression level must be between 0 and 9"),
      );

      const response = await request(app)
        .post("/api/postgres/backup-configs")
        .send(invalidCompressionRequest)
        .expect(400);

      expect(response.body).toMatchObject({
        error: "Bad Request",
        message: "Invalid request data",
      });
    });

    it("should validate retention days", async () => {
      const invalidRetentionRequest = {
        databaseId: "db-123",
        azureContainerName: "test-backups",
        azurePathPrefix: "db-backups/",
        retentionDays: 0, // Invalid, should be at least 1
      };

      mockBackupConfigurationManager.createBackupConfig.mockRejectedValue(
        new Error("Retention days must be at least 1"),
      );

      const response = await request(app)
        .post("/api/postgres/backup-configs")
        .send(invalidRetentionRequest)
        .expect(400);

      expect(response.body).toMatchObject({
        error: "Bad Request",
        message: "Invalid request data",
      });
    });

    it("should validate Azure container name format", async () => {
      const invalidContainerRequest = {
        databaseId: "db-123",
        azureContainerName: "Invalid_Container_Name", // Invalid format
        azurePathPrefix: "db-backups/",
      };

      mockBackupConfigurationManager.createBackupConfig.mockRejectedValue(
        new Error(
          "Azure container name must be 3-63 characters, contain only lowercase letters, numbers, and hyphens",
        ),
      );

      const response = await request(app)
        .post("/api/postgres/backup-configs")
        .send(invalidContainerRequest)
        .expect(400);

      expect(response.body).toMatchObject({
        error: "Bad Request",
      });
    });
  });

  describe("authentication", () => {
    it("should require authentication for all endpoints", async () => {
      // Temporarily override the mock to simulate authentication failure
      mockRequireSessionOrApiKey.mockImplementation((req: any, res: any, next: any) => {
        res.status(401).json({ error: "Unauthorized" });
      });

      await request(app).get("/api/postgres/backup-configs/db-123").expect(401);
      await request(app)
        .post("/api/postgres/backup-configs")
        .send({})
        .expect(401);
      await request(app)
        .delete("/api/postgres/backup-configs/config-123")
        .expect(401);

      // Reset the mock back to its original implementation for other tests
      mockRequireSessionOrApiKey.mockImplementation((req: any, res: any, next: any) => {
        req.apiKey = {
          userId: "test-user-id",
          id: "test-key-id",
          user: { id: "test-user-id", email: "test@example.com" }
        };
        res.locals = {
          requestId: "test-request-id",
        };
        next();
      });
    });
  });

  describe("business logic validation", () => {
    it("should handle cron expression validation", async () => {
      const validCronExpressions = [
        "0 2 * * *", // Daily at 2 AM
        "0 */6 * * *", // Every 6 hours
        "0 0 * * 0", // Weekly on Sunday
        "0 0 1 * *", // Monthly on 1st
      ];

      mockBackupConfigurationManager.createBackupConfig.mockResolvedValue({
        id: "config-123",
        databaseId: "db-123",
        schedule: "0 2 * * *",
        azureContainerName: "test-backups",
        azurePathPrefix: "db-backups/",
        retentionDays: 30,
        backupFormat: "custom",
        compressionLevel: 6,
        isEnabled: true,
        lastBackupAt: null,
        nextScheduledAt: "2023-01-02T02:00:00.000Z",
        createdAt: "2023-01-01T00:00:00.000Z",
        updatedAt: "2023-01-01T00:00:00.000Z",
      });

      for (const cronExpr of validCronExpressions) {
        const response = await request(app)
          .post("/api/postgres/backup-configs")
          .send({
            databaseId: "db-123",
            schedule: cronExpr,
            azureContainerName: "test-backups",
            azurePathPrefix: "db-backups/",
          })
          .expect(201);

        expect(response.body.success).toBe(true);
      }
    });

    it("should handle backup format validation", async () => {
      const validFormats: BackupFormat[] = ["custom", "plain", "tar"];

      mockBackupConfigurationManager.createBackupConfig.mockResolvedValue({
        id: "config-123",
        databaseId: "db-123",
        schedule: null,
        azureContainerName: "test-backups",
        azurePathPrefix: "db-backups/",
        retentionDays: 30,
        backupFormat: "custom",
        compressionLevel: 6,
        isEnabled: true,
        lastBackupAt: null,
        nextScheduledAt: null,
        createdAt: "2023-01-01T00:00:00.000Z",
        updatedAt: "2023-01-01T00:00:00.000Z",
      });

      for (const format of validFormats) {
        const response = await request(app)
          .post("/api/postgres/backup-configs")
          .send({
            databaseId: "db-123",
            azureContainerName: "test-backups",
            azurePathPrefix: "db-backups/",
            backupFormat: format,
          })
          .expect(201);

        expect(response.body.success).toBe(true);
      }
    });
  });

  describe("error handling", () => {
    it("should handle unexpected errors", async () => {
      mockBackupConfigurationManager.getBackupConfigByDatabaseId.mockImplementation(
        () => {
          throw new Error("Unexpected error");
        },
      );

      const response = await request(app)
        .get("/api/postgres/backup-configs/db-123")
        .expect(500);

      expect(response.body).toMatchObject({
        error: "Internal Server Error",
        message: "Unexpected error",
      });
    });

    it("should provide request correlation IDs in error responses", async () => {
      mockBackupConfigurationManager.getBackupConfigByDatabaseId.mockRejectedValue(
        new Error("Service error"),
      );

      const response = await request(app)
        .get("/api/postgres/backup-configs/db-123")
        .set("X-Request-ID", "test-request-456")
        .expect(500);

      expect(response.body.requestId).toBe("test-request-456");
    });
  });

  describe("logging and auditing", () => {
    it("should log backup configuration creation events", async () => {
      const mockConfig = {
        id: "config-123",
        databaseId: "db-123",
        schedule: "0 2 * * *",
        azureContainerName: "test-backups",
        azurePathPrefix: "db-backups/",
        retentionDays: 30,
        backupFormat: "custom" as BackupFormat,
        compressionLevel: 6,
        isEnabled: true,
        lastBackupAt: null,
        nextScheduledAt: "2023-01-02T02:00:00.000Z",
        createdAt: "2023-01-01T00:00:00.000Z",
        updatedAt: "2023-01-01T00:00:00.000Z",
      };

      mockBackupConfigurationManager.createBackupConfig.mockResolvedValue(mockConfig);

      await request(app)
        .post("/api/postgres/backup-configs")
        .send({
          databaseId: "db-123",
          azureContainerName: "test-backups",
          azurePathPrefix: "db-backups/",
        })
        .expect(201);

      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          configId: expect.any(String),
          databaseId: "db-123",
          azureContainer: "test-backups",
        }),
        "Backup configuration created successfully",
      );
    });

    it("should log backup configuration deletion events", async () => {
      mockBackupConfigurationManager.deleteBackupConfig.mockResolvedValue(undefined);

      await request(app)
        .delete("/api/postgres/backup-configs/config-123")
        .expect(200);

      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          configId: "config-123",
        }),
        "Backup configuration deleted successfully",
      );
    });
  });

  describe("request validation", () => {
    it("should validate databaseId in path parameters", async () => {
      const response = await request(app)
        .get("/api/postgres/backup-configs/")
        .expect(404); // Should not match route
    });

    it("should validate JSON request body", async () => {
      const response = await request(app)
        .post("/api/postgres/backup-configs")
        .send("invalid-json")
        .set("Content-Type", "application/json")
        .expect(500);
    });

    it("should handle missing request body", async () => {
      const response = await request(app)
        .post("/api/postgres/backup-configs")
        .expect(400);

      expect(response.body).toMatchObject({
        error: "Bad Request",
        message: "Invalid request data",
      });
    });
  });

  describe("optional parameters", () => {
    it("should handle minimal configuration", async () => {
      const minimalRequest = {
        databaseId: "db-123",
        azureContainerName: "test-backups",
        azurePathPrefix: "db-backups/",
      };

      const mockMinimalConfig = {
        id: "config-minimal",
        databaseId: "db-123",
        schedule: null,
        azureContainerName: "test-backups",
        azurePathPrefix: "db-backups/",
        retentionDays: 30, // Default value
        backupFormat: "custom", // Default value
        compressionLevel: 6, // Default value
        isEnabled: true, // Default value
        lastBackupAt: null,
        nextScheduledAt: null,
        createdAt: "2023-01-01T00:00:00.000Z",
        updatedAt: "2023-01-01T00:00:00.000Z",
      };

      mockBackupConfigurationManager.createBackupConfig.mockResolvedValue(
        mockMinimalConfig,
      );

      const response = await request(app)
        .post("/api/postgres/backup-configs")
        .send(minimalRequest)
        .expect(201);

      expect(response.body.data.retentionDays).toBe(30);
      expect(response.body.data.backupFormat).toBe("custom");
      expect(response.body.data.compressionLevel).toBe(6);
      expect(response.body.data.isEnabled).toBe(true);
    });
  });
});
