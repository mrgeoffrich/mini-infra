import { jest } from "@jest/globals";
import request from "supertest";
import express from "express";
import { createId } from "@paralleldrive/cuid2";
import {
  PostgresDatabase,
  CreatePostgresDatabaseRequest,
  UpdatePostgresDatabaseRequest,
} from "@mini-infra/types";

// Mock DatabaseConfigService
const mockDatabaseConfigService = {
  listDatabases: jest.fn(),
  getDatabaseById: jest.fn(),
  createDatabase: jest.fn(),
  updateDatabase: jest.fn(),
  deleteDatabase: jest.fn(),
  testConnection: jest.fn(),
  testDatabaseConnection: jest.fn(),
};

jest.mock("../../services/postgres-config", () => ({
  DatabaseConfigService: jest
    .fn()
    .mockImplementation(() => mockDatabaseConfigService),
}));

// Mock Prisma
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {},
}));

// Mock logger
const mockLogger = {
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
};

jest.mock("../../lib/logger-factory", () => ({
  appLogger: jest.fn(() => mockLogger),
  servicesLogger: jest.fn(() => mockLogger),
  httpLogger: jest.fn(() => mockLogger),
  prismaLogger: jest.fn(() => mockLogger),
  __esModule: true,
  default: jest.fn(() => mockLogger),
}));

// Mock auth middleware
const mockRequireAuth = jest.fn((req: any, res: any, next: any) => {
  req.user = { id: "test-user-id", email: "test@example.com" };
  next();
});

const mockGetAuthenticatedUser = jest.fn(() => ({
  id: "test-user-id",
  email: "test@example.com",
}));

jest.mock("../../lib/auth-middleware", () => ({
  requireAuth: mockRequireAuth,
  getAuthenticatedUser: mockGetAuthenticatedUser,
}));

import postgresDatabasesRouter from "../postgres-databases";

