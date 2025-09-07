import { jest } from "@jest/globals";
import prisma from "../../lib/prisma";
import { PrismaClient } from "../../generated/prisma";
import { ValidationResult, ServiceHealthStatus } from "@mini-infra/types";
import { CloudflareConfigService } from "../cloudflare-config";

// Mock Cloudflare SDK
const mockCloudflare = {
  user: {
    get: jest.fn(),
  },
  accounts: {
    get: jest.fn(),
  },
  zeroTrust: {
    tunnels: {
      list: jest.fn(),
    },
  },
};

jest.mock("cloudflare", () => {
  return jest.fn().mockImplementation(() => mockCloudflare);
});

// Mock logger factory - create the mock instance inline
jest.mock("../../lib/logger-factory", () => {
  const mockLoggerInstance = {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  };

  return {
    appLogger: jest.fn(() => mockLoggerInstance),
    servicesLogger: jest.fn(() => mockLoggerInstance),
    httpLogger: jest.fn(() => mockLoggerInstance),
    prismaLogger: jest.fn(() => mockLoggerInstance),
    __esModule: true,
    default: jest.fn(() => mockLoggerInstance),
  };
});

// Get reference to the mocked logger
const { servicesLogger } = require("../../lib/logger-factory");
const mockLogger = servicesLogger();

// Mock Prisma client
const mockPrisma = {
  systemSettings: {
    findUnique: jest.fn(),
    upsert: jest.fn(),
    delete: jest.fn(),
  },
  connectivityStatus: {
    create: jest.fn(),
    findFirst: jest.fn(),
  },
} as unknown as typeof prisma;

// Import the mock after the jest.mock calls

