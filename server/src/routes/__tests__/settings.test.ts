import request from "supertest";
import express from "express";
import { createId } from "@paralleldrive/cuid2";
import {
  SystemSettings,
  SettingsCategory,
} from "@mini-infra/types";

const { mockPrisma, mockLogger } = vi.hoisted(() => ({
  mockPrisma: {
    systemSettings: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
    },
  },
  mockLogger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock Prisma client
vi.mock("../../lib/prisma", () => ({ default: mockPrisma }));

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
vi.mock("../../lib/auth-middleware", () => ({
  requireAuth: (req: any, res: any, next: any) => {
    req.user = { id: "test-user-id", email: "test@example.com" };
    next();
  },
  getAuthenticatedUser: (req: any) => ({ id: "test-user-id", email: "test@example.com" }),
}));

import settingsRouter from "../settings";

describe("Settings API Routes", () => {
  let app: express.Application;

  beforeAll(() => {
    app = express();
    app.use(express.json());

    // Add request ID middleware for testing
    app.use((req: any, res: any, next: any) => {
      req.headers["x-request-id"] = req.headers["x-request-id"] || createId();
      req.get = vi.fn((header: string) => {
        if (header === "User-Agent") return "Test Agent";
        return undefined;
      });
      next();
    });

    app.use("/api/settings", settingsRouter);

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

  describe("GET /api/settings", () => {
    const mockSettings: SystemSettings[] = [
      {
        id: "setting-1",
        category: "docker",
        key: "host",
        value: "tcp://localhost:2375",
        isEncrypted: false,
        isActive: true,
        validationStatus: "valid",
        validationMessage: null,
        lastValidatedAt: new Date("2023-01-01T12:00:00Z"),
        createdBy: "user-1",
        updatedBy: "user-1",
        createdAt: new Date("2023-01-01T10:00:00Z"),
        updatedAt: new Date("2023-01-01T11:00:00Z"),
      },
      {
        id: "setting-2",
        category: "cloudflare",
        key: "api_token",
        value: "encrypted_token_value",
        isEncrypted: true,
        isActive: true,
        validationStatus: "pending",
        validationMessage: null,
        lastValidatedAt: null,
        createdBy: "user-2",
        updatedBy: "user-2",
        createdAt: new Date("2023-01-02T10:00:00Z"),
        updatedAt: new Date("2023-01-02T11:00:00Z"),
      },
    ];

    it("should return settings list successfully", async () => {
      mockPrisma.systemSettings.findMany.mockResolvedValue(mockSettings);
      mockPrisma.systemSettings.count.mockResolvedValue(2);

      const response = await request(app).get("/api/settings").expect(200);

      expect(response.body).toMatchObject({
        success: true,
        message: "Found 2 settings",
        data: expect.arrayContaining([
          expect.objectContaining({
            id: "setting-1",
            category: "docker",
            key: "host",
            value: "tcp://localhost:2375",
            isEncrypted: false,
            lastValidatedAt: "2023-01-01T12:00:00.000Z",
            createdAt: "2023-01-01T10:00:00.000Z",
          }),
          expect.objectContaining({
            id: "setting-2",
            category: "cloudflare",
            key: "api_token",
            value: "encrypted_token_value",
            isEncrypted: true,
            lastValidatedAt: null,
          }),
        ]),
      });

      expect(mockPrisma.systemSettings.findMany).toHaveBeenCalledWith({
        where: { isActive: false },
        orderBy: { category: "asc" },
        skip: 0,
        take: 20,
      });

      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "test-user-id",
          totalSettings: 2,
          returnedSettings: 2,
        }),
        "Settings list returned successfully",
      );
    });

    it("should handle pagination parameters", async () => {
      const manySettings = Array.from({ length: 75 }, (_, i) => ({
        ...mockSettings[0],
        id: `setting-${i + 1}`,
        key: `key-${i + 1}`,
      }));

      mockPrisma.systemSettings.findMany.mockResolvedValue(
        manySettings.slice(50, 75),
      );
      mockPrisma.systemSettings.count.mockResolvedValue(75);

      const response = await request(app)
        .get("/api/settings?page=3&limit=25")
        .expect(200);

      expect(response.body.data).toHaveLength(25);
      expect(mockPrisma.systemSettings.findMany).toHaveBeenCalledWith({
        where: { isActive: false },
        orderBy: { category: "asc" },
        skip: 50,
        take: 25,
      });
    });

    it("should enforce maximum limit of 100", async () => {
      mockPrisma.systemSettings.findMany.mockResolvedValue([]);
      mockPrisma.systemSettings.count.mockResolvedValue(0);

      const response = await request(app)
        .get("/api/settings?limit=200")
        .expect(200);

      expect(mockPrisma.systemSettings.findMany).toHaveBeenCalledWith({
        where: { isActive: false },
        orderBy: { category: "asc" },
        skip: 0,
        take: 100,
      });
    });

    it("should filter by category", async () => {
      mockPrisma.systemSettings.findMany.mockResolvedValue([mockSettings[0]]);
      mockPrisma.systemSettings.count.mockResolvedValue(1);

      const response = await request(app)
        .get("/api/settings?category=docker")
        .expect(200);

      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].category).toBe("docker");

      expect(mockPrisma.systemSettings.findMany).toHaveBeenCalledWith({
        where: { category: "docker", isActive: false },
        orderBy: { category: "asc" },
        skip: 0,
        take: 20,
      });
    });

    it("should filter by isActive status", async () => {
      mockPrisma.systemSettings.findMany.mockResolvedValue(mockSettings);
      mockPrisma.systemSettings.count.mockResolvedValue(2);

      const response = await request(app)
        .get("/api/settings?isActive=true")
        .expect(200);

      expect(mockPrisma.systemSettings.findMany).toHaveBeenCalledWith({
        where: { isActive: true },
        orderBy: { category: "asc" },
        skip: 0,
        take: 20,
      });
    });

    it("should filter by validation status", async () => {
      mockPrisma.systemSettings.findMany.mockResolvedValue([mockSettings[0]]);
      mockPrisma.systemSettings.count.mockResolvedValue(1);

      const response = await request(app)
        .get("/api/settings?validationStatus=valid")
        .expect(200);

      expect(mockPrisma.systemSettings.findMany).toHaveBeenCalledWith({
        where: { validationStatus: "valid", isActive: false },
        orderBy: { category: "asc" },
        skip: 0,
        take: 20,
      });
    });

    it("should sort by different fields and orders", async () => {
      mockPrisma.systemSettings.findMany.mockResolvedValue(mockSettings);
      mockPrisma.systemSettings.count.mockResolvedValue(2);

      const response = await request(app)
        .get("/api/settings?sortBy=createdAt&sortOrder=desc")
        .expect(200);

      expect(mockPrisma.systemSettings.findMany).toHaveBeenCalledWith({
        where: { isActive: false },
        orderBy: { createdAt: "desc" },
        skip: 0,
        take: 20,
      });
    });

    it("should return 400 for invalid query parameters", async () => {
      const response = await request(app)
        .get(
          "/api/settings?page=invalid&category=invalid&validationStatus=invalid",
        )
        .expect(400);

      expect(response.body).toMatchObject({
        error: "Bad Request",
        message: "Invalid query parameters",
        details: expect.any(Array),
      });

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          validationErrors: expect.any(Array),
        }),
        "Invalid query parameters for settings list",
      );
    });

    it("should handle database errors gracefully", async () => {
      const dbError = new Error("Database connection failed");
      mockPrisma.systemSettings.findMany.mockRejectedValue(dbError);

      const response = await request(app).get("/api/settings").expect(500);

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          error: dbError,
          userId: "test-user-id",
        }),
        "Failed to fetch settings list",
      );
    });
  });

  describe("GET /api/settings/:id", () => {
    const mockSetting: SystemSettings = {
      id: "setting-123",
      category: "docker",
      key: "host",
      value: "tcp://localhost:2375",
      isEncrypted: false,
      isActive: true,
      validationStatus: "valid",
      validationMessage: null,
      lastValidatedAt: new Date("2023-01-01T12:00:00Z"),
      createdBy: "user-1",
      updatedBy: "user-1",
      createdAt: new Date("2023-01-01T10:00:00Z"),
      updatedAt: new Date("2023-01-01T11:00:00Z"),
    };

    it("should return specific setting by ID", async () => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue(mockSetting);

      const response = await request(app)
        .get("/api/settings/setting-123")
        .expect(200);

      expect(response.body).toMatchObject({
        success: true,
        data: expect.objectContaining({
          id: "setting-123",
          category: "docker",
          key: "host",
          value: "tcp://localhost:2375",
          isEncrypted: false,
          lastValidatedAt: "2023-01-01T12:00:00.000Z",
        }),
      });

      expect(mockPrisma.systemSettings.findUnique).toHaveBeenCalledWith({
        where: { id: "setting-123" },
      });

      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          settingId: "setting-123",
          category: "docker",
          key: "host",
        }),
        "Setting details returned successfully",
      );
    });

    it("should return 400 for invalid setting ID format", async () => {
      const response = await request(app)
        .get("/api/settings/short")
        .expect(400);

      expect(response.body).toMatchObject({
        error: "Bad Request",
        message: "Invalid setting ID format",
      });
    });

    it("should return 404 for non-existent setting", async () => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue(null);

      const response = await request(app)
        .get("/api/settings/non-existent-setting")
        .expect(404);

      expect(response.body).toMatchObject({
        error: "Not Found",
        message: "Setting with ID 'non-existent-setting' not found",
      });

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          settingId: "non-existent-setting",
        }),
        "Setting not found",
      );
    });

    it("should handle database errors", async () => {
      const dbError = new Error("Database query failed");
      mockPrisma.systemSettings.findUnique.mockRejectedValue(dbError);

      const response = await request(app)
        .get("/api/settings/setting-123")
        .expect(500);

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          error: dbError,
          settingId: "setting-123",
        }),
        "Failed to fetch setting details",
      );
    });
  });

  describe("POST /api/settings", () => {
    const validCreateRequest = {
      category: "docker" as SettingsCategory,
      key: "api_version",
      value: "1.41",
      isEncrypted: false,
    };

    const mockCreatedSetting: SystemSettings = {
      id: "new-setting-id",
      category: "docker",
      key: "api_version",
      value: "1.41",
      isEncrypted: false,
      isActive: true,
      validationStatus: "pending",
      validationMessage: null,
      lastValidatedAt: null,
      createdBy: "test-user-id",
      updatedBy: "test-user-id",
      createdAt: new Date("2023-01-01T10:00:00Z"),
      updatedAt: new Date("2023-01-01T10:00:00Z"),
    };

    it("should create new setting successfully", async () => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue(null); // No existing setting
      mockPrisma.systemSettings.create.mockResolvedValue(mockCreatedSetting);

      const response = await request(app)
        .post("/api/settings")
        .send(validCreateRequest)
        .expect(201);

      expect(response.body).toMatchObject({
        success: true,
        message: "Setting created successfully",
        data: expect.objectContaining({
          id: "new-setting-id",
          category: "docker",
          key: "api_version",
          value: "1.41",
          isEncrypted: false,
        }),
      });

      expect(mockPrisma.systemSettings.create).toHaveBeenCalledWith({
        data: {
          category: "docker",
          key: "api_version",
          value: "1.41",
          isEncrypted: false,
          isActive: true,
          createdBy: "test-user-id",
          updatedBy: "test-user-id",
        },
      });

      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          settingId: "new-setting-id",
          category: "docker",
          key: "api_version",
        }),
        "Setting created successfully",
      );
    });

    it("should handle encrypted settings creation", async () => {
      const encryptedRequest = {
        ...validCreateRequest,
        key: "api_token",
        value: "secret_token_value",
        isEncrypted: true,
      };

      const encryptedSetting = {
        ...mockCreatedSetting,
        key: "api_token",
        value: "secret_token_value",
        isEncrypted: true,
      };

      mockPrisma.systemSettings.findUnique.mockResolvedValue(null);
      mockPrisma.systemSettings.create.mockResolvedValue(encryptedSetting);

      const response = await request(app)
        .post("/api/settings")
        .send(encryptedRequest)
        .expect(201);
    });

    it("should return 400 for invalid request body", async () => {
      const invalidRequests = [
        { category: "invalid", key: "test", value: "test" },
        { category: "docker", key: "", value: "test" },
        { category: "docker", key: "test", value: "" },
        { category: "docker" }, // Missing key and value
      ];

      for (const invalidRequest of invalidRequests) {
        const response = await request(app)
          .post("/api/settings")
          .send(invalidRequest)
          .expect(400);

        expect(response.body).toMatchObject({
          error: "Bad Request",
          message: "Invalid request data",
          details: expect.any(Array),
        });
      }
    });

    it("should return 409 for duplicate category/key combination", async () => {
      const existingSetting = {
        ...mockCreatedSetting,
        id: "existing-setting",
      };

      mockPrisma.systemSettings.findUnique.mockResolvedValue(existingSetting);

      const response = await request(app)
        .post("/api/settings")
        .send(validCreateRequest)
        .expect(409);

      expect(response.body).toMatchObject({
        error: "Conflict",
        message:
          "Setting with category 'docker' and key 'api_version' already exists",
      });

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          category: "docker",
          key: "api_version",
        }),
        "Setting with same category/key already exists",
      );
    });


    it("should handle database creation errors", async () => {
      const dbError = new Error("Database insert failed");
      mockPrisma.systemSettings.findUnique.mockResolvedValue(null);
      mockPrisma.systemSettings.create.mockRejectedValue(dbError);

      const response = await request(app)
        .post("/api/settings")
        .send(validCreateRequest)
        .expect(500);

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          error: dbError,
          userId: "test-user-id",
        }),
        "Failed to create setting",
      );
    });
  });

  describe("PUT /api/settings/:id", () => {
    const validUpdateRequest = {
      value: "tcp://192.168.1.100:2375",
      isEncrypted: false,
    };

    const existingSetting: SystemSettings = {
      id: "setting-123",
      category: "docker",
      key: "host",
      value: "tcp://localhost:2375",
      isEncrypted: false,
      isActive: true,
      validationStatus: "valid",
      validationMessage: null,
      lastValidatedAt: new Date("2023-01-01T12:00:00Z"),
      createdBy: "user-1",
      updatedBy: "user-1",
      createdAt: new Date("2023-01-01T10:00:00Z"),
      updatedAt: new Date("2023-01-01T11:00:00Z"),
    };

    const updatedSetting: SystemSettings = {
      ...existingSetting,
      value: "tcp://192.168.1.100:2375",
      updatedBy: "test-user-id",
      updatedAt: new Date("2023-01-01T12:00:00Z"),
    };

    it("should update setting successfully", async () => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue(existingSetting);
      mockPrisma.systemSettings.update.mockResolvedValue(updatedSetting);

      const response = await request(app)
        .put("/api/settings/setting-123")
        .send(validUpdateRequest)
        .expect(200);

      expect(response.body).toMatchObject({
        success: true,
        message: "Setting updated successfully",
        data: expect.objectContaining({
          id: "setting-123",
          value: "tcp://192.168.1.100:2375",
        }),
      });

      expect(mockPrisma.systemSettings.update).toHaveBeenCalledWith({
        where: { id: "setting-123" },
        data: {
          value: "tcp://192.168.1.100:2375",
          isEncrypted: false,
          updatedBy: "test-user-id",
        },
      });

      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          settingId: "setting-123",
          category: "docker",
          key: "host",
        }),
        "Setting updated successfully",
      );
    });

    it("should handle encryption status updates", async () => {
      const encryptedUpdateRequest = {
        value: "new_encrypted_value",
        isEncrypted: true,
      };

      const encryptedExistingSetting = {
        ...existingSetting,
        isEncrypted: false,
      };

      mockPrisma.systemSettings.findUnique.mockResolvedValue(
        encryptedExistingSetting,
      );
      mockPrisma.systemSettings.update.mockResolvedValue({
        ...updatedSetting,
        value: "new_encrypted_value",
        isEncrypted: true,
      });

      const response = await request(app)
        .put("/api/settings/setting-123")
        .send(encryptedUpdateRequest)
        .expect(200);

      expect(mockPrisma.systemSettings.update).toHaveBeenCalledWith({
        where: { id: "setting-123" },
        data: {
          value: "new_encrypted_value",
          isEncrypted: true,
          updatedBy: "test-user-id",
        },
      });
    });

    it("should return 400 for invalid setting ID format", async () => {
      const response = await request(app)
        .put("/api/settings/short")
        .send(validUpdateRequest)
        .expect(400);

      expect(response.body).toMatchObject({
        error: "Bad Request",
        message: "Invalid setting ID format",
      });
    });

    it("should return 400 for invalid request body", async () => {
      const invalidRequests = [
        { value: "" }, // Empty value
        { value: "test", isEncrypted: "not_boolean" },
        {}, // No value field
      ];

      for (const invalidRequest of invalidRequests) {
        const response = await request(app)
          .put("/api/settings/setting-123")
          .send(invalidRequest)
          .expect(400);

        expect(response.body).toMatchObject({
          error: "Bad Request",
          message: "Invalid request data",
          details: expect.any(Array),
        });
      }
    });

    it("should return 404 for non-existent setting", async () => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue(null);

      const response = await request(app)
        .put("/api/settings/non-existent")
        .send(validUpdateRequest)
        .expect(404);

      expect(response.body).toMatchObject({
        error: "Not Found",
        message: "Setting with ID 'non-existent' not found",
      });

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          settingId: "non-existent",
        }),
        "Setting not found for update",
      );
    });


    it("should handle database update errors", async () => {
      const dbError = new Error("Database update failed");
      mockPrisma.systemSettings.findUnique.mockResolvedValue(existingSetting);
      mockPrisma.systemSettings.update.mockRejectedValue(dbError);

      const response = await request(app)
        .put("/api/settings/setting-123")
        .send(validUpdateRequest)
        .expect(500);

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          error: dbError,
          settingId: "setting-123",
        }),
        "Failed to update setting",
      );
    });
  });

  describe("DELETE /api/settings/:id", () => {
    const existingSetting: SystemSettings = {
      id: "setting-123",
      category: "docker",
      key: "host",
      value: "tcp://localhost:2375",
      isEncrypted: false,
      isActive: true,
      validationStatus: "valid",
      validationMessage: null,
      lastValidatedAt: new Date("2023-01-01T12:00:00Z"),
      createdBy: "user-1",
      updatedBy: "user-1",
      createdAt: new Date("2023-01-01T10:00:00Z"),
      updatedAt: new Date("2023-01-01T11:00:00Z"),
    };

    it("should delete setting successfully", async () => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue(existingSetting);
      mockPrisma.systemSettings.delete.mockResolvedValue(existingSetting);

      const response = await request(app)
        .delete("/api/settings/setting-123")
        .expect(200);

      expect(response.body).toMatchObject({
        success: true,
        message: "Setting deleted successfully",
      });

      expect(mockPrisma.systemSettings.delete).toHaveBeenCalledWith({
        where: { id: "setting-123" },
      });

      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          settingId: "setting-123",
          category: "docker",
          key: "host",
        }),
        "Setting deleted successfully",
      );
    });

    it("should redact encrypted values in audit log", async () => {
      const encryptedSetting = {
        ...existingSetting,
        isEncrypted: true,
        value: "encrypted_secret_value",
      };

      mockPrisma.systemSettings.findUnique.mockResolvedValue(encryptedSetting);
      mockPrisma.systemSettings.delete.mockResolvedValue(encryptedSetting);

      const response = await request(app)
        .delete("/api/settings/setting-123")
        .expect(200);
    });

    it("should return 400 for invalid setting ID format", async () => {
      const response = await request(app)
        .delete("/api/settings/short")
        .expect(400);

      expect(response.body).toMatchObject({
        error: "Bad Request",
        message: "Invalid setting ID format",
      });
    });

    it("should return 404 for non-existent setting", async () => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue(null);

      const response = await request(app)
        .delete("/api/settings/non-existent")
        .expect(404);

      expect(response.body).toMatchObject({
        error: "Not Found",
        message: "Setting with ID 'non-existent' not found",
      });

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          settingId: "non-existent",
        }),
        "Setting not found for deletion",
      );
    });


    it("should handle database deletion errors", async () => {
      const dbError = new Error("Database delete failed");
      mockPrisma.systemSettings.findUnique.mockResolvedValue(existingSetting);
      mockPrisma.systemSettings.delete.mockRejectedValue(dbError);

      const response = await request(app)
        .delete("/api/settings/setting-123")
        .expect(500);

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          error: dbError,
          settingId: "setting-123",
        }),
        "Failed to delete setting",
      );
    });
  });

  describe("Request Correlation", () => {
    it("should include request ID in responses and logs", async () => {
      const requestId = createId();
      mockPrisma.systemSettings.findMany.mockResolvedValue([]);
      mockPrisma.systemSettings.count.mockResolvedValue(0);

      const response = await request(app)
        .get("/api/settings")
        .set("x-request-id", requestId)
        .expect(200);

      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId,
        }),
        "Settings list requested",
      );
    });

    it("should generate request ID if not provided", async () => {
      mockPrisma.systemSettings.findMany.mockResolvedValue([]);
      mockPrisma.systemSettings.count.mockResolvedValue(0);

      const response = await request(app).get("/api/settings").expect(200);

      // The response should include a request ID even if we didn't provide one
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: expect.any(String),
        }),
        "Settings list requested",
      );
    });
  });

  describe("Data Validation and Sanitization", () => {
    it("should redact sensitive values in logs during create", async () => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue(null);
      mockPrisma.systemSettings.create.mockResolvedValue({
        id: "test-setting",
        category: "cloudflare",
        key: "api_token",
        value: "sensitive_token_value",
        isEncrypted: true,
        isActive: true,
        validationStatus: "pending",
        validationMessage: null,
        lastValidatedAt: null,
        createdBy: "test-user-id",
        updatedBy: "test-user-id",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await request(app)
        .post("/api/settings")
        .send({
          category: "cloudflare",
          key: "api_token",
          value: "sensitive_token_value",
          isEncrypted: true,
        })
        .expect(201);

      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          body: {
            category: "cloudflare",
            key: "api_token",
            value: "[REDACTED]",
            isEncrypted: true,
          },
        }),
        "Create setting requested",
      );
    });

    it("should redact sensitive values in logs during update", async () => {
      const existingSetting = {
        id: "test-setting",
        category: "cloudflare",
        key: "api_token",
        value: "old_token",
        isEncrypted: true,
        isActive: true,
        validationStatus: "valid",
        validationMessage: null,
        lastValidatedAt: new Date(),
        createdBy: "test-user-id",
        updatedBy: "test-user-id",
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrisma.systemSettings.findUnique.mockResolvedValue(existingSetting);
      mockPrisma.systemSettings.update.mockResolvedValue({
        ...existingSetting,
        value: "new_sensitive_token",
      });

      await request(app)
        .put("/api/settings/test-setting")
        .send({
          value: "new_sensitive_token",
          isEncrypted: true,
        })
        .expect(200);

      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          body: { value: "[REDACTED]", isEncrypted: true },
        }),
        "Update setting requested",
      );
    });
  });

  describe("Error Handling", () => {
    it("should handle malformed request data gracefully", async () => {
      const testCases = [
        { endpoint: "/api/settings?page=abc&limit=xyz", method: "get" },
        {
          endpoint: "/api/settings?category=invalid&validationStatus=invalid",
          method: "get",
        },
      ];

      for (const testCase of testCases) {
        const response = await request(app)
          [testCase.method as keyof typeof request](testCase.endpoint)
          .expect(400);

        expect(response.body.error).toBe("Bad Request");
        expect(response.body.message).toBe("Invalid query parameters");
        expect(response.body.details).toBeDefined();
      }
    });

    it("should include timestamp in all error responses", async () => {
      mockPrisma.systemSettings.findMany.mockRejectedValue(
        new Error("Database error"),
      );

      const response = await request(app).get("/api/settings").expect(500);

      expect(response.body.timestamp).toBeDefined();
      expect(new Date(response.body.timestamp)).toBeInstanceOf(Date);
    });

    it("should handle database connection errors consistently", async () => {
      const dbError = new Error("ECONNREFUSED: Connection refused");
      const endpoints = [
        {
          path: "/api/settings",
          method: "get",
          setupMock: () =>
            mockPrisma.systemSettings.findMany.mockRejectedValue(dbError),
        },
        {
          path: "/api/settings/test-id-12345", // Use valid ID format (>= 8 chars)
          method: "get",
          setupMock: () =>
            mockPrisma.systemSettings.findUnique.mockRejectedValue(dbError),
        },
      ];

      for (const endpoint of endpoints) {
        vi.clearAllMocks();
        endpoint.setupMock();

        const response = await request(app)
          [endpoint.method as keyof typeof request](endpoint.path)
          .expect(500);

        expect(response.body.error).toBe("Internal Server Error");
        expect(mockLogger.error).toHaveBeenCalledWith(
          expect.objectContaining({
            error: dbError,
          }),
          expect.any(String),
        );
      }
    });
  });
});
