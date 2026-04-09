import { HttpError } from "../lib/http-client";
import {
  HealthCheckService,
  HealthCheckConfig,
  HealthCheckResult,
} from "../services/health-check";

// Mock logger factory
vi.mock("../lib/logger-factory.ts", () => ({
  servicesLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  })),
  default: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  })),
}));

describe("HealthCheckService", () => {
  let healthCheckService: HealthCheckService;
  let mockStartTime: number;
  let mockGet: ReturnType<typeof vi.fn>;
  let mockPost: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    healthCheckService = new HealthCheckService();
    vi.clearAllMocks();

    // Replace httpClient methods with mocks
    mockGet = vi.fn();
    mockPost = vi.fn();
    (healthCheckService as any).httpClient.get = mockGet;
    (healthCheckService as any).httpClient.post = mockPost;

    // Mock Date.now() for consistent response time testing - default 150ms response
    mockStartTime = 1000;
    let callCount = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      // Alternate between start time and end time to simulate response time
      callCount++;
      return callCount % 2 === 1 ? mockStartTime : mockStartTime + 150;
    });

    // Mock the sleep function to avoid real delays
    vi.spyOn(healthCheckService as any, 'sleep').mockImplementation(async () => {
      // Return immediately instead of waiting
      return Promise.resolve();
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  // Helper function to create a mock HTTP response
  const createMockResponse = (
    status: number,
    data: any = "OK",
  ) => ({
    data,
    status,
    statusText: `Status ${status}`,
  });

  // Helper function to create a mock HttpError (network error, no response)
  const createMockNetworkError = (
    code: string,
    message: string = "Network Error"
  ): HttpError => {
    return new HttpError(message, { code });
  };

  describe("Basic Health Checks", () => {
    it("should perform successful basic health check", async () => {
      const mockResponse = createMockResponse(200, "OK");
      mockGet.mockResolvedValueOnce(mockResponse);

      const result = await healthCheckService.performBasicHealthCheck(
        "http://example.com/health"
      );

      expect(result.success).toBe(true);
      expect(result.statusCode).toBe(200);
      expect(typeof result.responseTime).toBe("number");
      expect(result.responseTime).toBeGreaterThanOrEqual(0);
      expect(result.responseBody).toBe("OK");
      expect(result.errorMessage).toBeUndefined();

      expect(mockGet).toHaveBeenCalledWith(
        "http://example.com/health",
        expect.objectContaining({
          timeout: 5000,
          validateStatus: expect.any(Function),
        }),
      );
    });

    it("should fail basic health check for non-200 status", async () => {
      // Reset Date.now() mock for this specific test
      vi.spyOn(Date, 'now').mockRestore();
      let callCount = 0;
      vi.spyOn(Date, 'now').mockImplementation(() => {
        callCount++;
        return callCount % 2 === 1 ? mockStartTime : mockStartTime + 150;
      });

      const mockResponse = createMockResponse(500, "Internal Server Error");
      mockGet.mockResolvedValueOnce(mockResponse);

      const result = await healthCheckService.performBasicHealthCheck(
        "http://example.com/health"
      );

      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(500);
      expect(result.errorMessage).toContain("Health check failed validation");
    });

    it("should handle connection errors", async () => {
      // Reset Date.now() mock for this specific test
      vi.spyOn(Date, 'now').mockRestore();
      let callCount = 0;
      vi.spyOn(Date, 'now').mockImplementation(() => {
        callCount++;
        return callCount % 2 === 1 ? mockStartTime : mockStartTime + 150;
      });

      const error = createMockNetworkError("ECONNREFUSED", "Connection refused");
      mockGet.mockRejectedValueOnce(error);

      const result = await healthCheckService.performBasicHealthCheck(
        "http://example.com/health"
      );

      expect(result.success).toBe(false);
      expect(result.statusCode).toBeUndefined();
      expect(result.errorMessage).toContain("service may be down");
      expect(typeof result.responseTime).toBe("number");
      expect(result.responseTime).toBeGreaterThanOrEqual(0);
    });

    it("should handle timeout errors", async () => {
      // Reset Date.now() mock for this specific test
      vi.spyOn(Date, 'now').mockRestore();
      let callCount = 0;
      vi.spyOn(Date, 'now').mockImplementation(() => {
        callCount++;
        return callCount % 2 === 1 ? mockStartTime : mockStartTime + 150;
      });

      const error = createMockNetworkError("ETIMEDOUT", "Request timeout");
      mockGet.mockRejectedValueOnce(error);

      const result = await healthCheckService.performBasicHealthCheck(
        "http://example.com/health"
      );

      expect(result.success).toBe(false);
      expect(result.errorMessage).toContain("Request timeout after");
    });

    it("should handle DNS resolution errors", async () => {
      // Reset Date.now() mock for this specific test
      vi.spyOn(Date, 'now').mockRestore();
      let callCount = 0;
      vi.spyOn(Date, 'now').mockImplementation(() => {
        callCount++;
        return callCount % 2 === 1 ? mockStartTime : mockStartTime + 150;
      });

      const error = createMockNetworkError("ENOTFOUND", "DNS resolution failed");
      mockGet.mockRejectedValueOnce(error);

      const result = await healthCheckService.performBasicHealthCheck(
        "http://example.com/health"
      );

      expect(result.success).toBe(false);
      expect(result.errorMessage).toContain("hostname not found");
    });
  });

  describe("Comprehensive Health Checks", () => {
    it("should perform successful comprehensive health check", async () => {
      const mockResponse = createMockResponse(200, { status: "healthy" });
      mockGet.mockResolvedValueOnce(mockResponse);

      const config: HealthCheckConfig = {
        endpoint: "http://example.com/health",
        method: "GET",
        expectedStatuses: [200, 201],
        responseBodyPattern: "healthy",
        responseTimeThreshold: 5000,
      };

      const result = await healthCheckService.performComprehensiveHealthCheck(config);

      expect(result.success).toBe(true);
      expect(result.statusCode).toBe(200);
      expect(result.validationDetails).toEqual({
        statusCode: true,
        bodyPattern: true,
        responseTime: true,
      });
    });

    it("should validate status codes correctly", async () => {
      const mockResponse = createMockResponse(201, "Created");
      mockGet.mockResolvedValueOnce(mockResponse);

      const config: HealthCheckConfig = {
        endpoint: "http://example.com/health",
        expectedStatuses: [200, 201, 202],
      };

      const result = await healthCheckService.performComprehensiveHealthCheck(config);

      expect(result.success).toBe(true);
      expect(result.validationDetails?.statusCode).toBe(true);
    });

    it("should fail validation for unexpected status code", async () => {
      // Reset Date.now() mock for this specific test
      vi.spyOn(Date, 'now').mockRestore();
      let callCount = 0;
      vi.spyOn(Date, 'now').mockImplementation(() => {
        callCount++;
        return callCount % 2 === 1 ? mockStartTime : mockStartTime + 150;
      });

      const mockResponse = createMockResponse(404, "Not Found");
      mockGet.mockResolvedValueOnce(mockResponse);

      const config: HealthCheckConfig = {
        endpoint: "http://example.com/health",
        expectedStatuses: [200, 201],
      };

      const result = await healthCheckService.performComprehensiveHealthCheck(config);

      expect(result.success).toBe(false);
      expect(result.validationDetails?.statusCode).toBe(false);
      expect(result.errorMessage).toContain("statusCode");
    });

    it("should validate response body patterns", async () => {
      const mockResponse = createMockResponse(200, '{"status":"healthy","uptime":123}');
      mockGet.mockResolvedValueOnce(mockResponse);

      const config: HealthCheckConfig = {
        endpoint: "http://example.com/health",
        responseBodyPattern: '"status":"healthy"',
      };

      const result = await healthCheckService.performComprehensiveHealthCheck(config);

      expect(result.success).toBe(true);
      expect(result.validationDetails?.bodyPattern).toBe(true);
    });

    it("should fail validation for non-matching body pattern", async () => {
      // Reset Date.now() mock for this specific test
      vi.spyOn(Date, 'now').mockRestore();
      let callCount = 0;
      vi.spyOn(Date, 'now').mockImplementation(() => {
        callCount++;
        return callCount % 2 === 1 ? mockStartTime : mockStartTime + 150;
      });

      const mockResponse = createMockResponse(200, '{"status":"unhealthy"}');
      mockGet.mockResolvedValueOnce(mockResponse);

      const config: HealthCheckConfig = {
        endpoint: "http://example.com/health",
        responseBodyPattern: '"status":"healthy"',
      };

      const result = await healthCheckService.performComprehensiveHealthCheck(config);

      expect(result.success).toBe(false);
      expect(result.validationDetails?.bodyPattern).toBe(false);
    });

    it("should validate response time threshold", async () => {
      const mockResponse = createMockResponse(200, "OK");

      // Mock slow response time (200ms)
      vi.spyOn(Date, 'now').mockRestore();
      vi.spyOn(Date, 'now')
        .mockReturnValueOnce(1000) // Start time
        .mockReturnValueOnce(1200); // End time (200ms response)

      mockGet.mockResolvedValueOnce(mockResponse);

      const config: HealthCheckConfig = {
        endpoint: "http://example.com/health",
        responseTimeThreshold: 50, // Very low threshold
      };

      const result = await healthCheckService.performComprehensiveHealthCheck(config);

      expect(result.success).toBe(false);
      expect(result.validationDetails?.responseTime).toBe(false);
      expect(typeof result.responseTime).toBe("number");
      expect(result.responseTime).toBeGreaterThanOrEqual(0);
    });

    it("should handle invalid regex patterns gracefully", async () => {
      // Reset Date.now() mock for this specific test
      vi.spyOn(Date, 'now').mockRestore();
      let callCount = 0;
      vi.spyOn(Date, 'now').mockImplementation(() => {
        callCount++;
        return callCount % 2 === 1 ? mockStartTime : mockStartTime + 150;
      });

      const mockResponse = createMockResponse(200, "OK");
      mockGet.mockResolvedValueOnce(mockResponse);

      const config: HealthCheckConfig = {
        endpoint: "http://example.com/health",
        responseBodyPattern: "[invalid regex",
      };

      const result = await healthCheckService.performComprehensiveHealthCheck(config);

      expect(result.success).toBe(false);
      expect(result.validationDetails?.bodyPattern).toBe(false);
    });

  });

  describe("Retry Logic", () => {
    it("should retry failed requests", async () => {
      const error = createMockNetworkError("ECONNREFUSED");
      const mockResponse = createMockResponse(200, "OK");

      // First two calls fail, third succeeds
      mockGet
        .mockRejectedValueOnce(error)
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce(mockResponse);

      const config: HealthCheckConfig = {
        endpoint: "http://example.com/health",
        retries: 2,
        retryDelay: 10, // Short delay for testing
      };

      const result = await healthCheckService.performHealthCheck(config);

      expect(result.success).toBe(true);
      expect(mockGet).toHaveBeenCalledTimes(3);
    });

    it("should fail after all retries exhausted", async () => {
      const error = createMockNetworkError("ECONNREFUSED");
      mockGet.mockRejectedValue(error);

      const config: HealthCheckConfig = {
        endpoint: "http://example.com/health",
        retries: 2,
        retryDelay: 10,
      };

      const result = await healthCheckService.performHealthCheck(config);

      expect(result.success).toBe(false);
      expect(mockGet).toHaveBeenCalledTimes(3); // Initial + 2 retries
    });

    it("should use exponential backoff for retries", async () => {
      const error = createMockNetworkError("ECONNREFUSED");
      mockGet.mockRejectedValue(error);

      const config: HealthCheckConfig = {
        endpoint: "http://example.com/health",
        retries: 2,
        retryDelay: 100,
      };

      // Mock Date.now calls for multiple attempts
      vi.spyOn(Date, 'now')
        .mockReturnValueOnce(1000).mockReturnValueOnce(1150) // First attempt (150ms)
        .mockReturnValueOnce(2000).mockReturnValueOnce(2150) // Second attempt (150ms)
        .mockReturnValueOnce(3000).mockReturnValueOnce(3150); // Third attempt (150ms)

      const result = await healthCheckService.performHealthCheck(config);

      expect(result.success).toBe(false);
      expect(mockGet).toHaveBeenCalledTimes(3); // Initial + 2 retries
    });

    it("should not retry on successful first attempt", async () => {
      const mockResponse = createMockResponse(200, "OK");
      mockGet.mockResolvedValueOnce(mockResponse);

      const config: HealthCheckConfig = {
        endpoint: "http://example.com/health",
        retries: 3,
      };

      const result = await healthCheckService.performHealthCheck(config);

      expect(result.success).toBe(true);
      expect(mockGet).toHaveBeenCalledTimes(1);
    });
  });

  describe("Circuit Breaker", () => {
    it("should open circuit breaker after consecutive failures", async () => {
      // Reset Date.now() mock to allow circuit breaker timing to work properly
      vi.spyOn(Date, 'now').mockRestore();

      const error = createMockNetworkError("ECONNREFUSED");
      mockGet.mockRejectedValue(error);

      const config: HealthCheckConfig = {
        endpoint: "http://example.com/health",
        retries: 0, // No retries to make testing simpler
      };

      // Make 5 consecutive failed requests (threshold)
      for (let i = 0; i < 5; i++) {
        await healthCheckService.performHealthCheck(config);
      }

      // Circuit breaker should now be open
      const status = healthCheckService.getCircuitBreakerStatus(config.endpoint);
      expect(status.state).toBe("open");
      expect(status.consecutiveFailures).toBe(5);

      // Next request should be blocked
      const result = await healthCheckService.performHealthCheck(config);
      expect(result.success).toBe(false);
      expect(result.errorMessage).toContain("Circuit breaker open");

      // mockGet should not be called for the blocked request
      expect(mockGet).toHaveBeenCalledTimes(5);
    });

    it("should transition to half-open after cooldown period", async () => {
      const error = createMockNetworkError("ECONNREFUSED");
      mockGet.mockRejectedValue(error);

      const config: HealthCheckConfig = {
        endpoint: "http://example.com/health",
        retries: 0,
      };

      // Trigger circuit breaker
      for (let i = 0; i < 5; i++) {
        await healthCheckService.performHealthCheck(config);
      }

      // Simulate cooldown period by manipulating the circuit breaker state
      const key = (healthCheckService as any).getCircuitBreakerKey(config.endpoint);
      const circuitBreakers = (healthCheckService as any).circuitBreakers;
      const breaker = circuitBreakers.get(key);
      breaker.nextRetryTime = new Date(Date.now() - 1000); // Past time

      // Next request should attempt the call (half-open)
      mockGet.mockClear();
      mockGet.mockRejectedValueOnce(error);

      await healthCheckService.performHealthCheck(config);

      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it("should close circuit breaker on successful request", async () => {
      const error = createMockNetworkError("ECONNREFUSED");
      const mockResponse = createMockResponse(200, "OK");

      const config: HealthCheckConfig = {
        endpoint: "http://example.com/health",
        retries: 0,
      };

      // Make some failures first
      mockGet.mockRejectedValue(error);
      for (let i = 0; i < 3; i++) {
        await healthCheckService.performHealthCheck(config);
      }

      // Now make successful request
      mockGet.mockResolvedValueOnce(mockResponse);
      await healthCheckService.performHealthCheck(config);

      const status = healthCheckService.getCircuitBreakerStatus(config.endpoint);
      expect(status.state).toBe("closed");
      expect(status.consecutiveFailures).toBe(0);
    });

    it("should handle different endpoints independently", async () => {
      const error = createMockNetworkError("ECONNREFUSED");
      mockGet.mockRejectedValue(error);

      const config1: HealthCheckConfig = {
        endpoint: "http://example.com/health",
        retries: 0,
      };

      const config2: HealthCheckConfig = {
        endpoint: "http://other.com/health",
        retries: 0,
      };

      // Trigger circuit breaker for first endpoint only
      for (let i = 0; i < 5; i++) {
        await healthCheckService.performHealthCheck(config1);
      }

      const status1 = healthCheckService.getCircuitBreakerStatus(config1.endpoint);
      const status2 = healthCheckService.getCircuitBreakerStatus(config2.endpoint);

      expect(status1.state).toBe("open");
      expect(status2.state).toBe("closed");
    });

    it("should reset circuit breaker manually", async () => {
      const error = createMockNetworkError("ECONNREFUSED");
      mockGet.mockRejectedValue(error);

      const config: HealthCheckConfig = {
        endpoint: "http://example.com/health",
        retries: 0,
      };

      // Trigger circuit breaker
      for (let i = 0; i < 5; i++) {
        await healthCheckService.performHealthCheck(config);
      }

      expect(healthCheckService.getCircuitBreakerStatus(config.endpoint).state).toBe("open");

      // Reset manually
      healthCheckService.resetCircuitBreaker(config.endpoint);

      expect(healthCheckService.getCircuitBreakerStatus(config.endpoint).state).toBe("closed");
    });

    it("should get all circuit breaker statuses", async () => {
      const error = createMockNetworkError("ECONNREFUSED");
      mockGet.mockRejectedValue(error);

      const endpoints = [
        "http://example.com/health",
        "http://other.com/health",
        "http://third.com/health",
      ];

      // Create some failures for different endpoints
      for (const endpoint of endpoints) {
        for (let i = 0; i < 3; i++) {
          await healthCheckService.performHealthCheck({
            endpoint,
            retries: 0,
          });
        }
      }

      const allStatuses = healthCheckService.getAllCircuitBreakerStatuses();
      const keys = Object.keys(allStatuses);

      expect(keys.length).toBeGreaterThan(0);
      expect(keys.some(key => key.includes("example.com"))).toBe(true);
      expect(keys.some(key => key.includes("other.com"))).toBe(true);
      expect(keys.some(key => key.includes("third.com"))).toBe(true);
    });
  });

  describe("Progressive Health Checks", () => {
    it("should perform basic check first, then comprehensive", async () => {
      const mockResponse = createMockResponse(200, { status: "healthy" });
      mockGet.mockResolvedValue(mockResponse);

      const config: HealthCheckConfig = {
        endpoint: "http://example.com/health",
        responseBodyPattern: "healthy",
      };

      const result = await healthCheckService.performProgressiveHealthCheck(config);

      expect(result.success).toBe(true);
      expect(mockGet).toHaveBeenCalledTimes(2); // Basic + comprehensive
    });

    it("should stop at basic check if it fails", async () => {
      const error = createMockNetworkError("ECONNREFUSED");
      mockGet.mockRejectedValue(error);

      const config: HealthCheckConfig = {
        endpoint: "http://example.com/health",
        responseBodyPattern: "healthy",
      };

      const result = await healthCheckService.performProgressiveHealthCheck(config);

      expect(result.success).toBe(false);
      expect(mockGet).toHaveBeenCalledTimes(1); // Basic check with 0 retries
    });
  });

  describe("Utility Functions", () => {
    it("should convert health check result to validation result", () => {
      const healthResult: HealthCheckResult = {
        success: true,
        statusCode: 200,
        responseTime: 150,
        responseBody: "OK",
      };

      const validationResult = healthCheckService.convertToValidationResult(
        healthResult,
        "http://example.com/health"
      );

      expect(validationResult.isValid).toBe(true);
      expect(validationResult.message).toContain("Health check passed");
      expect(validationResult.responseTimeMs).toBe(150);
      expect(validationResult.errorCode).toBeUndefined();
      expect(validationResult.metadata).toEqual({
        endpoint: "http://example.com/health",
        statusCode: 200,
        validationDetails: undefined,
      });
    });

    it("should convert failed health check result to validation result", () => {
      const healthResult: HealthCheckResult = {
        success: false,
        responseTime: 5000,
        errorMessage: "Request timeout",
      };

      const validationResult = healthCheckService.convertToValidationResult(
        healthResult,
        "http://example.com/health"
      );

      expect(validationResult.isValid).toBe(false);
      expect(validationResult.message).toBe("Request timeout");
      expect(validationResult.errorCode).toBe("HEALTH_CHECK_FAILED");
      expect(validationResult.responseTimeMs).toBe(5000);
    });
  });

  describe("Error Handling", () => {
    it("should handle different http error types correctly", async () => {
      // Reset Date.now() mock for this specific test
      vi.spyOn(Date, 'now').mockRestore();
      let callCount = 0;
      vi.spyOn(Date, 'now').mockImplementation(() => {
        callCount++;
        return callCount % 2 === 1 ? mockStartTime : mockStartTime + 150;
      });

      // Test ECONNRESET error
      const resetError = createMockNetworkError("ECONNRESET", "Connection reset");
      mockGet.mockRejectedValueOnce(resetError);

      const result1 = await healthCheckService.performBasicHealthCheck(
        "http://example.com/health"
      );

      expect(result1.success).toBe(false);
      expect(result1.errorMessage).toContain("Connection reset by server");

      // Test unknown error type
      const unknownError = createMockNetworkError("UNKNOWN_ERROR", "Network Error");
      mockGet.mockRejectedValueOnce(unknownError);

      const result2 = await healthCheckService.performBasicHealthCheck(
        "http://example.com/health2"
      );

      expect(result2.success).toBe(false);
      expect(result2.errorMessage).toBe("Network Error");
    });

    it("should handle non-http errors", async () => {
      // Reset Date.now() mock for this specific test
      vi.spyOn(Date, 'now').mockRestore();
      let callCount = 0;
      vi.spyOn(Date, 'now').mockImplementation(() => {
        callCount++;
        return callCount % 2 === 1 ? mockStartTime : mockStartTime + 150;
      });

      const error = new Error("Generic error");
      mockGet.mockRejectedValueOnce(error);

      const result = await healthCheckService.performBasicHealthCheck(
        "http://example.com/health"
      );

      expect(result.success).toBe(false);
      expect(result.errorMessage).toBe("Generic error");
    });
  });

  describe("Configuration Defaults", () => {
    it("should use default values when not specified", async () => {
      const mockResponse = createMockResponse(200, "OK");
      mockGet.mockResolvedValueOnce(mockResponse);

      const config: HealthCheckConfig = {
        endpoint: "http://example.com/health",
      };

      await healthCheckService.performHealthCheck(config);

      expect(mockGet).toHaveBeenCalledWith(
        "http://example.com/health",
        expect.objectContaining({
          timeout: 10000,
        })
      );
    });

    it("should override defaults with provided values", async () => {
      const mockResponse = createMockResponse(200, "OK");
      mockGet.mockResolvedValueOnce(mockResponse);

      const config: HealthCheckConfig = {
        endpoint: "http://example.com/health",
        method: "GET",
        timeout: 5000,
        headers: { "Content-Type": "application/json" },
      };

      await healthCheckService.performHealthCheck(config);

      expect(mockGet).toHaveBeenCalledWith(
        "http://example.com/health",
        expect.objectContaining({
          timeout: 5000,
          headers: { "Content-Type": "application/json" },
        })
      );
    });
  });
});