describe("CloudflareConfigService", () => {
  let cloudflareConfigService: CloudflareConfigService;

  beforeEach(() => {
    jest.clearAllMocks();
    cloudflareConfigService = new CloudflareConfigService(mockPrisma);
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  describe("Constructor", () => {
    it("should initialize with correct category", () => {
      expect(cloudflareConfigService).toBeInstanceOf(CloudflareConfigService);
      expect((cloudflareConfigService as any).category).toBe("cloudflare");
    });
  });

  describe("validate", () => {
    it("should fail validation when API token is not configured", async () => {
      mockPrisma.systemSettings.findUnique = jest.fn().mockResolvedValue(null);
      mockPrisma.connectivityStatus.create = jest.fn().mockResolvedValue({});

      const result: ValidationResult = await cloudflareConfigService.validate();

      expect(result.isValid).toBe(false);
      expect(result.message).toBe("Cloudflare API token not configured");
      expect(result.errorCode).toBe("MISSING_API_TOKEN");
      expect(result.responseTimeMs).toBeGreaterThanOrEqual(0);

      // Verify failure was recorded
      expect(mockPrisma.connectivityStatus.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            service: "cloudflare",
            status: "failed",
            errorMessage: "Cloudflare API token not configured",
            errorCode: "MISSING_API_TOKEN",
            metadata: null,
            checkInitiatedBy: null,
            lastSuccessfulAt: null,
          }),
        }),
      );
    });

    it("should validate successfully with valid API token", async () => {
      // Mock API token setting
      mockPrisma.systemSettings.findUnique = jest
        .fn()
        .mockResolvedValueOnce({
          value: "valid-api-token-123",
        })
        .mockResolvedValueOnce(null); // No account ID

      // Mock successful user API call
      const mockUserResponse = {
        email: "test@example.com",
        id: "user-123",
        first_name: "Test",
        last_name: "User",
        suspended: false,
      };
      mockCloudflare.user.get.mockResolvedValue(mockUserResponse);

      mockPrisma.connectivityStatus.create = jest.fn().mockResolvedValue({});

      const result = await cloudflareConfigService.validate();

      expect(result.isValid).toBe(true);
      expect(result.message).toBe(
        "Cloudflare API connection successful (test@example.com)",
      );
      expect(result.responseTimeMs).toBeGreaterThanOrEqual(0);
      expect(result.metadata).toMatchObject({
        userEmail: "test@example.com",
        userId: "user-123",
        firstName: "Test",
        lastName: "User",
        accountStatus: "active",
      });

      // Verify success was recorded
      expect(mockPrisma.connectivityStatus.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            service: "cloudflare",
            status: "connected",
            errorMessage: null,
            errorCode: null,
            metadata: JSON.stringify(result.metadata),
            checkInitiatedBy: null,
          }),
        }),
      );
    });

    it("should validate API token and include account information", async () => {
      // Mock API token and account ID settings
      mockPrisma.systemSettings.findUnique = jest
        .fn()
        .mockResolvedValueOnce({
          value: "valid-api-token-123",
        })
        .mockResolvedValueOnce({
          value: "account-456",
        });

      // Mock successful API calls
      const mockUserResponse = {
        email: "admin@company.com",
        id: "user-456",
        first_name: "Admin",
        last_name: "User",
        suspended: false,
      };
      mockCloudflare.user.get.mockResolvedValue(mockUserResponse);

      const mockAccountResponse = {
        name: "Test Company Account",
        id: "account-456",
      };
      mockCloudflare.accounts.get.mockResolvedValue(mockAccountResponse);

      mockPrisma.connectivityStatus.create = jest.fn().mockResolvedValue({});

      const result = await cloudflareConfigService.validate();

      expect(result.isValid).toBe(true);
      expect(result.metadata).toMatchObject({
        userEmail: "admin@company.com",
        userId: "user-456",
        accountName: "Test Company Account",
        accountId: "account-456",
        accountStatus: "active",
      });

      expect(mockCloudflare.accounts.get).toHaveBeenCalledWith({
        account_id: "account-456",
      });
    });

    it("should handle account API failure gracefully when user API succeeds", async () => {
      mockPrisma.systemSettings.findUnique = jest
        .fn()
        .mockResolvedValueOnce({
          value: "valid-api-token-123",
        })
        .mockResolvedValueOnce({
          value: "invalid-account-id",
        });

      const mockUserResponse = {
        email: "test@example.com",
        id: "user-123",
        first_name: "Test",
        last_name: "User",
        suspended: false,
      };
      mockCloudflare.user.get.mockResolvedValue(mockUserResponse);

      // Mock account API failure
      const accountError = new Error("Account not found");
      mockCloudflare.accounts.get.mockRejectedValue(accountError);

      mockPrisma.connectivityStatus.create = jest.fn().mockResolvedValue({});

      const result = await cloudflareConfigService.validate();

      expect(result.isValid).toBe(true);
      expect(result.message).toBe(
        "Cloudflare API connection successful (test@example.com)",
      );
      expect(mockLogger.warn).toHaveBeenCalledWith(
        {
          accountId: "invalid-account-id",
          error: "Account not found",
        },
        "Failed to fetch account information, but API token is valid",
      );
    });

    it("should handle API timeout", async () => {
      mockPrisma.systemSettings.findUnique = jest.fn().mockResolvedValue({
        value: "valid-api-token-123",
      });

      // Mock timeout scenario by directly rejecting with timeout error
      mockCloudflare.user.get.mockRejectedValue(
        new Error("API request timeout"),
      );

      mockPrisma.connectivityStatus.create = jest.fn().mockResolvedValue({});

      const result = await cloudflareConfigService.validate();

      expect(result.isValid).toBe(false);
      expect(result.message).toContain("API request timeout");
      expect(result.errorCode).toBe("TIMEOUT");
    });

    it("should handle unauthorized API token", async () => {
      mockPrisma.systemSettings.findUnique = jest.fn().mockResolvedValue({
        value: "invalid-api-token",
      });

      const authError = new Error("Unauthorized");
      mockCloudflare.user.get.mockRejectedValue(authError);

      mockPrisma.connectivityStatus.create = jest.fn().mockResolvedValue({});

      const result = await cloudflareConfigService.validate();

      expect(result.isValid).toBe(false);
      expect(result.message).toContain("Unauthorized");
      expect(result.errorCode).toBe("INVALID_API_TOKEN");
    });

    it("should handle network errors", async () => {
      mockPrisma.systemSettings.findUnique = jest.fn().mockResolvedValue({
        value: "valid-api-token",
      });

      const networkError = new Error("ENOTFOUND api.cloudflare.com");
      mockCloudflare.user.get.mockRejectedValue(networkError);

      mockPrisma.connectivityStatus.create = jest.fn().mockResolvedValue({});

      const result = await cloudflareConfigService.validate();

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe("NETWORK_ERROR");

      // Verify unreachable status was recorded
      expect(mockPrisma.connectivityStatus.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            service: "cloudflare",
            status: "unreachable",
            errorMessage: expect.stringContaining("ENOTFOUND"),
            errorCode: "NETWORK_ERROR",
            metadata: null,
            checkInitiatedBy: null,
            lastSuccessfulAt: null,
          }),
        }),
      );
    });

    it("should handle rate limiting", async () => {
      mockPrisma.systemSettings.findUnique = jest.fn().mockResolvedValue({
        value: "valid-api-token",
      });

      const rateLimitError = new Error("Rate limit exceeded");
      mockCloudflare.user.get.mockRejectedValue(rateLimitError);

      mockPrisma.connectivityStatus.create = jest.fn().mockResolvedValue({});

      const result = await cloudflareConfigService.validate();

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe("RATE_LIMITED");
    });

    it("should handle forbidden access", async () => {
      mockPrisma.systemSettings.findUnique = jest.fn().mockResolvedValue({
        value: "limited-api-token",
      });

      const forbiddenError = new Error("Forbidden");
      mockCloudflare.user.get.mockRejectedValue(forbiddenError);

      mockPrisma.connectivityStatus.create = jest.fn().mockResolvedValue({});

      const result = await cloudflareConfigService.validate();

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe("INSUFFICIENT_PERMISSIONS");
    });
  });

  describe("getHealthStatus", () => {
    it("should return health status from latest connectivity record", async () => {
      const mockConnectivityStatus = {
        service: "cloudflare",
        status: "connected",
        responseTimeMs: 250,
        errorMessage: null,
        errorCode: null,
        checkedAt: new Date("2023-01-01T12:00:00Z"),
        lastSuccessfulAt: new Date("2023-01-01T12:00:00Z"),
        metadata: JSON.stringify({
          userEmail: "test@example.com",
          accountName: "Test Account",
        }),
      };

      mockPrisma.connectivityStatus.findFirst = jest
        .fn()
        .mockResolvedValue(mockConnectivityStatus);

      const result: ServiceHealthStatus =
        await cloudflareConfigService.getHealthStatus();

      expect(result).toEqual({
        service: "cloudflare",
        status: "connected",
        lastChecked: new Date("2023-01-01T12:00:00Z"),
        lastSuccessful: new Date("2023-01-01T12:00:00Z"),
        responseTime: 250,
        errorMessage: undefined,
        errorCode: undefined,
        metadata: {
          userEmail: "test@example.com",
          accountName: "Test Account",
        },
      });
    });

    it("should perform validation when no connectivity data exists", async () => {
      mockPrisma.connectivityStatus.findFirst = jest
        .fn()
        .mockResolvedValue(null);

      // Mock validation call
      mockPrisma.systemSettings.findUnique = jest.fn().mockResolvedValue({
        value: "test-token",
      });

      const mockUserResponse = {
        email: "test@example.com",
        id: "user-123",
        first_name: "Test",
        last_name: "User",
        suspended: false,
      };
      mockCloudflare.user.get.mockResolvedValue(mockUserResponse);
      mockPrisma.connectivityStatus.create = jest.fn().mockResolvedValue({});

      const result = await cloudflareConfigService.getHealthStatus();

      expect(result.service).toBe("cloudflare");
      expect(result.status).toBe("connected");
      expect(result.lastChecked).toBeInstanceOf(Date);
    });
  });

  describe("setApiToken", () => {
    it("should set API token successfully", async () => {
      const parentSetSpy = jest.spyOn(
        Object.getPrototypeOf(Object.getPrototypeOf(cloudflareConfigService)),
        "set",
      );
      parentSetSpy.mockResolvedValue(undefined);

      await cloudflareConfigService.setApiToken(
        "new-api-token-12345678901234567890",
        "user1",
      );

      expect(parentSetSpy).toHaveBeenCalledWith(
        "api_token",
        "new-api-token-12345678901234567890",
        "user1",
      );

      parentSetSpy.mockRestore();
    });

    it("should reject empty API token", async () => {
      await expect(
        cloudflareConfigService.setApiToken("", "user1"),
      ).rejects.toThrow("API token cannot be empty");

      await expect(
        cloudflareConfigService.setApiToken("   ", "user1"),
      ).rejects.toThrow("API token cannot be empty");
    });

    it("should reject API token with invalid format", async () => {
      await expect(
        cloudflareConfigService.setApiToken("short", "user1"),
      ).rejects.toThrow("Invalid API token format");
    });
  });

  describe("setAccountId", () => {
    it("should set account ID successfully", async () => {
      const parentSetSpy = jest.spyOn(
        Object.getPrototypeOf(Object.getPrototypeOf(cloudflareConfigService)),
        "set",
      );
      parentSetSpy.mockResolvedValue(undefined);

      await cloudflareConfigService.setAccountId("account-123", "user1");

      expect(parentSetSpy).toHaveBeenCalledWith(
        "account_id",
        "account-123",
        "user1",
      );

      parentSetSpy.mockRestore();
    });

    it("should reject empty account ID", async () => {
      await expect(
        cloudflareConfigService.setAccountId("", "user1"),
      ).rejects.toThrow("Account ID cannot be empty");
    });
  });

  describe("getApiToken and getAccountId", () => {
    it("should retrieve API token from settings", async () => {
      const parentGetSpy = jest.spyOn(
        Object.getPrototypeOf(Object.getPrototypeOf(cloudflareConfigService)),
        "get",
      );
      parentGetSpy.mockResolvedValue("stored-api-token");

      const result = await cloudflareConfigService.getApiToken();

      expect(result).toBe("stored-api-token");
      expect(parentGetSpy).toHaveBeenCalledWith("api_token");

      parentGetSpy.mockRestore();
    });

    it("should retrieve account ID from settings", async () => {
      const parentGetSpy = jest.spyOn(
        Object.getPrototypeOf(Object.getPrototypeOf(cloudflareConfigService)),
        "get",
      );
      parentGetSpy.mockResolvedValue("stored-account-id");

      const result = await cloudflareConfigService.getAccountId();

      expect(result).toBe("stored-account-id");
      expect(parentGetSpy).toHaveBeenCalledWith("account_id");

      parentGetSpy.mockRestore();
    });
  });

  describe("getTunnelInfo", () => {
    it("should retrieve tunnel information successfully", async () => {
      // Mock stored settings
      jest
        .spyOn(cloudflareConfigService, "getApiToken")
        .mockResolvedValue("valid-token");
      jest
        .spyOn(cloudflareConfigService, "getAccountId")
        .mockResolvedValue("account-123");

      // Mock tunnel list API response
      const mockTunnelsResponse = {
        result: [
          {
            id: "tunnel-1",
            name: "web-tunnel",
            status: "healthy",
            created_at: "2023-01-01T00:00:00Z",
            connections: [
              {
                id: "conn-1",
                origin_ip: "192.168.1.100",
              },
            ],
          },
          {
            id: "tunnel-2",
            name: "api-tunnel",
            status: "down",
            created_at: "2023-01-02T00:00:00Z",
            connections: [],
          },
        ],
      };

      mockCloudflare.zeroTrust.tunnels.list.mockResolvedValue(
        mockTunnelsResponse,
      );

      const result = await cloudflareConfigService.getTunnelInfo();

      expect(result).toEqual([
        {
          id: "tunnel-1",
          name: "web-tunnel",
          status: "healthy",
          created_at: "2023-01-01T00:00:00Z",
          connections: [
            {
              id: "conn-1",
              origin_ip: "192.168.1.100",
            },
          ],
        },
        {
          id: "tunnel-2",
          name: "api-tunnel",
          status: "down",
          created_at: "2023-01-02T00:00:00Z",
          connections: [],
        },
      ]);

      expect(mockCloudflare.zeroTrust.tunnels.list).toHaveBeenCalledWith({
        account_id: "account-123",
      });

      expect(mockLogger.info).toHaveBeenCalledWith(
        {
          accountId: "account-123",
          tunnelCount: 2,
        },
        "Successfully retrieved Cloudflare tunnel information",
      );
    });

    it("should return empty array when API token not configured", async () => {
      jest
        .spyOn(cloudflareConfigService, "getApiToken")
        .mockResolvedValue(null);

      const result = await cloudflareConfigService.getTunnelInfo();

      expect(result).toEqual([]);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        "Cannot retrieve tunnel info: API token not configured",
      );
    });

    it("should return empty array when account ID not configured", async () => {
      jest
        .spyOn(cloudflareConfigService, "getApiToken")
        .mockResolvedValue("valid-token");
      jest
        .spyOn(cloudflareConfigService, "getAccountId")
        .mockResolvedValue(null);

      const result = await cloudflareConfigService.getTunnelInfo();

      expect(result).toEqual([]);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        "Cannot retrieve tunnel info: Account ID not configured",
      );
    });

    it("should handle tunnel API timeout", async () => {
      jest
        .spyOn(cloudflareConfigService, "getApiToken")
        .mockResolvedValue("valid-token");
      jest
        .spyOn(cloudflareConfigService, "getAccountId")
        .mockResolvedValue("account-123");

      // Mock timeout scenario by directly rejecting with timeout error
      mockCloudflare.zeroTrust.tunnels.list.mockRejectedValue(
        new Error("Tunnel API request timeout"),
      );

      const result = await cloudflareConfigService.getTunnelInfo();

      expect(result).toEqual([]);
      expect(mockLogger.error).toHaveBeenCalledWith(
        {
          error: "Tunnel API request timeout",
          errorCode: "TIMEOUT",
          isRetriable: true,
        },
        "Failed to retrieve Cloudflare tunnel information",
      );
    });

    it("should handle tunnel API errors", async () => {
      jest
        .spyOn(cloudflareConfigService, "getApiToken")
        .mockResolvedValue("valid-token");
      jest
        .spyOn(cloudflareConfigService, "getAccountId")
        .mockResolvedValue("account-123");

      const apiError = new Error("Cloudflare API error");
      mockCloudflare.zeroTrust.tunnels.list.mockRejectedValue(apiError);

      const result = await cloudflareConfigService.getTunnelInfo();

      expect(result).toEqual([]);
      expect(mockLogger.error).toHaveBeenCalledWith(
        {
          error: "Cloudflare API error",
          errorCode: "CLOUDFLARE_API_ERROR",
          isRetriable: true,
        },
        "Failed to retrieve Cloudflare tunnel information",
      );
    });
  });

  describe("Circuit Breaker Functionality", () => {
    it("should open circuit after 5 consecutive failures", async () => {
      mockPrisma.systemSettings.findUnique = jest.fn().mockResolvedValue({
        value: "valid-api-token",
      });

      // Mock 5 consecutive failures
      const networkError = new Error("ECONNREFUSED");
      mockCloudflare.user.get.mockRejectedValue(networkError);
      mockPrisma.connectivityStatus.create = jest.fn().mockResolvedValue({});

      // Make 5 failed requests
      for (let i = 0; i < 5; i++) {
        const result = await cloudflareConfigService.validate();
        expect(result.isValid).toBe(false);
        expect(result.errorCode).toBe("NETWORK_ERROR");
      }

      // 6th request should be blocked by circuit breaker
      const result = await cloudflareConfigService.validate();
      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe("CIRCUIT_BREAKER_OPEN");
      expect(result.message).toContain(
        "Circuit breaker open after 5 consecutive failures",
      );

      // Verify API was not called on 6th attempt
      expect(mockCloudflare.user.get).toHaveBeenCalledTimes(5);
    });

    it("should reset circuit breaker on successful request", async () => {
      mockPrisma.systemSettings.findUnique = jest.fn().mockResolvedValue({
        value: "valid-api-token",
      });

      // First cause some failures (but not enough to open circuit)
      const networkError = new Error("ECONNREFUSED");
      mockCloudflare.user.get.mockRejectedValue(networkError);
      mockPrisma.connectivityStatus.create = jest.fn().mockResolvedValue({});

      // Make 3 failed requests
      for (let i = 0; i < 3; i++) {
        await cloudflareConfigService.validate();
      }

      // Now mock a successful response
      const mockUserResponse = {
        email: "test@example.com",
        id: "user-123",
        first_name: "Test",
        last_name: "User",
        suspended: false,
      };
      mockCloudflare.user.get.mockResolvedValue(mockUserResponse);

      // Make successful request
      const result = await cloudflareConfigService.validate();
      expect(result.isValid).toBe(true);

      // Circuit breaker should be reset, so failures should start counting from 0
      mockCloudflare.user.get.mockRejectedValue(networkError);

      // Make 4 more failed requests (should not open circuit yet)
      for (let i = 0; i < 4; i++) {
        const failResult = await cloudflareConfigService.validate();
        expect(failResult.errorCode).toBe("NETWORK_ERROR");
      }

      // Circuit should still be closed (only 4 failures after reset)
      const finalResult = await cloudflareConfigService.validate();
      expect(finalResult.errorCode).toBe("NETWORK_ERROR");
      expect(finalResult.errorCode).not.toBe("CIRCUIT_BREAKER_OPEN");
    });

    it("should not count non-retriable errors toward circuit breaker", async () => {
      mockPrisma.systemSettings.findUnique = jest.fn().mockResolvedValue({
        value: "invalid-api-token",
      });
      mockPrisma.connectivityStatus.create = jest.fn().mockResolvedValue({});

      // Mock 401 errors (non-retriable)
      const authError = new Error("Unauthorized") as any;
      authError.response = { status: 401 };
      mockCloudflare.user.get.mockRejectedValue(authError);

      // Make 10 requests with auth errors
      for (let i = 0; i < 10; i++) {
        const result = await cloudflareConfigService.validate();
        expect(result.isValid).toBe(false);
        expect(result.errorCode).toBe("INVALID_API_TOKEN");
      }

      // Circuit should still be closed
      // All requests should have gone through (not blocked by circuit breaker)
      expect(mockCloudflare.user.get).toHaveBeenCalledTimes(10);
    });

    it("should handle request deduplication within 1-second window", async () => {
      mockPrisma.systemSettings.findUnique = jest.fn().mockResolvedValue({
        value: "valid-api-token",
      });

      const mockUserResponse = {
        email: "test@example.com",
        id: "user-123",
        first_name: "Test",
        last_name: "User",
        suspended: false,
      };
      mockCloudflare.user.get.mockResolvedValue(mockUserResponse);
      mockPrisma.connectivityStatus.create = jest.fn().mockResolvedValue({});

      // Make multiple concurrent requests
      const promises = [
        cloudflareConfigService.validate(),
        cloudflareConfigService.validate(),
        cloudflareConfigService.validate(),
      ];

      const results = await Promise.all(promises);

      // All should get the same successful result
      results.forEach((result) => {
        expect(result.isValid).toBe(true);
        expect(result.message).toBe(
          "Cloudflare API connection successful (test@example.com)",
        );
      });

      // But API should only be called once due to deduplication
      expect(mockCloudflare.user.get).toHaveBeenCalledTimes(1);
    });

    it("should properly categorize different HTTP error codes", async () => {
      mockPrisma.systemSettings.findUnique = jest.fn().mockResolvedValue({
        value: "valid-api-token",
      });
      mockPrisma.connectivityStatus.create = jest.fn().mockResolvedValue({});

      // Test 403 Forbidden
      const forbiddenError = new Error("Forbidden") as any;
      forbiddenError.response = { status: 403 };
      mockCloudflare.user.get.mockRejectedValue(forbiddenError);

      let result = await cloudflareConfigService.validate();
      expect(result.errorCode).toBe("INSUFFICIENT_PERMISSIONS");

      // Test 429 Rate Limited
      const rateLimitError = new Error("Too Many Requests") as any;
      rateLimitError.response = { status: 429 };
      mockCloudflare.user.get.mockRejectedValue(rateLimitError);

      result = await cloudflareConfigService.validate();
      expect(result.errorCode).toBe("RATE_LIMITED");

      // Test 503 Service Unavailable
      const serviceError = new Error("Service Unavailable") as any;
      serviceError.response = { status: 503 };
      mockCloudflare.user.get.mockRejectedValue(serviceError);

      result = await cloudflareConfigService.validate();
      expect(result.errorCode).toBe("SERVER_ERROR_503");
    });

    it("should transition circuit from open to half-open after cooldown", async () => {
      // Use fake timers for this test
      jest.useFakeTimers();

      mockPrisma.systemSettings.findUnique = jest.fn().mockResolvedValue({
        value: "valid-api-token",
      });
      mockPrisma.connectivityStatus.create = jest.fn().mockResolvedValue({});

      // Cause 5 failures to open circuit
      const networkError = new Error("ECONNREFUSED");
      mockCloudflare.user.get.mockRejectedValue(networkError);

      for (let i = 0; i < 5; i++) {
        await cloudflareConfigService.validate();
      }

      // Circuit should be open
      let result = await cloudflareConfigService.validate();
      expect(result.errorCode).toBe("CIRCUIT_BREAKER_OPEN");

      // Advance time by 4 minutes (less than cooldown)
      jest.advanceTimersByTime(4 * 60 * 1000);

      // Circuit should still be open
      result = await cloudflareConfigService.validate();
      expect(result.errorCode).toBe("CIRCUIT_BREAKER_OPEN");

      // Advance time by 2 more minutes (total 6 minutes, past cooldown)
      jest.advanceTimersByTime(2 * 60 * 1000);

      // Now mock a successful response for half-open test
      const mockUserResponse = {
        email: "test@example.com",
        id: "user-123",
        first_name: "Test",
        last_name: "User",
        suspended: false,
      };
      mockCloudflare.user.get.mockResolvedValue(mockUserResponse);

      // Circuit should transition to half-open and allow request
      result = await cloudflareConfigService.validate();
      expect(result.isValid).toBe(true);

      // Circuit should be fully closed after success
      result = await cloudflareConfigService.validate();
      expect(result.isValid).toBe(true);

      jest.useRealTimers();
    });

    it("should reset circuit breaker when new API token is set", async () => {
      mockPrisma.systemSettings.findUnique = jest.fn().mockResolvedValue({
        value: "bad-token",
      });
      mockPrisma.connectivityStatus.create = jest.fn().mockResolvedValue({});

      // Cause failures to open circuit
      const networkError = new Error("ECONNREFUSED");
      mockCloudflare.user.get.mockRejectedValue(networkError);

      for (let i = 0; i < 5; i++) {
        await cloudflareConfigService.validate();
      }

      // Circuit should be open
      let result = await cloudflareConfigService.validate();
      expect(result.errorCode).toBe("CIRCUIT_BREAKER_OPEN");

      // Set new API token
      const parentSetSpy = jest.spyOn(
        Object.getPrototypeOf(Object.getPrototypeOf(cloudflareConfigService)),
        "set",
      );
      parentSetSpy.mockResolvedValue(undefined);

      await cloudflareConfigService.setApiToken(
        "new-valid-token-12345678901234567890",
        "user1",
      );

      // Mock successful response with new token
      mockPrisma.systemSettings.findUnique = jest.fn().mockResolvedValue({
        value: "new-valid-token-12345678901234567890",
      });

      const mockUserResponse = {
        email: "test@example.com",
        id: "user-123",
        first_name: "Test",
        last_name: "User",
        suspended: false,
      };
      mockCloudflare.user.get.mockResolvedValue(mockUserResponse);

      // Circuit should be reset and allow request
      result = await cloudflareConfigService.validate();
      expect(result.isValid).toBe(true);
      expect(result.errorCode).toBeUndefined();

      parentSetSpy.mockRestore();
    });
  });

  describe("removeConfiguration", () => {
    it("should remove both API token and account ID", async () => {
      const parentDeleteSpy = jest.spyOn(
        Object.getPrototypeOf(Object.getPrototypeOf(cloudflareConfigService)),
        "delete",
      );
      parentDeleteSpy.mockResolvedValue(undefined);

      const parentGetSpy = jest.spyOn(
        Object.getPrototypeOf(Object.getPrototypeOf(cloudflareConfigService)),
        "get",
      );
      parentGetSpy.mockResolvedValue("old-account-id");

      mockPrisma.connectivityStatus.create = jest.fn().mockResolvedValue({});

      await cloudflareConfigService.removeConfiguration("user1");

      expect(parentDeleteSpy).toHaveBeenCalledWith("api_token", "user1");
      expect(parentDeleteSpy).toHaveBeenCalledWith("account_id", "user1");

      // Verify disconnection was recorded
      expect(mockPrisma.connectivityStatus.create).toHaveBeenCalledWith({
        data: {
          service: "cloudflare",
          status: "failed",
          responseTimeMs: null,
          errorMessage: "Configuration removed by user",
          errorCode: "CONFIG_REMOVED",
          metadata: null,
          checkInitiatedBy: "user1",
          checkedAt: expect.any(Date),
          lastSuccessfulAt: null,
        },
      });

      parentDeleteSpy.mockRestore();
      parentGetSpy.mockRestore();
    });

    it("should continue even if token or account ID deletion fails", async () => {
      const parentDeleteSpy = jest.spyOn(
        Object.getPrototypeOf(Object.getPrototypeOf(cloudflareConfigService)),
        "delete",
      );
      parentDeleteSpy
        .mockRejectedValueOnce(new Error("Token not found"))
        .mockRejectedValueOnce(new Error("Account ID not found"));

      const parentGetSpy = jest.spyOn(
        Object.getPrototypeOf(Object.getPrototypeOf(cloudflareConfigService)),
        "get",
      );
      parentGetSpy.mockResolvedValue(null);

      mockPrisma.connectivityStatus.create = jest.fn().mockResolvedValue({});

      // Should not throw
      await expect(
        cloudflareConfigService.removeConfiguration("user1"),
      ).resolves.toBeUndefined();

      // Should still record disconnection
      expect(mockPrisma.connectivityStatus.create).toHaveBeenCalled();

      parentDeleteSpy.mockRestore();
      parentGetSpy.mockRestore();
    });
  });
});
