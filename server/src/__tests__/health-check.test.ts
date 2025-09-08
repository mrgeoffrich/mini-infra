import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals";
import axios, { AxiosResponse, AxiosError } from "axios";
import {
  HealthCheckService,
  HealthCheckConfig,
  HealthCheckResult,
} from "../services/health-check";

// Mock axios
jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

// Mock logger factory
jest.mock("../lib/logger-factory.ts", () => ({
  servicesLogger: jest.fn(() => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  })),
  __esModule: true,
  default: jest.fn(() => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  })),
}));

describe("HealthCheckService", () => {
  let healthCheckService: HealthCheckService;

  beforeEach(() => {
    healthCheckService = new HealthCheckService();
    jest.clearAllMocks();
    
    // Setup axios defaults mock
    mockedAxios.defaults = {
      timeout: 10000,
    } as any;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // Helper function to create a mock axios response
  const createMockResponse = (
    status: number,
    data: any = "OK",
    headers: any = {}
  ): AxiosResponse => ({
    data,
    status,
    statusText: `Status ${status}`,
    headers,
    config: {} as any,
    request: {} as any,
  });

  // Helper function to create a mock axios error
  const createMockAxiosError = (
    code: string,
    message: string = "Network Error"
  ): AxiosError => {
    const error = new Error(message) as AxiosError;
    error.code = code;
    error.isAxiosError = true;
    error.name = "AxiosError";
    return error;
  };

  describe("Basic Health Checks", () => {
    it("should perform successful basic health check", async () => {
      const mockResponse = createMockResponse(200, "OK");
      mockedAxios.mockResolvedValueOnce(mockResponse);

      const result = await healthCheckService.performBasicHealthCheck(
        "http://example.com/health"
      );

      expect(result.success).toBe(true);
      expect(result.statusCode).toBe(200);
      expect(result.responseTime).toBeGreaterThan(0);
      expect(result.responseBody).toBe("OK");
      expect(result.errorMessage).toBeUndefined();

      expect(mockedAxios).toHaveBeenCalledWith({
        method: "GET",
        url: "http://example.com/health",
        headers: undefined,
        timeout: 5000,
        validateStatus: expect.any(Function),
        maxRedirects: 5,
      });
    });

    it("should fail basic health check for non-200 status", async () => {
      const mockResponse = createMockResponse(500, "Internal Server Error");
      mockedAxios.mockResolvedValueOnce(mockResponse);

      const result = await healthCheckService.performBasicHealthCheck(
        "http://example.com/health"
      );

      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(500);
      expect(result.errorMessage).toContain("Health check failed validation");
    });

    it("should handle connection errors", async () => {
      const error = createMockAxiosError("ECONNREFUSED", "Connection refused");
      mockedAxios.mockRejectedValueOnce(error);

      const result = await healthCheckService.performBasicHealthCheck(
        "http://example.com/health"
      );

      expect(result.success).toBe(false);
      expect(result.statusCode).toBeUndefined();
      expect(result.errorMessage).toContain("service may be down");
      expect(result.responseTime).toBeGreaterThan(0);
    });

    it("should handle timeout errors", async () => {
      const error = createMockAxiosError("ETIMEDOUT", "Request timeout");
      mockedAxios.mockRejectedValueOnce(error);

      const result = await healthCheckService.performBasicHealthCheck(
        "http://example.com/health"
      );

      expect(result.success).toBe(false);
      expect(result.errorMessage).toContain("Request timeout after");
    });

    it("should handle DNS resolution errors", async () => {
      const error = createMockAxiosError("ENOTFOUND", "DNS resolution failed");
      mockedAxios.mockRejectedValueOnce(error);

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
      mockedAxios.mockResolvedValueOnce(mockResponse);

      const config: HealthCheckConfig = {
        endpoint: "http://example.com/health",
        method: "GET",
        expectedStatuses: [200, 201],
        responseBodyPattern: "healthy",
        responseTimeThreshold: 5000,
        customValidation: "status === 200",
      };

      const result = await healthCheckService.performComprehensiveHealthCheck(config);

      expect(result.success).toBe(true);
      expect(result.statusCode).toBe(200);
      expect(result.validationDetails).toEqual({
        statusCode: true,
        bodyPattern: true,
        responseTime: true,
        customValidation: true,
      });
    });

    it("should validate status codes correctly", async () => {
      const mockResponse = createMockResponse(201, "Created");
      mockedAxios.mockResolvedValueOnce(mockResponse);

      const config: HealthCheckConfig = {
        endpoint: "http://example.com/health",
        expectedStatuses: [200, 201, 202],
      };

      const result = await healthCheckService.performComprehensiveHealthCheck(config);

      expect(result.success).toBe(true);
      expect(result.validationDetails?.statusCode).toBe(true);
    });

    it("should fail validation for unexpected status code", async () => {
      const mockResponse = createMockResponse(404, "Not Found");
      mockedAxios.mockResolvedValueOnce(mockResponse);

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
      mockedAxios.mockResolvedValueOnce(mockResponse);

      const config: HealthCheckConfig = {
        endpoint: "http://example.com/health",
        responseBodyPattern: '"status":"healthy"',
      };

      const result = await healthCheckService.performComprehensiveHealthCheck(config);

      expect(result.success).toBe(true);
      expect(result.validationDetails?.bodyPattern).toBe(true);
    });

    it("should fail validation for non-matching body pattern", async () => {
      const mockResponse = createMockResponse(200, '{"status":"unhealthy"}');
      mockedAxios.mockResolvedValueOnce(mockResponse);

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
      mockedAxios.mockImplementationOnce(() => {
        return new Promise((resolve) => {
          // Simulate slow response
          setTimeout(() => resolve(mockResponse), 100);
        });
      });

      const config: HealthCheckConfig = {
        endpoint: "http://example.com/health",
        responseTimeThreshold: 50, // Very low threshold
      };

      const result = await healthCheckService.performComprehensiveHealthCheck(config);

      expect(result.success).toBe(false);
      expect(result.validationDetails?.responseTime).toBe(false);
      expect(result.responseTime).toBeGreaterThan(50);
    });

    it("should execute custom validation successfully", async () => {
      const mockResponse = createMockResponse(200, { uptime: 1000, status: "ok" });
      mockedAxios.mockResolvedValueOnce(mockResponse);

      const config: HealthCheckConfig = {
        endpoint: "http://example.com/health",
        customValidation: "body.uptime > 500 && body.status === 'ok'",
      };

      const result = await healthCheckService.performComprehensiveHealthCheck(config);

      expect(result.success).toBe(true);
      expect(result.validationDetails?.customValidation).toBe(true);
    });

    it("should fail custom validation", async () => {
      const mockResponse = createMockResponse(200, { uptime: 100 });
      mockedAxios.mockResolvedValueOnce(mockResponse);

      const config: HealthCheckConfig = {
        endpoint: "http://example.com/health",
        customValidation: "body.uptime > 500",
      };

      const result = await healthCheckService.performComprehensiveHealthCheck(config);

      expect(result.success).toBe(false);
      expect(result.validationDetails?.customValidation).toBe(false);
    });

    it("should handle invalid regex patterns gracefully", async () => {
      const mockResponse = createMockResponse(200, "OK");
      mockedAxios.mockResolvedValueOnce(mockResponse);

      const config: HealthCheckConfig = {
        endpoint: "http://example.com/health",
        responseBodyPattern: "[invalid regex",
      };

      const result = await healthCheckService.performComprehensiveHealthCheck(config);

      expect(result.success).toBe(false);
      expect(result.validationDetails?.bodyPattern).toBe(false);
    }, 10000);

    it("should handle invalid custom validation expressions", async () => {
      const mockResponse = createMockResponse(200, "OK");
      mockedAxios.mockResolvedValueOnce(mockResponse);

      const config: HealthCheckConfig = {
        endpoint: "http://example.com/health",
        customValidation: "invalid.javascript.expression.that.throws",
      };

      const result = await healthCheckService.performComprehensiveHealthCheck(config);

      expect(result.success).toBe(false);
      expect(result.validationDetails?.customValidation).toBe(false);
    }, 10000);
  });

  describe("Retry Logic", () => {
    it("should retry failed requests", async () => {
      const error = createMockAxiosError("ECONNREFUSED");
      const mockResponse = createMockResponse(200, "OK");

      // First two calls fail, third succeeds
      mockedAxios
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
      expect(mockedAxios).toHaveBeenCalledTimes(3);
    });

    it("should fail after all retries exhausted", async () => {
      const error = createMockAxiosError("ECONNREFUSED");
      mockedAxios.mockRejectedValue(error);

      const config: HealthCheckConfig = {
        endpoint: "http://example.com/health",
        retries: 2,
        retryDelay: 10,
      };

      const result = await healthCheckService.performHealthCheck(config);

      expect(result.success).toBe(false);
      expect(mockedAxios).toHaveBeenCalledTimes(3); // Initial + 2 retries
    });

    it("should use exponential backoff for retries", async () => {
      const error = createMockAxiosError("ECONNREFUSED");
      mockedAxios.mockRejectedValue(error);

      const config: HealthCheckConfig = {
        endpoint: "http://example.com/health",
        retries: 2,
        retryDelay: 100,
      };

      const startTime = Date.now();
      await healthCheckService.performHealthCheck(config);
      const duration = Date.now() - startTime;

      // Should take at least 100ms + 200ms (exponential backoff)
      expect(duration).toBeGreaterThan(250);
    });

    it("should not retry on successful first attempt", async () => {
      const mockResponse = createMockResponse(200, "OK");
      mockedAxios.mockResolvedValueOnce(mockResponse);

      const config: HealthCheckConfig = {
        endpoint: "http://example.com/health",
        retries: 3,
      };

      const result = await healthCheckService.performHealthCheck(config);

      expect(result.success).toBe(true);
      expect(mockedAxios).toHaveBeenCalledTimes(1);
    });
  });

  describe("Circuit Breaker", () => {
    it("should open circuit breaker after consecutive failures", async () => {
      const error = createMockAxiosError("ECONNREFUSED");
      mockedAxios.mockRejectedValue(error);

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

      // Axios should not be called for the blocked request
      expect(mockedAxios).toHaveBeenCalledTimes(5);
    });

    it("should transition to half-open after cooldown period", async () => {
      const error = createMockAxiosError("ECONNREFUSED");
      mockedAxios.mockRejectedValue(error);

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
      mockedAxios.mockClear();
      mockedAxios.mockRejectedValueOnce(error);

      await healthCheckService.performHealthCheck(config);

      expect(mockedAxios).toHaveBeenCalledTimes(1);
    });

    it("should close circuit breaker on successful request", async () => {
      const error = createMockAxiosError("ECONNREFUSED");
      const mockResponse = createMockResponse(200, "OK");

      const config: HealthCheckConfig = {
        endpoint: "http://example.com/health",
        retries: 0,
      };

      // Make some failures first
      mockedAxios.mockRejectedValue(error);
      for (let i = 0; i < 3; i++) {
        await healthCheckService.performHealthCheck(config);
      }

      // Now make successful request
      mockedAxios.mockResolvedValueOnce(mockResponse);
      await healthCheckService.performHealthCheck(config);

      const status = healthCheckService.getCircuitBreakerStatus(config.endpoint);
      expect(status.state).toBe("closed");
      expect(status.consecutiveFailures).toBe(0);
    });

    it("should handle different endpoints independently", async () => {
      const error = createMockAxiosError("ECONNREFUSED");
      mockedAxios.mockRejectedValue(error);

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
      const error = createMockAxiosError("ECONNREFUSED");
      mockedAxios.mockRejectedValue(error);

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
      const error = createMockAxiosError("ECONNREFUSED");
      mockedAxios.mockRejectedValue(error);

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
      mockedAxios.mockResolvedValue(mockResponse);

      const config: HealthCheckConfig = {
        endpoint: "http://example.com/health",
        responseBodyPattern: "healthy",
      };

      const result = await healthCheckService.performProgressiveHealthCheck(config);

      expect(result.success).toBe(true);
      expect(mockedAxios).toHaveBeenCalledTimes(2); // Basic + comprehensive
    });

    it("should stop at basic check if it fails", async () => {
      const error = createMockAxiosError("ECONNREFUSED");
      mockedAxios.mockRejectedValue(error);

      const config: HealthCheckConfig = {
        endpoint: "http://example.com/health",
        responseBodyPattern: "healthy",
      };

      const result = await healthCheckService.performProgressiveHealthCheck(config);

      expect(result.success).toBe(false);
      expect(mockedAxios).toHaveBeenCalledTimes(2); // Basic check with 1 retry
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
    it("should handle different axios error types correctly", async () => {
      const testCases = [
        {
          code: "ECONNRESET",
          message: "Connection reset",
          expectedMessage: "Connection reset by server",
        },
        {
          code: "UNKNOWN_ERROR", 
          message: "Network Error",
          expectedMessage: "Network Error", // Should use original message for unknown errors
        },
      ];

      for (const testCase of testCases) {
        const error = createMockAxiosError(testCase.code, testCase.message);
        mockedAxios.mockRejectedValueOnce(error);

        const result = await healthCheckService.performBasicHealthCheck(
          "http://example.com/health"
        );

        expect(result.success).toBe(false);
        expect(result.errorMessage).toContain(testCase.expectedMessage);
      }
    });

    it("should handle non-axios errors", async () => {
      const error = new Error("Generic error");
      // Make sure it's not treated as axios error
      Object.defineProperty(error, 'isAxiosError', { value: false });
      mockedAxios.mockRejectedValueOnce(error);

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
      mockedAxios.mockResolvedValueOnce(mockResponse);

      const config: HealthCheckConfig = {
        endpoint: "http://example.com/health",
      };

      await healthCheckService.performHealthCheck(config);

      expect(mockedAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "GET",
          timeout: 10000,
        })
      );
    });

    it("should override defaults with provided values", async () => {
      const mockResponse = createMockResponse(200, "OK");
      mockedAxios.mockResolvedValueOnce(mockResponse);

      const config: HealthCheckConfig = {
        endpoint: "http://example.com/health",
        method: "POST",
        timeout: 5000,
        headers: { "Content-Type": "application/json" },
      };

      await healthCheckService.performHealthCheck(config);

      expect(mockedAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "POST",
          timeout: 5000,
          headers: { "Content-Type": "application/json" },
        })
      );
    });
  });
});