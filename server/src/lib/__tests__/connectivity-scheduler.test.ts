import { jest } from "@jest/globals";
import { PrismaClient } from "../../generated/prisma";
import { ConnectivityScheduler } from "../connectivity-scheduler";
import { ConfigurationServiceFactory } from "../../services/configuration-factory";
import { ValidationResult } from "@mini-infra/types";

// Mock logger
jest.mock("../../lib/logger", () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

// Mock ConfigurationServiceFactory
const mockConfigServiceFactory = {
  getSupportedCategories: jest.fn(),
  create: jest.fn(),
};

// Mock configuration services
const mockDockerService = {
  validate: jest.fn(),
};

const mockCloudflareService = {
  validate: jest.fn(),
};

const mockAzureService = {
  validate: jest.fn(),
};

jest.mock("../../services/configuration-factory", () => ({
  ConfigurationServiceFactory: jest
    .fn()
    .mockImplementation(() => mockConfigServiceFactory),
}));

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
  settingsAudit: {
    create: jest.fn(),
  },
} as unknown as PrismaClient;

// Import the mock after the jest.mock calls
import mockLogger from "../../lib/logger";

describe("ConnectivityScheduler", () => {
  let scheduler: ConnectivityScheduler;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

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

    scheduler = new ConnectivityScheduler(mockPrisma, 5000); // 5 second interval for testing
  });

  afterEach(() => {
    jest.useRealTimers();
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
      const defaultScheduler = new ConnectivityScheduler(mockPrisma);
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
      jest.advanceTimersByTime(5000);

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

      // Should not throw
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

      scheduler.start();

      // Trigger multiple failures
      for (let i = 0; i < 5; i++) {
        jest.advanceTimersByTime(5000);
        await new Promise((resolve) => setTimeout(resolve, 0));
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
    });

    it("should give up after maximum retry attempts", async () => {
      mockDockerService.validate.mockRejectedValue(
        new Error("Persistent failure"),
      );

      await scheduler.performHealthCheck("docker");

      // Should have tried 3 times (initial + 2 retries)
      expect(mockDockerService.validate).toHaveBeenCalledTimes(3);
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

      scheduler.start();
      jest.advanceTimersByTime(5000);

      // Allow async operations to complete
      await new Promise((resolve) => setTimeout(resolve, 0));

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
      const startTimes: number[] = [];
      const endTimes: number[] = [];

      mockDockerService.validate.mockImplementation(async () => {
        startTimes.push(Date.now());
        await new Promise((resolve) => setTimeout(resolve, 100));
        endTimes.push(Date.now());
        return { isValid: true, responseTimeMs: 100 };
      });

      mockCloudflareService.validate.mockImplementation(async () => {
        startTimes.push(Date.now());
        await new Promise((resolve) => setTimeout(resolve, 100));
        endTimes.push(Date.now());
        return { isValid: true, responseTimeMs: 100 };
      });

      mockAzureService.validate.mockImplementation(async () => {
        startTimes.push(Date.now());
        await new Promise((resolve) => setTimeout(resolve, 100));
        endTimes.push(Date.now());
        return { isValid: true, responseTimeMs: 100 };
      });

      scheduler.start();
      jest.advanceTimersByTime(5000);

      // Allow all async operations to complete
      await new Promise((resolve) => setTimeout(resolve, 200));

      // All services should start roughly at the same time
      const maxStartTimeDiff =
        Math.max(...startTimes) - Math.min(...startTimes);
      expect(maxStartTimeDiff).toBeLessThan(50); // Should be very close
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

      const newScheduler = new ConnectivityScheduler(mockPrisma, 5000);

      // Should still be able to start despite one service failing
      expect(() => newScheduler.start()).not.toThrow();
    });

    it("should handle validation timeouts", async () => {
      mockDockerService.validate.mockImplementation(
        () => new Promise(() => {}), // Never resolves (timeout)
      );

      const startTime = Date.now();
      await scheduler.performHealthCheck("docker");
      const endTime = Date.now();

      // Should have timed out quickly due to circuit breaker
      expect(endTime - startTime).toBeLessThan(1000);
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

      scheduler.start();
      jest.advanceTimersByTime(5000);

      // Allow async operations to complete
      await new Promise((resolve) => setTimeout(resolve, 0));

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