describe("PostgreSQL Databases API Routes", () => {
  let app: express.Application;

  // Mock data that needs to be accessible across multiple test blocks
  const mockDatabases: PostgresDatabase[] = [
    {
      id: "db-1",
      name: "production-db",
      connectionString: "[ENCRYPTED]",
      host: "prod-host",
      port: 5432,
      database: "prod_db",
      username: "prod_user",
      sslMode: "require",
      tags: ["production"],
      createdAt: "2023-01-01T10:00:00.000Z",
      updatedAt: "2023-01-01T11:00:00.000Z",
      lastHealthCheck: "2023-01-01T12:00:00.000Z",
      healthStatus: "healthy",
      userId: "test-user-id",
    },
    {
      id: "db-2",
      name: "development-db",
      connectionString: "[ENCRYPTED]",
      host: "dev-host",
      port: 5432,
      database: "dev_db",
      username: "dev_user",
      sslMode: "prefer",
      tags: ["development"],
      createdAt: "2023-01-02T10:00:00.000Z",
      updatedAt: "2023-01-02T11:00:00.000Z",
      lastHealthCheck: null,
      healthStatus: "unknown",
      userId: "test-user-id",
    },
  ];

  beforeAll(() => {
    app = express();
    app.use(express.json());

    // Add request ID middleware for testing
    app.use((req: any, res: any, next: any) => {
      req.headers["x-request-id"] = req.headers["x-request-id"] || createId();
      req.get = jest.fn((header: string) => {
        if (header === "User-Agent") return "Test Agent";
        if (header === "X-Forwarded-For") return "127.0.0.1";
        return undefined;
      });
      next();
    });

    app.use("/api/postgres/databases", postgresDatabasesRouter);

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
    jest.clearAllMocks();
    
    // Reset auth middleware to always pass
    mockRequireAuth.mockImplementation((req: any, res: any, next: any) => {
      req.user = { id: "test-user-id", email: "test@example.com" };
      next();
    });
    
    mockGetAuthenticatedUser.mockReturnValue({
      id: "test-user-id",
      email: "test@example.com",
    });
  });

  describe("GET /api/postgres/databases", () => {

    it("should return databases list successfully", async () => {
      mockDatabaseConfigService.listDatabases.mockResolvedValue(mockDatabases);

      const response = await request(app)
        .get("/api/postgres/databases")
        .expect(200);

      expect(response.body).toMatchObject({
        success: true,
        data: mockDatabases,
        pagination: {
          page: 1,
          limit: 20,
          totalCount: 2,
          hasMore: false,
        },
      });

      expect(mockDatabaseConfigService.listDatabases).toHaveBeenCalledWith(
        "test-user-id",
        {},
        { field: "name", order: "asc" },
        20,
        0,
      );
    });

    it("should handle pagination parameters", async () => {
      mockDatabaseConfigService.listDatabases.mockResolvedValue([
        mockDatabases[0],
      ]);

      await request(app)
        .get("/api/postgres/databases")
        .query({ limit: 10, page: 2 })
        .expect(200);

      expect(mockDatabaseConfigService.listDatabases).toHaveBeenCalledWith(
        "test-user-id",
        {},
        { field: "name", order: "asc" },
        10,
        10,
      );
    });

    it("should handle filter parameters", async () => {
      mockDatabaseConfigService.listDatabases.mockResolvedValue([]);

      await request(app)
        .get("/api/postgres/databases")
        .query({
          name: "prod",
          healthStatus: "healthy",
          tags: "production,staging",
        })
        .expect(200);

      expect(mockDatabaseConfigService.listDatabases).toHaveBeenCalledWith(
        "test-user-id",
        {
          name: "prod",
          healthStatus: "healthy",
          tags: ["production", "staging"],
        },
        { field: "name", order: "asc" },
        20,
        0,
      );
    });

    it("should handle service errors", async () => {
      mockDatabaseConfigService.listDatabases.mockRejectedValue(
        new Error("Database service error"),
      );

      const response = await request(app)
        .get("/api/postgres/databases")
        .expect(500);

      expect(response.body).toMatchObject({
        error: "Internal Server Error",
        message: "Database service error",
      });

      expect(mockLogger.error).toHaveBeenCalled();
    });

    it("should require authentication", async () => {
      mockRequireAuth.mockImplementationOnce(
        (req: any, res: any, next: any) => {
          res.status(401).json({ error: "Unauthorized" });
        },
      );

      await request(app).get("/api/postgres/databases").expect(401);
    });
  });

  describe("GET /api/postgres/databases/:id", () => {
    const mockDatabase = mockDatabases[0];

    it("should return specific database successfully", async () => {
      mockDatabaseConfigService.getDatabaseById.mockResolvedValue(mockDatabase);

      const response = await request(app)
        .get("/api/postgres/databases/db-1")
        .expect(200);

      expect(response.body).toMatchObject({
        success: true,
        data: mockDatabase,
      });

      expect(mockDatabaseConfigService.getDatabaseById).toHaveBeenCalledWith(
        "db-1",
        "test-user-id",
      );
    });

    it("should return 404 for non-existent database", async () => {
      mockDatabaseConfigService.getDatabaseById.mockResolvedValue(null);

      const response = await request(app)
        .get("/api/postgres/databases/nonexistent")
        .expect(404);

      expect(response.body).toMatchObject({
        error: "Not Found",
        message: "Database configuration with ID 'nonexistent' not found",
      });
    });

    it("should handle service errors", async () => {
      mockDatabaseConfigService.getDatabaseById.mockRejectedValue(
        new Error("Database error"),
      );

      await request(app).get("/api/postgres/databases/db-1").expect(500);
    });
  });

  describe("POST /api/postgres/databases", () => {
    const validCreateRequest: CreatePostgresDatabaseRequest = {
      name: "new-db",
      host: "localhost",
      port: 5432,
      database: "newdb",
      username: "newuser",
      password: "newpass",
      sslMode: "prefer",
      tags: ["test"],
    };

    const mockCreatedDatabase: PostgresDatabase = {
      id: "db-new",
      name: "new-db",
      connectionString: "[ENCRYPTED]",
      host: "localhost",
      port: 5432,
      database: "newdb",
      username: "newuser",
      sslMode: "prefer",
      tags: ["test"],
      createdAt: "2023-01-01T10:00:00.000Z",
      updatedAt: "2023-01-01T10:00:00.000Z",
      lastHealthCheck: null,
      healthStatus: "unknown",
      userId: "test-user-id",
    };

    it("should create database successfully", async () => {
      mockDatabaseConfigService.createDatabase.mockResolvedValue(
        mockCreatedDatabase,
      );

      const response = await request(app)
        .post("/api/postgres/databases")
        .send(validCreateRequest)
        .expect(201);

      expect(response.body).toMatchObject({
        success: true,
        message: "Database configuration created successfully",
        data: mockCreatedDatabase,
      });

      expect(mockDatabaseConfigService.createDatabase).toHaveBeenCalledWith(
        validCreateRequest,
        "test-user-id",
      );
    });

    it("should validate required fields", async () => {
      const invalidRequest = { ...validCreateRequest, name: "" };

      const response = await request(app)
        .post("/api/postgres/databases")
        .send(invalidRequest)
        .expect(400);

      expect(response.body).toMatchObject({
        error: "Bad Request",
        message: "Invalid request data",
      });
    });

    it("should handle duplicate database name", async () => {
      mockDatabaseConfigService.createDatabase.mockRejectedValue(
        new Error("Database configuration with name 'new-db' already exists"),
      );

      const response = await request(app)
        .post("/api/postgres/databases")
        .send(validCreateRequest)
        .expect(409);

      expect(response.body).toMatchObject({
        error: "Conflict",
        message: "Database configuration with name 'new-db' already exists",
      });
    });

    it("should handle validation errors", async () => {
      const response = await request(app)
        .post("/api/postgres/databases")
        .send({ ...validCreateRequest, port: 70000 })
        .expect(400);

      expect(response.body).toMatchObject({
        error: "Bad Request",
        message: "Invalid request data",
      });
    });
  });

  describe("PUT /api/postgres/databases/:id", () => {
    const updateRequest: UpdatePostgresDatabaseRequest = {
      name: "updated-db",
      host: "newhost",
      port: 5433,
    };

    const mockUpdatedDatabase: PostgresDatabase = {
      id: "db-1",
      name: "updated-db",
      connectionString: "[ENCRYPTED]",
      host: "newhost",
      port: 5433,
      database: "prod_db",
      username: "prod_user",
      sslMode: "require",
      tags: ["production"],
      createdAt: "2023-01-01T10:00:00.000Z",
      updatedAt: "2023-01-01T13:00:00.000Z",
      lastHealthCheck: null,
      healthStatus: "unknown",
      userId: "test-user-id",
    };

    it("should update database successfully", async () => {
      mockDatabaseConfigService.updateDatabase.mockResolvedValue(
        mockUpdatedDatabase,
      );

      const response = await request(app)
        .put("/api/postgres/databases/db-1")
        .send(updateRequest)
        .expect(200);

      expect(response.body).toMatchObject({
        success: true,
        message: "Database configuration updated successfully",
        data: mockUpdatedDatabase,
      });

      expect(mockDatabaseConfigService.updateDatabase).toHaveBeenCalledWith(
        "db-1",
        updateRequest,
        "test-user-id",
      );
    });

    it("should return 404 for non-existent database", async () => {
      mockDatabaseConfigService.updateDatabase.mockRejectedValue(
        new Error("Database configuration not found"),
      );

      const response = await request(app)
        .put("/api/postgres/databases/nonexistent")
        .send(updateRequest)
        .expect(404);

      expect(response.body).toMatchObject({
        error: "Not Found",
        message: "Database configuration not found",
      });
    });

    it("should handle unauthorized access", async () => {
      mockDatabaseConfigService.updateDatabase.mockRejectedValue(
        new Error(
          "Access denied: You can only update your own database configurations",
        ),
      );

      const response = await request(app)
        .put("/api/postgres/databases/db-1")
        .send(updateRequest)
        .expect(404);

      expect(response.body).toMatchObject({
        error: "Not Found",
      });
    });
  });

  describe("DELETE /api/postgres/databases/:id", () => {
    it("should delete database successfully", async () => {
      // Mock getDatabaseById to return a database first (required by the delete endpoint)
      mockDatabaseConfigService.getDatabaseById.mockResolvedValue(mockDatabases[0]);
      mockDatabaseConfigService.deleteDatabase.mockResolvedValue(undefined);

      const response = await request(app)
        .delete("/api/postgres/databases/db-1")
        .expect(200);

      expect(response.body).toMatchObject({
        success: true,
        message: "Database configuration deleted successfully",
      });

      expect(mockDatabaseConfigService.deleteDatabase).toHaveBeenCalledWith(
        "db-1",
        "test-user-id",
      );
    });

    it("should return 404 for non-existent database", async () => {
      // Mock getDatabaseById to return null first (required by the delete endpoint)
      mockDatabaseConfigService.getDatabaseById.mockResolvedValue(null);

      const response = await request(app)
        .delete("/api/postgres/databases/nonexistent")
        .expect(404);

      expect(response.body).toMatchObject({
        error: "Not Found",
        message: "Database configuration with ID 'nonexistent' not found",
      });
    });
  });

  describe("POST /api/postgres/databases/:id/test", () => {
    const mockTestResult = {
      isValid: true,
      message: "Connection successful",
      serverVersion: "PostgreSQL 15.0",
      databaseName: "testdb",
      responseTimeMs: 150,
    };

    it("should test database connection successfully", async () => {
      mockDatabaseConfigService.testDatabaseConnection.mockResolvedValue(
        mockTestResult,
      );

      const response = await request(app)
        .post("/api/postgres/databases/db-1/test")
        .expect(200);

      expect(response.body).toMatchObject({
        success: true,
        message: "Connection successful",
        data: {
          isConnected: true,
          responseTimeMs: 150,
          serverVersion: "PostgreSQL 15.0",
          databaseName: "testdb",
        },
      });

      expect(
        mockDatabaseConfigService.testDatabaseConnection,
      ).toHaveBeenCalledWith("db-1", "test-user-id");
    });

    it("should return connection failure result", async () => {
      const failedTestResult = {
        isValid: false,
        message: "Connection timeout",
        errorCode: "TIMEOUT",
      };

      mockDatabaseConfigService.testDatabaseConnection.mockResolvedValue(
        failedTestResult,
      );

      const response = await request(app)
        .post("/api/postgres/databases/db-1/test")
        .expect(200);

      expect(response.body).toMatchObject({
        success: true,
        message: "Connection failed",
        data: {
          isConnected: false,
          responseTimeMs: 0,
          error: "Connection timeout",
          errorCode: "TIMEOUT",
        },
      });
    });

    it("should handle test errors", async () => {
      mockDatabaseConfigService.testDatabaseConnection.mockRejectedValue(
        new Error("Database configuration not found or access denied"),
      );

      const response = await request(app)
        .post("/api/postgres/databases/db-1/test")
        .expect(404);

      expect(response.body).toMatchObject({
        error: "Not Found",
      });
    });
  });

  describe("POST /api/postgres/test-connection", () => {
    const validConnectionConfig = {
      host: "localhost",
      port: 5432,
      database: "testdb",
      username: "testuser",
      password: "testpass",
      sslMode: "prefer" as const,
    };

    const mockTestResult = {
      isValid: true,
      message: "Connection successful",
      serverVersion: "PostgreSQL 15.0",
      databaseName: "testdb",
      responseTimeMs: 100,
    };

    it("should test connection with provided config successfully", async () => {
      mockDatabaseConfigService.testConnection.mockResolvedValue(
        mockTestResult,
      );

      const response = await request(app)
        .post("/api/postgres/databases/test-connection")
        .send(validConnectionConfig)
        .expect(200);

      expect(response.body).toMatchObject({
        success: true,
        message: "Connection successful",
        data: {
          isConnected: true,
          responseTimeMs: 100,
          serverVersion: "PostgreSQL 15.0",
          databaseName: "testdb",
        },
      });

      expect(mockDatabaseConfigService.testConnection).toHaveBeenCalledWith(
        validConnectionConfig,
      );
    });

    it("should validate request body", async () => {
      const invalidConfig = { ...validConnectionConfig, port: "invalid" };

      const response = await request(app)
        .post("/api/postgres/databases/test-connection")
        .send(invalidConfig)
        .expect(400);

      expect(response.body).toMatchObject({
        error: "Bad Request",
        message: "Invalid request data",
      });
    });

    it("should handle connection failure", async () => {
      const failedResult = {
        isValid: false,
        message: "Authentication failed",
        errorCode: "AUTHENTICATION_FAILED",
      };

      mockDatabaseConfigService.testConnection.mockResolvedValue(failedResult);

      const response = await request(app)
        .post("/api/postgres/databases/test-connection")
        .send(validConnectionConfig)
        .expect(200);

      expect(response.body).toMatchObject({
        success: true,
        message: "Connection failed",
        data: {
          isConnected: false,
          responseTimeMs: 0,
          error: "Authentication failed",
          errorCode: "AUTHENTICATION_FAILED",
        },
      });
    });

    it("should redact sensitive data in logs", async () => {
      mockDatabaseConfigService.testConnection.mockResolvedValue(
        mockTestResult,
      );

      await request(app)
        .post("/api/postgres/databases/test-connection")
        .send(validConnectionConfig)
        .expect(200);

      // Verify password is not logged in plain text
      const logCalls = mockLogger.info.mock.calls;
      const hasPasswordInLogs = logCalls.some((call) =>
        JSON.stringify(call).includes("testpass"),
      );
      expect(hasPasswordInLogs).toBe(false);
    });
  });

  describe("authentication", () => {
    it("should require authentication for all endpoints", async () => {
      mockRequireAuth.mockImplementation((req: any, res: any, next: any) => {
        res.status(401).json({ error: "Unauthorized" });
      });

      await request(app).get("/api/postgres/databases").expect(401);
      await request(app).get("/api/postgres/databases/db-1").expect(401);
      await request(app).post("/api/postgres/databases").send({}).expect(401);
      await request(app)
        .put("/api/postgres/databases/db-1")
        .send({})
        .expect(401);
      await request(app).delete("/api/postgres/databases/db-1").expect(401);
      await request(app).post("/api/postgres/databases/db-1/test").expect(401);
      await request(app)
        .post("/api/postgres/databases/test-connection")
        .send({})
        .expect(401);
    });
  });

  describe("error handling", () => {
    it("should handle unexpected errors", async () => {
      mockDatabaseConfigService.listDatabases.mockImplementation(() => {
        throw new Error("Unexpected error");
      });

      const response = await request(app)
        .get("/api/postgres/databases")
        .expect(500);

      expect(response.body).toMatchObject({
        error: "Internal Server Error",
        message: "Unexpected error",
      });
    });

    it("should provide request correlation IDs in error responses", async () => {
      mockDatabaseConfigService.listDatabases.mockRejectedValue(
        new Error("Service error"),
      );

      const response = await request(app)
        .get("/api/postgres/databases")
        .set("X-Request-ID", "test-request-123")
        .expect(500);

      expect(response.body.requestId).toBe("test-request-123");
    });
  });

  describe("business logic validation", () => {
    it("should handle validation for port range", async () => {
      const invalidPortRequest = {
        name: "test-db",
        host: "localhost",
        port: 70000,
        database: "testdb",
        username: "testuser",
        password: "testpass",
        sslMode: "prefer" as const,
      };

      const response = await request(app)
        .post("/api/postgres/databases")
        .send(invalidPortRequest)
        .expect(400);

      expect(response.body).toMatchObject({
        error: "Bad Request",
        message: "Invalid request data",
      });
    });

    it("should handle SSL mode validation", async () => {
      const invalidSSLRequest = {
        name: "test-db",
        host: "localhost",
        port: 5432,
        database: "testdb",
        username: "testuser",
        password: "testpass",
        sslMode: "invalid" as any,
      };

      const response = await request(app)
        .post("/api/postgres/databases")
        .send(invalidSSLRequest)
        .expect(400);

      expect(response.body).toMatchObject({
        error: "Bad Request",
        message: "Invalid request data",
      });
    });
  });

  describe("sorting and ordering", () => {
    it("should handle sort parameters", async () => {
      mockDatabaseConfigService.listDatabases.mockResolvedValue([]);

      await request(app)
        .get("/api/postgres/databases")
        .query({ sortBy: "name", sortOrder: "asc" })
        .expect(200);

      expect(mockDatabaseConfigService.listDatabases).toHaveBeenCalledWith(
        "test-user-id",
        {},
        { field: "name", order: "asc" },
        20,
        0,
      );
    });

    it("should use default sorting when not specified", async () => {
      mockDatabaseConfigService.listDatabases.mockResolvedValue([]);

      await request(app).get("/api/postgres/databases").expect(200);

      expect(mockDatabaseConfigService.listDatabases).toHaveBeenCalledWith(
        "test-user-id",
        {},
        { field: "name", order: "asc" },
        20,
        0,
      );
    });
  });
});
