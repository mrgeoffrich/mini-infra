import prisma from "../../lib/prisma";
import { PrismaClient } from "../../generated/prisma/client";
import { ConnectivityScheduler } from "../connectivity-scheduler";
import { ConfigurationServiceFactory } from "../../services/configuration-factory";
import { ValidationResult } from "@mini-infra/types";
import * as loggerFactory from "../../lib/logger-factory";

// Mock logger
vi.mock("../../lib/logger-factory", () => {
  const mockLoggerInstance = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  };

  return {
    createLogger: vi.fn(function() { return mockLoggerInstance; }),
    appLogger: vi.fn(function() { return mockLoggerInstance; }),
    servicesLogger: vi.fn(function() { return mockLoggerInstance; }),
    httpLogger: vi.fn(function() { return mockLoggerInstance; }),
    prismaLogger: vi.fn(function() { return mockLoggerInstance; }),
    dockerExecutorLogger: vi.fn(function() { return mockLoggerInstance; }),
    deploymentLogger: vi.fn(function() { return mockLoggerInstance; }),
    loadbalancerLogger: vi.fn(function() { return mockLoggerInstance; }),
    tlsLogger: vi.fn(function() { return mockLoggerInstance; }),
    default: vi.fn(function() { return mockLoggerInstance; }),
  };
});

// Hoist mock variables used inside vi.mock() factories
const { mockConfigServiceFactory } = vi.hoisted(() => ({
  mockConfigServiceFactory: {
    getSupportedCategories: vi.fn(),
    create: vi.fn(),
  },
}));

// Mock configuration services
const mockDockerService = {
  validate: vi.fn(),
};

const mockCloudflareService = {
  validate: vi.fn(),
};

const mockAzureService = {
  validate: vi.fn(),
};

vi.mock("../../services/configuration-factory", () => ({
  ConfigurationServiceFactory: vi
    .fn()
    .mockImplementation(function() { return mockConfigServiceFactory; }),
}));

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
  settingsAudit: {
    create: vi.fn(),
  },
} as unknown as typeof prisma;

// Import the mock after the vi.mock calls

