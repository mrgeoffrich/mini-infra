import prisma from "../../lib/prisma";
import { PrismaClient } from "../../generated/prisma/client";
import { ValidationResult, ServiceHealthStatus } from "@mini-infra/types";
import { CloudflareService } from "../cloudflare";
import * as loggerFactory from "../../lib/logger-factory";

const { mockCloudflare } = vi.hoisted(() => ({
  mockCloudflare: {
    user: {
      get: vi.fn(),
    },
    accounts: {
      get: vi.fn(),
    },
    zones: {
      list: vi.fn(),
    },
    zeroTrust: {
      tunnels: {
        list: vi.fn(),
      },
    },
  },
}));

// Mock Cloudflare SDK
vi.mock("cloudflare", () => ({
  default: vi.fn().mockImplementation(function() { return mockCloudflare; }),
}));

// Mock logger factory - create the mock instance inline
vi.mock("../../lib/logger-factory", () => {
  const mockLoggerInstance = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  };

  return {
    appLogger: vi.fn(function() { return mockLoggerInstance; }),
    servicesLogger: vi.fn(function() { return mockLoggerInstance; }),
    httpLogger: vi.fn(function() { return mockLoggerInstance; }),
    prismaLogger: vi.fn(function() { return mockLoggerInstance; }),
    default: vi.fn(function() { return mockLoggerInstance; }),
  };
});

// Get reference to the mocked logger
const { servicesLogger } = loggerFactory as any;
const mockLogger = servicesLogger();

// Mock Prisma client
const mockPrisma = {
  systemSettings: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
  },
  connectivityStatus: {
    create: vi.fn(),
    findFirst: vi.fn(),
  },
} as unknown as typeof prisma;

// Import the mock after the vi.mock calls

