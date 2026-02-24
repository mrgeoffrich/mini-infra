import { jest } from "@jest/globals";
import request from "supertest";
import express from "express";
import { createId } from "@paralleldrive/cuid2";
import {
  AzureSettingResponse,
  AzureValidationResponse,
  AzureContainerListResponse,
  AzureContainerAccessResponse,
  ValidationResult,
} from "@mini-infra/types";

// Mock Prisma client
const mockPrisma = {
  systemSettings: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
  connectivityStatus: {
    create: jest.fn(),
    findFirst: jest.fn(),
  },
};

jest.mock("../../lib/prisma", () => mockPrisma);

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

// Mock auth middleware - need to mock the api-key-middleware functions that are re-exported through middleware/auth
const mockRequireSessionOrApiKey = jest.fn((req: any, res: any, next: any) => {
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
});

jest.mock("../../lib/api-key-middleware", () => ({
  requireSessionOrApiKey: mockRequireSessionOrApiKey,
  getCurrentUserId: (req: any) => "test-user-id",
  getCurrentUser: (req: any) => ({ id: "test-user-id", email: "test@example.com" })
}));

const mockGetAuthenticatedUser = jest.fn(() => ({
  id: "test-user-id",
  email: "test@example.com",
}));

// Mock auth middleware functions
jest.mock("../../lib/auth-middleware", () => ({
  getAuthenticatedUser: mockGetAuthenticatedUser,
}));

// Note: mockLogger is already defined above at line 31-36

// Mock AzureStorageService
const mockAzureStorageService = {
  getConnectionString: jest.fn(),
  getStorageAccountName: jest.fn(),
  getHealthStatus: jest.fn(),
  setConnectionString: jest.fn(),
  set: jest.fn(),
  removeConfiguration: jest.fn(),
  validate: jest.fn(),
  getContainerInfo: jest.fn(),
  testContainerAccess: jest.fn(),
};

jest.mock("../../services/azure-storage-service", () => ({
  AzureStorageService: jest
    .fn()
    .mockImplementation(() => mockAzureStorageService),
}));

import azureSettingsRouter from "../azure-settings";