describe("ConnectivityScheduler", () => {
  let scheduler: ConnectivityScheduler;
  let fakeDelayFn: Mock<(ms: number) => Promise<void>>;
  let mockLogger: any;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    // Get reference to the mocked logger after clearing mocks
    mockLogger = loggerFactory.appLogger();

    // Create a fake delay function that resolves immediately for tests
    fakeDelayFn = vi.fn().mockResolvedValue(undefined);

    // Setup mock factory to return supported categories
    mockConfigServiceFactory.getSupportedCategories.mockReturnValue([
      "docker",
      "cloudflare",
      "azure",
    ]);

    // Setup factory to return appropriate services
    mockConfigServiceFactory.create.mockImplementation(({ category }) => {
      switch (category) {
        case "docker":
          return mockDockerService;
        case "cloudflare":
          return mockCloudflareService;
        case "azure":
          return mockAzureService;
        default:
          throw new Error(`Unknown service: ${category}`);
      }
    });

    scheduler = new ConnectivityScheduler(
      mockPrisma as unknown as typeof prisma,
      5000,
      fakeDelayFn,
    ); // 5 second interval for testing
  });

  afterEach(() => {
    vi.useRealTimers();
    if (scheduler.isSchedulerRunning()) {
      scheduler.stop();
    }
  });

  describe("Constructor", () => {
    it("should initialize with correct parameters", () => {
      expect(scheduler.getCheckInterval()).toBe(5000);
      expect(scheduler.isSchedulerRunning()).toBe(false);
    });

    it("should initialize with default 5-minute interval", () => {
      const defaultScheduler = new ConnectivityScheduler(
        mockPrisma as unknown as typeof prisma,
      );
      expect(defaultScheduler.getCheckInterval()).toBe(5 * 60 * 1000);
    });

    it("should create monitors for all supported services", () => {
      expect(
        mockConfigServiceFactory.getSupportedCategories,
      ).toHaveBeenCalled();

      const monitoringInfo = scheduler.getMonitoringInfo();
      expect(monitoringInfo).toHaveLength(3);
      expect(monitoringInfo.map((info) => info.service)).toEqual(
        expect.arrayContaining(["docker", "cloudflare", "azure"]),
      );
    });

    it("should log initialization", () => {
      expect(mockLogger.info).toHaveBeenCalledWith(
        {
          services: ["docker", "cloudflare", "azure"],
          checkIntervalMs: 5000,
        },
        "ConnectivityScheduler initialized",
      );
    });
  });

  describe("start", () => {
    it("should start scheduler and perform initial health checks", () => {
      mockDockerService.validate.mockResolvedValue({
        isValid: true,
        responseTimeMs: 100,
      });
      mockCloudflareService.validate.mockResolvedValue({
        isValid: true,
        responseTimeMs: 200,
      });
      mockAzureService.validate.mockResolvedValue({
        isValid: true,
        responseTimeMs: 300,
      });

      scheduler.start();

      expect(scheduler.isSchedulerRunning()).toBe(true);
      expect(mockLogger.info).toHaveBeenCalledWith(
        "Starting ConnectivityScheduler",
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          checkIntervalMs: 5000,
          nextCheckAt: expect.any(String),
        }),
        "ConnectivityScheduler started successfully",
      );
    });

    it("should warn when trying to start already running scheduler", () => {
      scheduler.start();
      scheduler.start();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        "ConnectivityScheduler is already running",
      );
    });

    it("should schedule periodic health checks", () => {
      mockDockerService.validate.mockResolvedValue({
        isValid: true,
        responseTimeMs: 100,
      });
      mockCloudflareService.validate.mockResolvedValue({
        isValid: true,
        responseTimeMs: 200,
      });
      mockAzureService.validate.mockResolvedValue({
        isValid: true,
        responseTimeMs: 300,
      });

      scheduler.start();

      // Fast-forward to trigger interval
      vi.advanceTimersByTime(5000);

      expect(mockLogger.debug).toHaveBeenCalledWith(
        {
          serviceCount: 3,
        },
        "Starting health checks for all services",
      );
    });
  });

  describe("stop", () => {
    it("should stop running scheduler", () => {
      scheduler.start();
      expect(scheduler.isSchedulerRunning()).toBe(true);

      scheduler.stop();

      expect(scheduler.isSchedulerRunning()).toBe(false);
      expect(mockLogger.info).toHaveBeenCalledWith(
        "Stopping ConnectivityScheduler",
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        "ConnectivityScheduler stopped successfully",
      );
    });

    it("should warn when trying to stop non-running scheduler", () => {
      scheduler.stop();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        "ConnectivityScheduler is not running",
      );
    });
  });

  describe("performHealthCheck", () => {
    it("should perform health check for specific service", async () => {
      const validationResult: ValidationResult = {
        isValid: true,
        message: "Docker connection successful",
        responseTimeMs: 150,
      };

      mockDockerService.validate.mockResolvedValue(validationResult);

      await scheduler.performHealthCheck("docker");

      expect(mockConfigServiceFactory.create).toHaveBeenCalledWith({
        category: "docker",
      });
      expect(mockDockerService.validate).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(
        { service: "docker" },
        "Performing on-demand health check",
      );
    });

    it("should throw error for unsupported service", async () => {
      await expect(
        scheduler.performHealthCheck("unsupported" as any),
      ).rejects.toThrow("Unsupported service: unsupported");
    });

    it("should handle validation failures gracefully", async () => {
      const validationError = new Error("Docker connection failed");
      mockDockerService.validate.mockRejectedValue(validationError);

      // Should not throw - the method handles errors internally
      await expect(
        scheduler.performHealthCheck("docker"),
      ).resolves.toBeUndefined();

      expect(mockLogger.error).toHaveBeenCalledWith(
        {
          service: "docker",
          error: "Docker connection failed",
          circuitBreakerFailures: expect.any(Number),
        },
        "Service health check failed",
      );
    });
  });

  describe("Circuit breaker functionality", () => {
    it("should skip health checks when circuit breaker is open", async () => {
      // Simulate multiple failures to open circuit breaker
      const validationError = new Error("Service unavailable");
      mockDockerService.validate.mockRejectedValue(validationError);

      // Perform multiple health checks to trigger circuit breaker
      for (let i = 0; i < 5; i++) {
        await scheduler.performHealthCheck("docker");
      }

      // Circuit should be open now, check monitoring info
      const monitoringInfo = scheduler.getMonitoringInfo();
      const dockerMonitor = monitoringInfo.find((m) => m.service === "docker");

      expect(dockerMonitor?.circuitBreakerFailures).toBeGreaterThan(0);
    });
  });

  describe("Exponential backoff functionality", () => {
    it("should retry failed validations with exponential backoff", async () => {
      let attemptCount = 0;
      mockDockerService.validate.mockImplementation(() => {
        attemptCount++;
        if (attemptCount < 3) {
          return Promise.reject(new Error(`Attempt ${attemptCount} failed`));
        }
        return Promise.resolve({ isValid: true, responseTimeMs: 100 });
      });

      await scheduler.performHealthCheck("docker");

      // Should have retried and eventually succeeded
      expect(mockDockerService.validate).toHaveBeenCalledTimes(3);
      expect(fakeDelayFn).toHaveBeenCalled();
    });

    it("should give up after maximum retry attempts", async () => {
      mockDockerService.validate.mockRejectedValue(
        new Error("Persistent failure"),
      );

      await scheduler.performHealthCheck("docker");

      // Should have tried 3 times (initial + 2 retries)
      expect(mockDockerService.validate).toHaveBeenCalledTimes(3);
      expect(fakeDelayFn).toHaveBeenCalled();
    });
  });

  describe("Status tracking", () => {
    it("should track service statuses", async () => {
      mockDockerService.validate.mockResolvedValue({
        isValid: true,
        responseTimeMs: 100,
      });
      mockCloudflareService.validate.mockResolvedValue({
        isValid: false,
        responseTimeMs: 0,
      });
      mockAzureService.validate.mockResolvedValue({
        isValid: true,
        responseTimeMs: 200,
      });

      // Test by performing individual health checks instead of using the scheduler
      await scheduler.performHealthCheck("docker");
      await scheduler.performHealthCheck("cloudflare");
      await scheduler.performHealthCheck("azure");

      const statuses = scheduler.getServiceStatuses();
      expect(statuses.size).toBe(3);
      expect(statuses.has("docker")).toBe(true);
      expect(statuses.has("cloudflare")).toBe(true);
      expect(statuses.has("azure")).toBe(true);
    });

    it("should provide detailed monitoring information", () => {
      const monitoringInfo = scheduler.getMonitoringInfo();

      expect(monitoringInfo).toHaveLength(3);
      expect(monitoringInfo[0]).toMatchObject({
        service: expect.any(String),
        status: expect.any(String),
        circuitBreakerState: expect.any(String),
        circuitBreakerFailures: expect.any(Number),
      });
    });
  });

  describe("Parallel execution", () => {
    it("should execute all health checks in parallel", async () => {
      let callCount = 0;

      const createMockValidate = (service: string) =>
        vi.fn().mockImplementation(async () => {
          callCount++;
          return { isValid: true, responseTimeMs: 100 };
        });

      mockDockerService.validate = createMockValidate("docker");
      mockCloudflareService.validate = createMockValidate("cloudflare");
      mockAzureService.validate = createMockValidate("azure");

      // Trigger a single health check cycle manually
      await scheduler["performAllHealthChecks"]();

      // All three services should have been called
      expect(mockDockerService.validate).toHaveBeenCalled();
      expect(mockCloudflareService.validate).toHaveBeenCalled();
      expect(mockAzureService.validate).toHaveBeenCalled();
      expect(callCount).toBe(3);
    });
  });

  describe("Error handling", () => {
    it("should handle service creation failures", async () => {
      mockConfigServiceFactory.create.mockImplementation(({ category }) => {
        if (category === "docker") {
          throw new Error("Service creation failed");
        }
        return mockCloudflareService;
      });

      const newScheduler = new ConnectivityScheduler(
        mockPrisma as unknown as typeof prisma,
        5000,
      );

      // Should still be able to start despite one service failing
      expect(() => newScheduler.start()).not.toThrow();
    });

    it("should handle validation timeouts", async () => {
      // Mock a service that rejects with a timeout error
      mockDockerService.validate.mockRejectedValue(
        new Error("Connection timeout"),
      );

      // Should handle the timeout error gracefully
      await expect(
        scheduler.performHealthCheck("docker"),
      ).resolves.toBeUndefined();

      // Should have called the validate function
      expect(mockDockerService.validate).toHaveBeenCalled();
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          service: "docker",
          error: "Connection timeout",
        }),
        "Service health check failed",
      );
    });

    it("should log completion summary", async () => {
      mockDockerService.validate.mockResolvedValue({
        isValid: true,
        responseTimeMs: 100,
      });
      mockCloudflareService.validate.mockResolvedValue({
        isValid: false,
        responseTimeMs: 0,
      });
      mockAzureService.validate.mockResolvedValue({
        isValid: true,
        responseTimeMs: 200,
      });

      // Trigger health checks manually instead of using the scheduler
      await scheduler["performAllHealthChecks"]();

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          totalTimeMs: expect.any(Number),
          services: expect.arrayContaining([
            expect.objectContaining({
              service: expect.any(String),
              status: expect.any(String),
              circuitBreakerState: expect.any(String),
              circuitBreakerFailures: expect.any(Number),
            }),
          ]),
          nextCheckAt: expect.any(String),
        }),
        "Health check cycle completed",
      );
    });
  });
});