describe("CloudflareService", () => {
  let cloudflareConfigService: CloudflareService;

  beforeEach(() => {
    vi.clearAllMocks();
    cloudflareConfigService = new CloudflareService(mockPrisma);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  describe("Constructor", () => {
    it("should initialize with correct category", () => {
      expect(cloudflareConfigService).toBeInstanceOf(CloudflareService);
      expect((cloudflareConfigService as any).category).toBe("cloudflare");
    });
  });

  describe("validate", () => {
    it("should fail validation when API token is not configured", async () => {
      mockPrisma.systemSettings.findUnique = vi.fn().mockResolvedValue(null);
      mockPrisma.connectivityStatus.create = vi.fn().mockResolvedValue({});

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

    it("should fail validation when account ID is not configured", async () => {
      mockPrisma.systemSettings.findUnique = vi
        .fn()
        .mockResolvedValueOnce({
          value: "valid-api-token-123",
        })
        .mockResolvedValueOnce(null); // No account ID

      mockPrisma.connectivityStatus.create = vi.fn().mockResolvedValue({});

      const result = await cloudflareConfigService.validate();

      expect(result.isValid).toBe(false);
      expect(result.message).toBe("Cloudflare account ID not configured");
      expect(result.errorCode).toBe("MISSING_ACCOUNT_ID");
    });

    it("should validate successfully with zone and tunnel access", async () => {
      // Mock API token and account ID settings
      mockPrisma.systemSettings.findUnique = vi
        .fn()
        .mockResolvedValueOnce({
          value: "valid-api-token-123",
        })
        .mockResolvedValueOnce({
          value: "account-456",
        });

      // Mock successful zone list
      mockCloudflare.zones.list.mockResolvedValue({
        result: [{ name: "example.com" }, { name: "example.org" }],
      });

      // Mock successful tunnel list
      mockCloudflare.zeroTrust.tunnels.list.mockResolvedValue({
        result: [{ name: "web-tunnel", deleted_at: null }],
      });

      mockPrisma.connectivityStatus.create = vi.fn().mockResolvedValue({});

      const result = await cloudflareConfigService.validate();

      expect(result.isValid).toBe(true);
      expect(result.message).toContain("2 zone(s)");
      expect(result.message).toContain("1 tunnel(s)");
      expect(result.responseTimeMs).toBeGreaterThanOrEqual(0);
      expect(result.metadata).toMatchObject({
        zoneCount: 2,
        tunnelCount: 1,
        accountId: "account-456",
      });

      expect(mockCloudflare.zones.list).toHaveBeenCalledWith({
        account: { id: "account-456" },
      });
      expect(mockCloudflare.zeroTrust.tunnels.list).toHaveBeenCalledWith({
        account_id: "account-456",
      });

      // Verify success was recorded
      expect(mockPrisma.connectivityStatus.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            service: "cloudflare",
            status: "connected",
          }),
        }),
      );
    });

    it("should fail validation when zone access is denied", async () => {
      mockPrisma.systemSettings.findUnique = vi
        .fn()
        .mockResolvedValueOnce({
          value: "valid-api-token-123",
        })
        .mockResolvedValueOnce({
          value: "account-456",
        });

      // Mock zone list failure (missing permission)
      mockCloudflare.zones.list.mockRejectedValue(new Error("Forbidden"));

      // Mock successful tunnel list
      mockCloudflare.zeroTrust.tunnels.list.mockResolvedValue({
        result: [{ name: "web-tunnel", deleted_at: null }],
      });

      mockPrisma.connectivityStatus.create = vi.fn().mockResolvedValue({});

      const result = await cloudflareConfigService.validate();

      expect(result.isValid).toBe(false);
      expect(result.message).toContain("Zone:Read");
      expect(result.errorCode).toBe("MISSING_PERMISSIONS");
    });

    it("should fail validation when tunnel access is denied", async () => {
      mockPrisma.systemSettings.findUnique = vi
        .fn()
        .mockResolvedValueOnce({
          value: "valid-api-token-123",
        })
        .mockResolvedValueOnce({
          value: "account-456",
        });

      // Mock successful zone list
      mockCloudflare.zones.list.mockResolvedValue({
        result: [{ name: "example.com" }],
      });

      // Mock tunnel list failure (missing permission)
      mockCloudflare.zeroTrust.tunnels.list.mockRejectedValue(
        new Error("Forbidden"),
      );

      mockPrisma.connectivityStatus.create = vi.fn().mockResolvedValue({});

      const result = await cloudflareConfigService.validate();

      expect(result.isValid).toBe(false);
      expect(result.message).toContain("Tunnel:Read");
      expect(result.errorCode).toBe("MISSING_PERMISSIONS");
    });

    it("should report both missing permissions", async () => {
      mockPrisma.systemSettings.findUnique = vi
        .fn()
        .mockResolvedValueOnce({
          value: "valid-api-token-123",
        })
        .mockResolvedValueOnce({
          value: "account-456",
        });

      mockCloudflare.zones.list.mockRejectedValue(new Error("Forbidden"));
      mockCloudflare.zeroTrust.tunnels.list.mockRejectedValue(
        new Error("Forbidden"),
      );

      mockPrisma.connectivityStatus.create = vi.fn().mockResolvedValue({});

      const result = await cloudflareConfigService.validate();

      expect(result.isValid).toBe(false);
      expect(result.message).toContain("Zone:Read");
      expect(result.message).toContain("Tunnel:Read");
      expect(result.errorCode).toBe("MISSING_PERMISSIONS");
    });

    it("should handle API timeout on zone check", async () => {
      mockPrisma.systemSettings.findUnique = vi
        .fn()
        .mockResolvedValueOnce({ value: "valid-api-token-123" })
        .mockResolvedValueOnce({ value: "account-456" });

      // Mock timeout on zone list — this is re-thrown to the outer catch
      mockCloudflare.zones.list.mockRejectedValue(
        new Error("Zone API request timeout"),
      );

      mockPrisma.connectivityStatus.create = vi.fn().mockResolvedValue({});

      const result = await cloudflareConfigService.validate();

      expect(result.isValid).toBe(false);
      expect(result.message).toContain("timeout");
      expect(result.errorCode).toBe("TIMEOUT");
    });

    it("should handle network errors", async () => {
      mockPrisma.systemSettings.findUnique = vi
        .fn()
        .mockResolvedValueOnce({ value: "valid-api-token" })
        .mockResolvedValueOnce({ value: "account-456" });

      // Network errors are not permission errors — they propagate to the outer catch
      const networkError = new Error("ENOTFOUND api.cloudflare.com");
      mockCloudflare.zones.list.mockRejectedValue(networkError);

      mockPrisma.connectivityStatus.create = vi.fn().mockResolvedValue({});

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
      mockPrisma.systemSettings.findUnique = vi
        .fn()
        .mockResolvedValueOnce({ value: "valid-api-token" })
        .mockResolvedValueOnce({ value: "account-456" });

      const rateLimitError = new Error("Rate limit exceeded");
      mockCloudflare.zones.list.mockRejectedValue(rateLimitError);

      mockPrisma.connectivityStatus.create = vi.fn().mockResolvedValue({});

      const result = await cloudflareConfigService.validate();

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe("RATE_LIMITED");
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
          zoneCount: 2,
          tunnelCount: 1,
        }),
      };

      mockPrisma.connectivityStatus.findFirst = vi
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
          zoneCount: 2,
          tunnelCount: 1,
        },
      });
    });

    it("should perform validation when no connectivity data exists", async () => {
      mockPrisma.connectivityStatus.findFirst = vi
        .fn()
        .mockResolvedValue(null);

      // Mock validation call — needs both token and account ID
      mockPrisma.systemSettings.findUnique = vi
        .fn()
        .mockResolvedValueOnce({ value: "test-token" })
        .mockResolvedValueOnce({ value: "account-456" });

      mockCloudflare.zones.list.mockResolvedValue({
        result: [{ name: "example.com" }],
      });
      mockCloudflare.zeroTrust.tunnels.list.mockResolvedValue({
        result: [],
      });
      mockPrisma.connectivityStatus.create = vi.fn().mockResolvedValue({});

      const result = await cloudflareConfigService.getHealthStatus();

      expect(result.service).toBe("cloudflare");
      expect(result.status).toBe("connected");
      expect(result.lastChecked).toBeInstanceOf(Date);
    });
  });

  describe("setApiToken", () => {
    it("should set API token successfully", async () => {
      const parentSetSpy = vi.spyOn(
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
      const parentSetSpy = vi.spyOn(
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
      const parentGetSpy = vi.spyOn(
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
      const parentGetSpy = vi.spyOn(
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
      vi
        .spyOn(cloudflareConfigService, "getApiToken")
        .mockResolvedValue("valid-token");
      vi
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
        {},
        "Cloudflare tunnel list succeeded",
      );
    });

    it("should return empty array when API token not configured", async () => {
      vi
        .spyOn(cloudflareConfigService, "getApiToken")
        .mockResolvedValue(null);

      const result = await cloudflareConfigService.getTunnelInfo();

      expect(result).toEqual([]);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        { reason: "Cloudflare API token not configured" },
        "Cannot execute tunnel list",
      );
    });

    it("should return empty array when account ID not configured", async () => {
      vi
        .spyOn(cloudflareConfigService, "getApiToken")
        .mockResolvedValue("valid-token");
      vi
        .spyOn(cloudflareConfigService, "getAccountId")
        .mockResolvedValue(null);

      const result = await cloudflareConfigService.getTunnelInfo();

      expect(result).toEqual([]);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        { reason: "Cloudflare account ID not configured" },
        "Cannot execute tunnel list",
      );
    });

    it("should handle tunnel API timeout", async () => {
      vi
        .spyOn(cloudflareConfigService, "getApiToken")
        .mockResolvedValue("valid-token");
      vi
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
        "Cloudflare tunnel list failed",
      );
    });

    it("should handle tunnel API errors", async () => {
      vi
        .spyOn(cloudflareConfigService, "getApiToken")
        .mockResolvedValue("valid-token");
      vi
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
        "Cloudflare tunnel list failed",
      );
    });
  });

  describe("Circuit Breaker Functionality", () => {
    // Helper to mock both token + account ID settings
    function mockStoredSettings(token: string, accountId = "account-456") {
      mockPrisma.systemSettings.findUnique = vi.fn().mockImplementation(
        ({ where }: any) => {
          if (where?.category_key?.key === "api_token") {
            return Promise.resolve({ value: token });
          }
          if (where?.category_key?.key === "account_id") {
            return Promise.resolve({ value: accountId });
          }
          return Promise.resolve(null);
        },
      );
    }

    // Helper to mock successful zone + tunnel responses
    function mockSuccessfulApis() {
      mockCloudflare.zones.list.mockResolvedValue({
        result: [{ name: "example.com" }],
      });
      mockCloudflare.zeroTrust.tunnels.list.mockResolvedValue({
        result: [],
      });
    }

    it("should open circuit after 5 consecutive failures", async () => {
      mockStoredSettings("valid-api-token");

      // Mock network error on zone list (re-thrown as timeout-like outer error)
      const networkError = new Error("ECONNREFUSED");
      mockCloudflare.zones.list.mockRejectedValue(networkError);
      mockPrisma.connectivityStatus.create = vi.fn().mockResolvedValue({});

      // Make 5 failed requests
      for (let i = 0; i < 5; i++) {
        const result = await cloudflareConfigService.validate();
        expect(result.isValid).toBe(false);
      }

      // 6th request should be blocked by circuit breaker
      const result = await cloudflareConfigService.validate();
      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe("CIRCUIT_BREAKER_OPEN");
      expect(result.message).toContain(
        "Circuit breaker open after 5 consecutive failures",
      );
    });

    it("should reset circuit breaker on successful request", async () => {
      mockStoredSettings("valid-api-token");

      // First cause some failures
      const networkError = new Error("ECONNREFUSED");
      mockCloudflare.zones.list.mockRejectedValue(networkError);
      mockPrisma.connectivityStatus.create = vi.fn().mockResolvedValue({});

      // Make 3 failed requests
      for (let i = 0; i < 3; i++) {
        await cloudflareConfigService.validate();
      }

      // Now mock a successful response
      mockSuccessfulApis();

      // Make successful request
      const result = await cloudflareConfigService.validate();
      expect(result.isValid).toBe(true);

      // Circuit breaker should be reset, so failures should start counting from 0
      mockCloudflare.zones.list.mockRejectedValue(networkError);

      // Make 4 more failed requests (should not open circuit yet)
      for (let i = 0; i < 4; i++) {
        const failResult = await cloudflareConfigService.validate();
        expect(failResult.isValid).toBe(false);
      }

      // Circuit should still be closed (only 4 failures after reset)
      const finalResult = await cloudflareConfigService.validate();
      expect(finalResult.isValid).toBe(false);
      expect(finalResult.errorCode).not.toBe("CIRCUIT_BREAKER_OPEN");
    });

    it("should handle request deduplication within 1-second window", async () => {
      mockStoredSettings("valid-api-token");
      mockSuccessfulApis();
      mockPrisma.connectivityStatus.create = vi.fn().mockResolvedValue({});

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
      });

      // But API should only be called once due to deduplication
      expect(mockCloudflare.zones.list).toHaveBeenCalledTimes(1);
    });

    it("should transition circuit from open to half-open after cooldown", async () => {
      // Use fake timers for this test
      vi.useFakeTimers();

      mockStoredSettings("valid-api-token");
      mockPrisma.connectivityStatus.create = vi.fn().mockResolvedValue({});

      // Cause 5 failures to open circuit
      const networkError = new Error("ECONNREFUSED");
      mockCloudflare.zones.list.mockRejectedValue(networkError);

      for (let i = 0; i < 5; i++) {
        await cloudflareConfigService.validate();
      }

      // Circuit should be open
      let result = await cloudflareConfigService.validate();
      expect(result.errorCode).toBe("CIRCUIT_BREAKER_OPEN");

      // Advance time by 4 minutes (less than cooldown)
      vi.advanceTimersByTime(4 * 60 * 1000);

      // Circuit should still be open
      result = await cloudflareConfigService.validate();
      expect(result.errorCode).toBe("CIRCUIT_BREAKER_OPEN");

      // Advance time by 2 more minutes (total 6 minutes, past cooldown)
      vi.advanceTimersByTime(2 * 60 * 1000);

      // Now mock a successful response for half-open test
      mockSuccessfulApis();

      // Circuit should transition to half-open and allow request
      result = await cloudflareConfigService.validate();
      expect(result.isValid).toBe(true);

      // Circuit should be fully closed after success
      result = await cloudflareConfigService.validate();
      expect(result.isValid).toBe(true);

      vi.useRealTimers();
    });

    it("should reset circuit breaker when new API token is set", async () => {
      mockStoredSettings("bad-token");
      mockPrisma.connectivityStatus.create = vi.fn().mockResolvedValue({});

      // Cause failures to open circuit
      const networkError = new Error("ECONNREFUSED");
      mockCloudflare.zones.list.mockRejectedValue(networkError);

      for (let i = 0; i < 5; i++) {
        await cloudflareConfigService.validate();
      }

      // Circuit should be open
      let result = await cloudflareConfigService.validate();
      expect(result.errorCode).toBe("CIRCUIT_BREAKER_OPEN");

      // Set new API token
      const parentSetSpy = vi.spyOn(
        Object.getPrototypeOf(Object.getPrototypeOf(cloudflareConfigService)),
        "set",
      );
      parentSetSpy.mockResolvedValue(undefined);

      await cloudflareConfigService.setApiToken(
        "new-valid-token-12345678901234567890",
        "user1",
      );

      // Mock successful response with new token
      mockStoredSettings("new-valid-token-12345678901234567890");
      mockSuccessfulApis();

      // Circuit should be reset and allow request
      result = await cloudflareConfigService.validate();
      expect(result.isValid).toBe(true);
      expect(result.errorCode).toBeUndefined();

      parentSetSpy.mockRestore();
    });
  });

  describe("removeConfiguration", () => {
    it("should remove both API token and account ID", async () => {
      const parentDeleteSpy = vi.spyOn(
        Object.getPrototypeOf(Object.getPrototypeOf(cloudflareConfigService)),
        "delete",
      );
      parentDeleteSpy.mockResolvedValue(undefined);

      const parentGetSpy = vi.spyOn(
        Object.getPrototypeOf(Object.getPrototypeOf(cloudflareConfigService)),
        "get",
      );
      parentGetSpy.mockResolvedValue("old-account-id");

      mockPrisma.connectivityStatus.create = vi.fn().mockResolvedValue({});

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
      const parentDeleteSpy = vi.spyOn(
        Object.getPrototypeOf(Object.getPrototypeOf(cloudflareConfigService)),
        "delete",
      );
      parentDeleteSpy
        .mockRejectedValueOnce(new Error("Token not found"))
        .mockRejectedValueOnce(new Error("Account ID not found"));

      const parentGetSpy = vi.spyOn(
        Object.getPrototypeOf(Object.getPrototypeOf(cloudflareConfigService)),
        "get",
      );
      parentGetSpy.mockResolvedValue(null);

      mockPrisma.connectivityStatus.create = vi.fn().mockResolvedValue({});

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