describe("Azure Settings API Routes", () => {
  let app: express.Application;
  const testRequestId = createId();

  beforeAll(() => {
    app = express();
    app.use(express.json());

    // Add request ID middleware for testing
    app.use((req: any, res: any, next: any) => {
      req.headers["x-request-id"] = testRequestId;
      req.get = jest.fn((header: string) => {
        if (header === "User-Agent") return "Test Agent";
        return undefined;
      });
      next();
    });

    app.use("/api/settings/azure", azureSettingsRouter);

    // Add error handler for testing
    app.use((err: any, req: any, res: any, next: any) => {
      res.status(500).json({
        error: "Internal Server Error",
        message: err.message || "Unknown error occurred",
        timestamp: new Date().toISOString(),
        requestId: req.headers["x-request-id"],
      });
    });
  });

  beforeEach(() => {
    jest.clearAllMocks();

    // Reset auth mocks to successful state
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

    mockGetAuthenticatedUser.mockReturnValue({
      id: "test-user-id",
      email: "test@example.com",
    });
  });

  // ===== AUTHENTICATION TESTS =====
  describe("Authentication Requirements", () => {
    beforeEach(() => {
      // Mock auth failure
      mockRequireSessionOrApiKey.mockImplementation((req: any, res: any, next: any) => {
        res.status(401).json({ error: "Unauthorized" });
      });
      mockGetAuthenticatedUser.mockReturnValue(null);
    });

    test("GET /api/settings/azure requires authentication", async () => {
      const response = await request(app).get("/api/settings/azure");

      expect(response.status).toBe(401);
      expect(response.body).toMatchObject({
        error: "Unauthorized",
      });
    });

    test("PUT /api/settings/azure requires authentication", async () => {
      const response = await request(app)
        .put("/api/settings/azure")
        .send({ connectionString: "test-connection-string" });

      expect(response.status).toBe(401);
      expect(response.body).toMatchObject({
        error: "Unauthorized",
      });
    });

    test("POST /api/settings/azure/validate requires authentication", async () => {
      const response = await request(app)
        .post("/api/settings/azure/validate")
        .send({});

      expect(response.status).toBe(401);
      expect(response.body).toMatchObject({
        error: "Unauthorized",
      });
    });

    test("DELETE /api/settings/azure requires authentication", async () => {
      const response = await request(app).delete("/api/settings/azure");

      expect(response.status).toBe(401);
      expect(response.body).toMatchObject({
        error: "Unauthorized",
      });
    });

    test("GET /api/settings/azure/containers requires authentication", async () => {
      const response = await request(app).get("/api/settings/azure/containers");

      expect(response.status).toBe(401);
      expect(response.body).toMatchObject({
        error: "Unauthorized",
      });
    });

    test("POST /api/settings/azure/test-container requires authentication", async () => {
      const response = await request(app)
        .post("/api/settings/azure/test-container")
        .send({ containerName: "test-container" });

      expect(response.status).toBe(401);
      expect(response.body).toMatchObject({
        error: "Unauthorized",
      });
    });
  });

  // ===== GET AZURE SETTINGS TESTS =====
  describe("GET /api/settings/azure", () => {
    beforeEach(() => {
      // Reset to authenticated state
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

      mockGetAuthenticatedUser.mockReturnValue({
        id: "test-user-id",
        email: "test@example.com",
      });
    });

    test("returns Azure configuration when settings exist", async () => {
      const mockConnectionString =
        "DefaultEndpointsProtocol=https;AccountName=testaccount;AccountKey=testkey;EndpointSuffix=core.windows.net";
      const mockAccountName = "testaccount";
      const mockHealthStatus = {
        status: "connected",
        lastChecked: new Date("2024-01-01T12:00:00Z"),
        errorMessage: null,
      };
      const mockSystemSetting = {
        id: "test-setting-id",
        category: "azure",
        key: "connection_string",
        createdAt: new Date("2024-01-01T10:00:00Z"),
        updatedAt: new Date("2024-01-01T11:00:00Z"),
        createdBy: "test-user-id",
        updatedBy: "test-user-id",
      };

      mockAzureStorageService.getConnectionString.mockResolvedValue(
        mockConnectionString,
      );
      mockAzureStorageService.getStorageAccountName.mockResolvedValue(
        mockAccountName,
      );
      mockAzureStorageService.getHealthStatus.mockResolvedValue(
        mockHealthStatus,
      );
      mockPrisma.systemSettings.findMany.mockResolvedValue([mockSystemSetting]);

      const response = await request(app).get("/api/settings/azure");

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject<Partial<AzureSettingResponse>>({
        success: true,
        data: {
          id: "test-setting-id",
          accountName: mockAccountName,
          connectionConfigured: true,
          lastValidatedAt: "2024-01-01T12:00:00.000Z",
          validationStatus: "connected",
          validationMessage: null,
          createdAt: "2024-01-01T10:00:00.000Z",
          updatedAt: "2024-01-01T11:00:00.000Z",
          createdBy: "test-user-id",
          updatedBy: "test-user-id",
        },
        message: "Azure Storage configuration found (testaccount)",
        requestId: testRequestId,
      });

      expect(mockAzureStorageService.getConnectionString).toHaveBeenCalled();
      expect(mockAzureStorageService.getStorageAccountName).toHaveBeenCalled();
      expect(mockAzureStorageService.getHealthStatus).toHaveBeenCalled();
    });

    test("returns no configuration message when no settings exist", async () => {
      mockAzureStorageService.getConnectionString.mockResolvedValue(null);
      mockAzureStorageService.getStorageAccountName.mockResolvedValue(null);
      mockAzureStorageService.getHealthStatus.mockResolvedValue({
        status: "disconnected",
        lastChecked: null,
        errorMessage: "No configuration found",
      });
      mockPrisma.systemSettings.findMany.mockResolvedValue([]);

      const response = await request(app).get("/api/settings/azure");

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        success: true,
        data: {
          id: "no-config",
          accountName: null,
          connectionConfigured: false,
          validationStatus: "disconnected",
        },
        message: "No Azure Storage configuration found",
      });
    });

    test("handles service errors gracefully", async () => {
      mockAzureStorageService.getConnectionString.mockRejectedValue(
        new Error("Database connection failed"),
      );

      const response = await request(app).get("/api/settings/azure");

      expect(response.status).toBe(500);
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  // ===== PUT AZURE SETTINGS TESTS =====
  describe("PUT /api/settings/azure", () => {
    const validConnectionString =
      "DefaultEndpointsProtocol=https;AccountName=testaccount;AccountKey=testkey;EndpointSuffix=core.windows.net";

    test("updates Azure configuration with valid connection string", async () => {
      const mockSystemSetting = {
        id: "updated-setting-id",
        createdAt: new Date("2024-01-01T10:00:00Z"),
        updatedAt: new Date("2024-01-01T12:00:00Z"),
        createdBy: "original-user-id",
        updatedBy: "test-user-id",
      };

      mockAzureStorageService.setConnectionString.mockResolvedValue(undefined);
      mockAzureStorageService.set.mockResolvedValue(undefined);
      mockAzureStorageService.getConnectionString.mockResolvedValue(
        validConnectionString,
      );
      mockAzureStorageService.getStorageAccountName.mockResolvedValue(
        "testaccount",
      );
      mockPrisma.systemSettings.findFirst.mockResolvedValue(mockSystemSetting);

      const response = await request(app).put("/api/settings/azure").send({
        connectionString: validConnectionString,
        accountName: "testaccount",
      });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject<Partial<AzureSettingResponse>>({
        success: true,
        data: {
          id: "updated-setting-id",
          accountName: "testaccount",
          connectionConfigured: true,
          validationStatus: "pending",
          validationMessage: "Configuration updated, validation pending",
          updatedBy: "test-user-id",
        },
        message: "Azure Storage configuration updated successfully",
      });

      expect(mockAzureStorageService.setConnectionString).toHaveBeenCalledWith(
        validConnectionString,
        "test-user-id",
      );
      expect(mockAzureStorageService.set).toHaveBeenCalledWith(
        "storage_account_name",
        "testaccount",
        "test-user-id",
      );
    });

    test("validates connection string format", async () => {
      const invalidConnectionString = "invalid-connection-string";

      const response = await request(app).put("/api/settings/azure").send({
        connectionString: invalidConnectionString,
      });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        error: "Bad Request",
        message: "Invalid request data",
        details: expect.arrayContaining([
          expect.objectContaining({
            message:
              "Invalid connection string format. Must include DefaultEndpointsProtocol, AccountName, and AccountKey",
          }),
        ]),
      });
    });

    test("handles missing user authentication", async () => {
      mockGetAuthenticatedUser.mockReturnValue(null);

      const response = await request(app).put("/api/settings/azure").send({
        connectionString: validConnectionString,
      });

      expect(response.status).toBe(401);
      expect(response.body).toMatchObject({
        error: "Unauthorized",
        message: "User authentication required",
      });
    });

    test("handles service errors during update", async () => {
      mockAzureStorageService.setConnectionString.mockRejectedValue(
        new Error("Failed to encrypt connection string"),
      );

      const response = await request(app).put("/api/settings/azure").send({
        connectionString: validConnectionString,
      });

      expect(response.status).toBe(500);
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  // ===== VALIDATION ENDPOINT TESTS =====
  describe("POST /api/settings/azure/validate", () => {
    const validConnectionString =
      "DefaultEndpointsProtocol=https;AccountName=testaccount;AccountKey=testkey;EndpointSuffix=core.windows.net";

    test("validates Azure connection with temporary connection string", async () => {
      const mockValidationResult: ValidationResult = {
        isValid: true,
        message: "Connection successful",
        responseTimeMs: 1500,
        metadata: {
          accountName: "testaccount",
          accountKind: "StorageV2",
          skuName: "Standard_LRS",
          containerCount: 3,
          containers: ["container1", "container2", "container3"],
        },
      };

      // Mock temporary service creation and cleanup
      mockAzureStorageService.setConnectionString.mockResolvedValue(undefined);
      mockAzureStorageService.validate.mockResolvedValue(mockValidationResult);
      mockAzureStorageService.removeConfiguration.mockResolvedValue(undefined);

      const response = await request(app)
        .post("/api/settings/azure/validate")
        .send({
          connectionString: validConnectionString,
          testContainerAccess: true,
        });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject<Partial<AzureValidationResponse>>({
        success: true,
        data: {
          service: "azure",
          isValid: true,
          responseTimeMs: 1500,
          accountInfo: {
            accountName: "testaccount",
            accountKind: "StorageV2",
            skuName: "Standard_LRS",
            skuTier: "Standard",
            primaryLocation: "Unknown",
          },
          containerCount: 3,
          sampleContainers: expect.arrayContaining([
            expect.objectContaining({
              name: "container1",
              leaseStatus: "unlocked",
              leaseState: "available",
            }),
          ]),
        },
        message: "Connection successful",
      });

      expect(mockAzureStorageService.setConnectionString).toHaveBeenCalledWith(
        validConnectionString,
        "test-user-id",
      );
      expect(mockAzureStorageService.validate).toHaveBeenCalled();
      expect(mockAzureStorageService.removeConfiguration).toHaveBeenCalledWith(
        "test-user-id",
      );
    });

    test("validates existing Azure configuration", async () => {
      const mockValidationResult: ValidationResult = {
        isValid: true,
        message: "Connection successful",
        responseTimeMs: 800,
        metadata: {
          accountName: "existingaccount",
          containerCount: 1,
        },
      };

      mockAzureStorageService.validate.mockResolvedValue(mockValidationResult);

      const response = await request(app)
        .post("/api/settings/azure/validate")
        .send({});

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        success: true,
        data: {
          service: "azure",
          isValid: true,
          responseTimeMs: 800,
          accountInfo: {
            accountName: "existingaccount",
            accountKind: "StorageV2",
          },
          containerCount: 1,
        },
      });

      expect(mockAzureStorageService.validate).toHaveBeenCalled();
      expect(mockAzureStorageService.setConnectionString).not.toHaveBeenCalled();
      expect(mockAzureStorageService.removeConfiguration).not.toHaveBeenCalled();
    });

    test("handles validation failure scenarios", async () => {
      const mockValidationResult: ValidationResult = {
        isValid: false,
        message: "Invalid connection string",
        errorCode: "AUTHENTICATION_FAILED",
        responseTimeMs: 5000,
      };

      mockAzureStorageService.validate.mockResolvedValue(mockValidationResult);

      const response = await request(app)
        .post("/api/settings/azure/validate")
        .send({});

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        success: true,
        data: {
          service: "azure",
          isValid: false,
          responseTimeMs: 5000,
          error: "Invalid connection string",
          errorCode: "AUTHENTICATION_FAILED",
        },
        message: "Invalid connection string",
      });
    });

    test("handles network timeout scenarios", async () => {
      const mockValidationResult: ValidationResult = {
        isValid: false,
        message: "Connection timeout",
        errorCode: "TIMEOUT",
        responseTimeMs: 15000,
      };

      mockAzureStorageService.setConnectionString.mockResolvedValue(undefined);
      mockAzureStorageService.validate.mockResolvedValue(mockValidationResult);
      mockAzureStorageService.removeConfiguration.mockResolvedValue(undefined);

      const response = await request(app)
        .post("/api/settings/azure/validate")
        .send({
          connectionString: validConnectionString,
        });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        success: true,
        data: {
          isValid: false,
          error: "Connection timeout",
          errorCode: "TIMEOUT",
          responseTimeMs: 15000,
        },
      });
    });

    test("validates request body format", async () => {
      const response = await request(app)
        .post("/api/settings/azure/validate")
        .send({
          invalidField: "invalid-value",
        });

      expect(response.status).toBe(200); // Validation schema allows empty body
      expect(mockAzureStorageService.validate).toHaveBeenCalled();
    });
  });

  // ===== DELETE AZURE SETTINGS TESTS =====
  describe("DELETE /api/settings/azure", () => {
    test("removes Azure configuration successfully", async () => {
      const mockAccountName = "testaccount";

      mockAzureStorageService.getStorageAccountName.mockResolvedValue(
        mockAccountName,
      );
      mockAzureStorageService.removeConfiguration.mockResolvedValue(undefined);

      const response = await request(app).delete("/api/settings/azure");

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        success: true,
        message:
          "Azure Storage configuration removed successfully (testaccount)",
      });

      expect(mockAzureStorageService.getStorageAccountName).toHaveBeenCalled();
      expect(mockAzureStorageService.removeConfiguration).toHaveBeenCalledWith(
        "test-user-id",
      );
    });

    test("handles removal when no account name exists", async () => {
      mockAzureStorageService.getStorageAccountName.mockResolvedValue(null);
      mockAzureStorageService.removeConfiguration.mockResolvedValue(undefined);

      const response = await request(app).delete("/api/settings/azure");

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        success: true,
        message: "Azure Storage configuration removed successfully",
      });
    });

    test("handles service errors during deletion", async () => {
      mockAzureStorageService.getStorageAccountName.mockRejectedValue(
        new Error("Database error"),
      );

      const response = await request(app).delete("/api/settings/azure");

      expect(response.status).toBe(500);
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  // ===== CONTAINER LIST TESTS =====
  describe("GET /api/settings/azure/containers", () => {
    test("returns list of Azure Storage containers", async () => {
      const mockAccountName = "testaccount";
      const mockContainers = [
        {
          name: "container1",
          lastModified: new Date("2024-01-01T12:00:00Z"),
          leaseStatus: "unlocked",
          leaseState: "available",
          hasImmutabilityPolicy: false,
          hasLegalHold: false,
          metadata: { purpose: "backups" },
        },
        {
          name: "container2",
          lastModified: new Date("2024-01-02T12:00:00Z"),
          leaseStatus: "locked",
          leaseState: "leased",
          hasImmutabilityPolicy: true,
          hasLegalHold: false,
        },
      ];

      mockAzureStorageService.getStorageAccountName.mockResolvedValue(
        mockAccountName,
      );
      mockAzureStorageService.getContainerInfo.mockResolvedValue(mockContainers);

      const response = await request(app).get("/api/settings/azure/containers");

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject<Partial<AzureContainerListResponse>>({
        success: true,
        data: {
          accountName: mockAccountName,
          containerCount: 2,
          containers: [
            {
              name: "container1",
              lastModified: "2024-01-01T12:00:00.000Z",
              leaseStatus: "unlocked",
              leaseState: "available",
              hasImmutabilityPolicy: false,
              hasLegalHold: false,
              metadata: { purpose: "backups" },
            },
            {
              name: "container2",
              lastModified: "2024-01-02T12:00:00.000Z",
              leaseStatus: "locked",
              leaseState: "leased",
              hasImmutabilityPolicy: true,
              hasLegalHold: false,
            },
          ],
          hasMore: false,
        },
        message: "Found 2 containers",
      });

      expect(mockAzureStorageService.getStorageAccountName).toHaveBeenCalled();
      expect(mockAzureStorageService.getContainerInfo).toHaveBeenCalled();
    });

    test("handles no containers found", async () => {
      mockAzureStorageService.getStorageAccountName.mockResolvedValue(
        "emptyaccount",
      );
      mockAzureStorageService.getContainerInfo.mockResolvedValue([]);

      const response = await request(app).get("/api/settings/azure/containers");

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        success: true,
        data: {
          accountName: "emptyaccount",
          containerCount: 0,
          containers: [],
          hasMore: false,
        },
        message: "Found 0 containers",
      });
    });
  });

  // ===== CONTAINER ACCESS TEST TESTS =====
  describe("POST /api/settings/azure/test-container", () => {
    test("tests container access successfully", async () => {
      const containerName = "test-container";
      const mockContainerInfo = {
        name: containerName,
        lastModified: new Date("2024-01-01T12:00:00Z"),
        leaseStatus: "unlocked",
      };

      mockAzureStorageService.testContainerAccess.mockResolvedValue({
        accessible: true,
        responseTimeMs: 150,
        error: undefined,
        errorCode: undefined,
      });
      mockAzureStorageService.getContainerInfo.mockResolvedValue([
        mockContainerInfo,
      ]);

      const response = await request(app)
        .post("/api/settings/azure/test-container")
        .send({ containerName });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject<
        Partial<AzureContainerAccessResponse>
      >({
        success: true,
        data: {
          containerName,
          accessible: true,
          responseTimeMs: expect.any(Number),
          lastModified: "2024-01-01T12:00:00.000Z",
          leaseStatus: "unlocked",
        },
        message: `Container '${containerName}' is accessible`,
      });

      expect(mockAzureStorageService.testContainerAccess).toHaveBeenCalledWith(
        containerName,
      );
    });

    test("handles container access denied", async () => {
      const containerName = "inaccessible-container";

      mockAzureStorageService.testContainerAccess.mockResolvedValue({
        accessible: false,
        responseTimeMs: 100,
        error: "Container access denied or container does not exist",
        errorCode: "ACCESS_DENIED",
      });

      const response = await request(app)
        .post("/api/settings/azure/test-container")
        .send({ containerName });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        success: true,
        data: {
          containerName,
          accessible: false,
          error: "Container access denied or container does not exist",
          errorCode: "ACCESS_DENIED",
        },
        message: `Container '${containerName}' is not accessible: Container access denied or container does not exist`,
      });
    });

    test("validates container name requirement", async () => {
      const response = await request(app)
        .post("/api/settings/azure/test-container")
        .send({});

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        error: "Bad Request",
        message: "Invalid request data",
        details: expect.arrayContaining([
          expect.objectContaining({
            message: "Invalid input: expected string, received undefined",
            path: ["containerName"],
          }),
        ]),
      });
    });
  });

  // ===== CONCURRENT ACCESS TESTS =====
  describe("Concurrent Access Behavior", () => {
    test("handles multiple simultaneous validation requests", async () => {
      const mockValidationResult: ValidationResult = {
        isValid: true,
        message: "Connection successful",
        responseTimeMs: 1000,
      };

      mockAzureStorageService.validate.mockResolvedValue(mockValidationResult);

      // Simulate concurrent requests
      const requests = Array.from({ length: 5 }, () =>
        request(app).post("/api/settings/azure/validate").send({}),
      );

      const responses = await Promise.all(requests);

      responses.forEach((response) => {
        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
      });

      expect(mockAzureStorageService.validate).toHaveBeenCalledTimes(5);
    });

    test("handles simultaneous configuration updates", async () => {
      const validConnectionString =
        "DefaultEndpointsProtocol=https;AccountName=testaccount;AccountKey=testkey;EndpointSuffix=core.windows.net";

      mockAzureStorageService.setConnectionString.mockResolvedValue(undefined);
      mockAzureStorageService.getConnectionString.mockResolvedValue(
        validConnectionString,
      );
      mockAzureStorageService.getStorageAccountName.mockResolvedValue(
        "testaccount",
      );
      mockPrisma.systemSettings.findFirst.mockResolvedValue({
        id: "test-id",
        createdAt: new Date(),
        updatedAt: new Date(),
        createdBy: "test-user-id",
        updatedBy: "test-user-id",
      });

      // Simulate concurrent update requests
      const requests = Array.from({ length: 3 }, () =>
        request(app)
          .put("/api/settings/azure")
          .send({ connectionString: validConnectionString }),
      );

      const responses = await Promise.all(requests);

      responses.forEach((response) => {
        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
      });

      expect(mockAzureStorageService.setConnectionString).toHaveBeenCalledTimes(
        3,
      );
    });
  });

  // ===== ERROR SCENARIO TESTS =====
  describe("Error Scenario Handling", () => {
    test("handles Azure Storage service unavailable", async () => {
      const mockValidationResult: ValidationResult = {
        isValid: false,
        message: "Azure Storage service is unavailable",
        errorCode: "SERVICE_UNAVAILABLE",
        responseTimeMs: 30000,
      };

      mockAzureStorageService.validate.mockResolvedValue(mockValidationResult);

      const response = await request(app)
        .post("/api/settings/azure/validate")
        .send({});

      expect(response.status).toBe(200);
      expect(response.body.data.isValid).toBe(false);
      expect(response.body.data.errorCode).toBe("SERVICE_UNAVAILABLE");
      expect(response.body.data.responseTimeMs).toBe(30000);
    });

    test("handles invalid connection string authentication", async () => {
      const mockValidationResult: ValidationResult = {
        isValid: false,
        message: "Authentication failed. Check your connection string.",
        errorCode: "AUTHENTICATION_FAILED",
        responseTimeMs: 2000,
      };

      mockAzureStorageService.validate.mockResolvedValue(mockValidationResult);

      const response = await request(app)
        .post("/api/settings/azure/validate")
        .send({});

      expect(response.status).toBe(200);
      expect(response.body.data.errorCode).toBe("AUTHENTICATION_FAILED");
    });

    test("handles network connectivity failures", async () => {
      const mockValidationResult: ValidationResult = {
        isValid: false,
        message: "Network error: Unable to reach Azure endpoints",
        errorCode: "NETWORK_ERROR",
        responseTimeMs: 10000,
      };

      mockAzureStorageService.validate.mockResolvedValue(mockValidationResult);

      const response = await request(app)
        .post("/api/settings/azure/validate")
        .send({});

      expect(response.status).toBe(200);
      expect(response.body.data.errorCode).toBe("NETWORK_ERROR");
    });

    test("handles database connection failures", async () => {
      mockPrisma.systemSettings.findMany.mockRejectedValue(
        new Error("Database connection lost"),
      );

      const response = await request(app).get("/api/settings/azure");

      expect(response.status).toBe(500);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.any(Error),
          requestId: testRequestId,
          userId: "test-user-id",
        }),
        "Failed to fetch Azure settings",
      );
    });

    test("handles malformed request bodies", async () => {
      const response = await request(app).put("/api/settings/azure").send({
        connectionString: "", // Empty string should fail validation
      });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("Bad Request");
      expect(response.body.message).toBe("Invalid request data");
    });
  });
});
