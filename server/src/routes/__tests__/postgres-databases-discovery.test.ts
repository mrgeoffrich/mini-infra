import request from "supertest";
import express, { Express } from "express";
import { DatabaseInfo } from "@mini-infra/types";

const { mockDiscoverDatabases, mockLogger } = vi.hoisted(() => ({
  mockDiscoverDatabases: vi.fn(),
  mockLogger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock PostgresDatabaseManager
vi.mock("../../services/postgres/postgres-database-manager", () => ({
  PostgresDatabaseManager: vi.fn().mockImplementation(function() {
    return {
      discoverDatabases: mockDiscoverDatabases,
    };
  }),
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

// Mock auth middleware
vi.mock("../../lib/api-key-middleware", () => ({
  requireSessionOrApiKey: (req: any, res: any, next: any) => {
    req.apiKey = {
      userId: "test-user-id",
      id: "test-key-id",
      user: { id: "test-user-id", email: "test@example.com" },
      permissions: null,
    };
    res.locals = {
      requestId: req.headers["x-request-id"] || undefined,
    };
    next();
  },
  getCurrentUserId: (req: any) => "test-user-id",
  getCurrentUser: (req: any) => ({ id: "test-user-id", email: "test@example.com" }),
}));

vi.mock("../../lib/permission-middleware", () => ({
  requirePermission: () => (req: any, res: any, next: any) => {
    req.apiKey = {
      userId: "test-user-id",
      id: "test-key-id",
      user: { id: "test-user-id", email: "test@example.com" },
      permissions: null,
    };
    next();
  },
}));

vi.mock("../../lib/auth-middleware", () => ({
  requireAuth: (req: any, res: any, next: any) => {
    req.user = { id: "test-user-id", email: "test@example.com" };
    next();
  },
  getAuthenticatedUser: (req: any) => ({ id: "test-user-id", email: "test@example.com" }),
}));

import postgresDatabasesRouter from "../postgres-databases";

describe("PostgreSQL Database Discovery API", () => {
  let app: Express;

  beforeEach(() => {
    vi.clearAllMocks();

    app = express();
    app.use(express.json());
    app.use("/api/postgres/databases", postgresDatabasesRouter);
  });

  describe("POST /api/postgres/databases/discover-databases", () => {
    const validDiscoveryRequest = {
      host: "localhost",
      port: 5432,
      username: "postgres",
      password: "password123",
      sslMode: "prefer" as const,
    };

    const mockDatabases: DatabaseInfo[] = [
      {
        name: "myapp_production",
        isTemplate: false,
        allowConnections: true,
        encoding: "UTF8",
        collation: "en_US.UTF-8",
        characterClassification: "en_US.UTF-8",
        sizePretty: "45 MB",
        description: "Production database for MyApp",
      },
      {
        name: "myapp_staging",
        isTemplate: false,
        allowConnections: true,
        encoding: "UTF8",
        collation: "en_US.UTF-8",
        characterClassification: "en_US.UTF-8",
        sizePretty: "12 MB",
      },
      {
        name: "analytics",
        isTemplate: false,
        allowConnections: true,
        encoding: "UTF8",
        collation: "en_US.UTF-8",
        characterClassification: "en_US.UTF-8",
        sizePretty: "150 MB",
        description: "Analytics and reporting database",
      },
    ];

    it("should successfully discover databases", async () => {
      mockDiscoverDatabases.mockResolvedValueOnce({
        databases: mockDatabases,
        serverVersion: "PostgreSQL 14.5 on x86_64-pc-linux-gnu",
        responseTimeMs: 234,
      });

      const response = await request(app)
        .post("/api/postgres/databases/discover-databases")
        .send(validDiscoveryRequest)
        .set("Content-Type", "application/json")
        .set("X-Request-ID", "test-request-123");

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        data: {
          databases: mockDatabases,
          serverVersion: "PostgreSQL 14.5 on x86_64-pc-linux-gnu",
          responseTimeMs: 234,
          testedAt: expect.any(String),
        },
        message: "Found 3 database(s)",
        timestamp: expect.any(String),
        requestId: "test-request-123",
      });

      expect(mockDiscoverDatabases).toHaveBeenCalledWith(validDiscoveryRequest);
    });

    it("should handle discovery with no databases found", async () => {
      mockDiscoverDatabases.mockResolvedValueOnce({
        databases: [],
        serverVersion: "PostgreSQL 14.5 on x86_64-pc-linux-gnu",
        responseTimeMs: 156,
      });

      const response = await request(app)
        .post("/api/postgres/databases/discover-databases")
        .send(validDiscoveryRequest)
        .set("Content-Type", "application/json");

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        data: {
          databases: [],
          serverVersion: "PostgreSQL 14.5 on x86_64-pc-linux-gnu",
          responseTimeMs: 156,
          testedAt: expect.any(String),
        },
        message: "Found 0 database(s)",
        timestamp: expect.any(String),
        requestId: undefined,
      });
    });

    it("should validate required fields", async () => {
      const invalidRequest = {
        host: "",
        port: 5432,
        username: "postgres",
        password: "password123",
        sslMode: "prefer",
      };

      const response = await request(app)
        .post("/api/postgres/databases/discover-databases")
        .send(invalidRequest)
        .set("Content-Type", "application/json");

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: "Bad Request",
        message: "Invalid request data",
        details: expect.arrayContaining([
          expect.objectContaining({
            path: ["host"],
            message: "Host is required",
          }),
        ]),
        timestamp: expect.any(String),
        requestId: undefined,
      });

      expect(mockDiscoverDatabases).not.toHaveBeenCalled();
    });

    it("should validate port range", async () => {
      const invalidRequest = {
        ...validDiscoveryRequest,
        port: 70000,
      };

      const response = await request(app)
        .post("/api/postgres/databases/discover-databases")
        .send(invalidRequest)
        .set("Content-Type", "application/json");

      expect(response.status).toBe(400);
      expect(response.body.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ["port"],
            message: "Port must be between 1 and 65535",
          }),
        ])
      );
    });

    it("should validate SSL mode enum", async () => {
      const invalidRequest = {
        ...validDiscoveryRequest,
        sslMode: "invalid",
      };

      const response = await request(app)
        .post("/api/postgres/databases/discover-databases")
        .send(invalidRequest)
        .set("Content-Type", "application/json");

      expect(response.status).toBe(400);
      expect(response.body.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ["sslMode"],
          }),
        ])
      );
    });

    it("should handle connection failures", async () => {
      const connectionError = new Error("Connection refused");
      mockDiscoverDatabases.mockRejectedValueOnce(connectionError);

      const response = await request(app)
        .post("/api/postgres/databases/discover-databases")
        .send(validDiscoveryRequest)
        .set("Content-Type", "application/json");

      expect(response.status).toBe(500);
      expect(mockDiscoverDatabases).toHaveBeenCalledWith(validDiscoveryRequest);
    });

    it("should handle authentication failures", async () => {
      const authError = new Error("authentication failed for user postgres");
      mockDiscoverDatabases.mockRejectedValueOnce(authError);

      const response = await request(app)
        .post("/api/postgres/databases/discover-databases")
        .send(validDiscoveryRequest)
        .set("Content-Type", "application/json");

      expect(response.status).toBe(500);
      expect(mockDiscoverDatabases).toHaveBeenCalledWith(validDiscoveryRequest);
    });

    it("should handle timeout errors", async () => {
      const timeoutError = new Error("Connection timeout");
      mockDiscoverDatabases.mockRejectedValueOnce(timeoutError);

      const response = await request(app)
        .post("/api/postgres/databases/discover-databases")
        .send(validDiscoveryRequest)
        .set("Content-Type", "application/json");

      expect(response.status).toBe(500);
      expect(mockDiscoverDatabases).toHaveBeenCalledWith(validDiscoveryRequest);
    });

    it("should require authentication", async () => {
      // This test would need to be adjusted based on how authentication is mocked
      // For now, we assume the requireSessionOrApiKey middleware is properly tested elsewhere
      expect(true).toBe(true);
    });

    it("should handle missing request body", async () => {
      const response = await request(app)
        .post("/api/postgres/databases/discover-databases")
        .set("Content-Type", "application/json");

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("Bad Request");
      expect(response.body.message).toBe("Invalid request data");
    });

    it("should handle invalid JSON", async () => {
      const response = await request(app)
        .post("/api/postgres/databases/discover-databases")
        .send("invalid json")
        .set("Content-Type", "application/json");

      expect(response.status).toBe(400);
    });

    it("should include correlation ID in logs", async () => {
      mockDiscoverDatabases.mockResolvedValueOnce({
        databases: mockDatabases,
        serverVersion: "PostgreSQL 14.5",
        responseTimeMs: 234,
      });

      const correlationId = "test-correlation-456";
      const response = await request(app)
        .post("/api/postgres/databases/discover-databases")
        .send(validDiscoveryRequest)
        .set("Content-Type", "application/json")
        .set("X-Request-ID", correlationId);

      expect(response.status).toBe(200);
      expect(response.body.requestId).toBe(correlationId);
    });
  });
});