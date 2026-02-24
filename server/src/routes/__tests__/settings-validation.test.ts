import { jest } from "@jest/globals";
import request from "supertest";
import express from "express";
import { createId } from "@paralleldrive/cuid2";
import {
  ValidationResult,
} from "@mini-infra/types";

// Mock Prisma client
const mockPrisma = {
  systemSettings: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    delete: jest.fn(),
    count: jest.fn(),
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
  requireAuth: (req: any, res: any, next: any) => {
    req.user = { id: "test-user-id", email: "test@example.com" };
    next();
  },
  getAuthenticatedUser: (req: any) => ({ id: "test-user-id", email: "test@example.com" }),
}));

// Mock configuration factory
const mockConfigService = {
  validate: jest.fn(),
  getHealthStatus: jest.fn(),
  set: jest.fn(),
  get: jest.fn(),
  delete: jest.fn(),
};

const mockConfigFactory = {
  create: jest.fn(),
  getSupportedCategories: jest.fn(),
  isSupported: jest.fn(),
};

jest.mock("../../services/configuration-factory", () => ({
  ConfigurationServiceFactory: jest
    .fn()
    .mockImplementation(() => mockConfigFactory),
}));

import settingsValidationRouter from "../settings-validation";

describe("Settings Validation API Routes", () => {
  let app: express.Application;

  beforeAll(() => {
    app = express();
    app.use(express.json());

    // Add request ID middleware for testing
    app.use((req: any, res: any, next: any) => {
      req.headers["x-request-id"] = req.headers["x-request-id"] || createId();
      req.get = jest.fn((header: string) => {
        if (header === "User-Agent") return "Test Agent";
        return undefined;
      });
      next();
    });

    app.use("/api/settings/validate", settingsValidationRouter);

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

    // Set up default mock returns
    mockConfigFactory.create.mockReturnValue(mockConfigService);
    mockConfigFactory.getSupportedCategories.mockReturnValue([
      "docker",
      "cloudflare",
      "azure",
      "postgres",
    ]);
    mockConfigFactory.isSupported.mockReturnValue(true);

    // Reset default mocks
    mockConfigService.validate.mockResolvedValue({
      isValid: true,
      message: "Validation successful",
      responseTimeMs: 100,
    });

    mockConfigService.getHealthStatus.mockResolvedValue({
      service: "docker",
      status: "connected",
      lastChecked: new Date(),
    });
  });

  describe("POST /api/settings/validate/:service", () => {
    const mockValidationResult: ValidationResult = {
      isValid: true,
      message: "Docker connection successful",
      responseTimeMs: 150,
      errorCode: undefined,
      metadata: {
        version: "20.10.17",
        apiVersion: "1.41",
      },
    };

    it("should validate Docker service successfully", async () => {
      mockConfigService.validate.mockResolvedValue(mockValidationResult);
      mockPrisma.connectivityStatus.create.mockResolvedValue({});
      mockPrisma.systemSettings.updateMany.mockResolvedValue({ count: 2 });

      const response = await request(app)
        .post("/api/settings/validate/docker")
        .send({})
        .expect(200);

      expect(response.body).toMatchObject({
        success: true,
        message: "docker service validation successful",
        data: {
          service: "docker",
          isValid: true,
          responseTimeMs: expect.any(Number),
          metadata: {
            version: "20.10.17",
            apiVersion: "1.41",
          },
          validatedAt: expect.any(String),
        },
      });

      expect(mockConfigFactory.create).toHaveBeenCalledWith({
        category: "docker",
      });

      expect(mockConfigService.validate).toHaveBeenCalled();

      expect(mockPrisma.connectivityStatus.create).toHaveBeenCalledWith({
        data: {
          service: "docker",
          status: "connected",
          responseTimeMs: expect.any(Number),
          errorMessage: null,
          errorCode: undefined,
          lastSuccessfulAt: expect.any(Date),
          checkInitiatedBy: "test-user-id",
          metadata: JSON.stringify(mockValidationResult.metadata),
        },
      });

      expect(mockPrisma.systemSettings.updateMany).toHaveBeenCalledWith({
        where: {
          category: "docker",
          isActive: true,
        },
        data: {
          validationStatus: "valid",
          validationMessage: null,
          lastValidatedAt: expect.any(Date),
        },
      });

      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          service: "docker",
          isValid: true,
          responseTimeMs: expect.any(Number),
        }),
        "Service validation completed",
      );
    });

    it("should handle failed validation", async () => {
      const failedValidationResult: ValidationResult = {
        isValid: false,
        message: "Docker daemon not running",
        responseTimeMs: 5000,
        errorCode: "CONNECTION_FAILED",
      };

      mockConfigService.validate.mockResolvedValue(failedValidationResult);
      mockPrisma.connectivityStatus.create.mockResolvedValue({});
      mockPrisma.systemSettings.updateMany.mockResolvedValue({ count: 1 });

      const response = await request(app)
        .post("/api/settings/validate/cloudflare")
        .send({})
        .expect(200);

      expect(response.body).toMatchObject({
        success: true,
        message: "cloudflare service validation failed",
        data: {
          service: "cloudflare",
          isValid: false,
          error: "Docker daemon not running",
          errorCode: "CONNECTION_FAILED",
        },
      });

      expect(mockPrisma.connectivityStatus.create).toHaveBeenCalledWith({
        data: {
          service: "cloudflare",
          status: "failed",
          responseTimeMs: expect.any(Number),
          errorMessage: "Docker daemon not running",
          errorCode: "CONNECTION_FAILED",
          lastSuccessfulAt: null,
          checkInitiatedBy: "test-user-id",
          metadata: null,
        },
      });

      expect(mockPrisma.systemSettings.updateMany).toHaveBeenCalledWith({
        where: {
          category: "cloudflare",
          isActive: true,
        },
        data: {
          validationStatus: "invalid",
          validationMessage: "Docker daemon not running",
          lastValidatedAt: expect.any(Date),
        },
      });
    });

    it("should handle validation with custom settings", async () => {
      const customSettings = {
        host: "tcp://192.168.1.100:2375",
        api_version: "1.41",
      };

      mockConfigService.validate.mockResolvedValue(mockValidationResult);
      mockPrisma.connectivityStatus.create.mockResolvedValue({});

      const response = await request(app)
        .post("/api/settings/validate/azure")
        .send({ settings: customSettings })
        .expect(200);

      // When custom settings are provided, we should not update SystemSettings
      expect(mockPrisma.systemSettings.updateMany).not.toHaveBeenCalled();
    });

    it("should return 400 for invalid service", async () => {
      const response = await request(app)
        .post("/api/settings/validate/invalid-service")
        .send({})
        .expect(400);

      expect(response.body).toMatchObject({
        error: "Bad Request",
        message:
          "Invalid service 'invalid-service'. Must be one of: docker, cloudflare, azure, postgres, system, deployments, haproxy, tls",
      });
    });

    it("should return 400 for invalid request body", async () => {
      const response = await request(app)
        .post("/api/settings/validate/docker")
        .send({ settings: "invalid" }) // Should be an object
        .expect(400);

      expect(response.body).toMatchObject({
        error: "Bad Request",
        message: "Invalid request data",
        details: expect.any(Array),
      });
    });


    it("should handle validation timeout", async () => {
      // Mock a validation that takes longer than the timeout
      mockConfigService.validate.mockImplementation(
        () =>
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Validation timeout")), 100),
          ),
      );

      const response = await request(app)
        .post("/api/settings/validate/docker")
        .send({})
        .expect(500);

      // Should store error in connectivity status
      expect(mockPrisma.connectivityStatus.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          service: "docker",
          status: "error",
          errorMessage: "Validation timeout",
          errorCode: "VALIDATION_ERROR",
        }),
      });
    }, 15000);

    it("should handle validation service errors", async () => {
      const validationError = new Error("Service configuration invalid");
      mockConfigService.validate.mockRejectedValue(validationError);

      const response = await request(app)
        .post("/api/settings/validate/docker")
        .send({})
        .expect(500);

      expect(mockPrisma.connectivityStatus.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          service: "docker",
          status: "error",
          errorMessage: "Service configuration invalid",
          errorCode: "VALIDATION_ERROR",
        }),
      });

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          error: validationError,
          service: "docker",
        }),
        "Service validation failed with error",
      );
    });

    it("should handle database error during validation storage", async () => {
      mockConfigService.validate.mockResolvedValue(mockValidationResult);

      const dbError = new Error("Database connection failed");
      mockPrisma.connectivityStatus.create.mockRejectedValue(dbError);

      const response = await request(app)
        .post("/api/settings/validate/docker")
        .send({})
        .expect(500);

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          error: dbError,
        }),
        "Service validation failed with error",
      );
    });
  });
});
