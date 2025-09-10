# Jest Mocking Patterns Guide

This guide describes advanced mocking patterns used in the health-check.test.ts file, providing reusable examples for testing complex services with external dependencies.

## Table of Contents

## Running Tests

To run a server tests for a single file: `cd server && npm test -- --testPathPatterns="docker-executor.test.ts"`

## External Library Mocking

### Axios HTTP Client Mocking

The most common pattern is mocking external HTTP libraries like axios:

```typescript
import axios, { AxiosResponse, AxiosError } from "axios";

// Mock the entire axios module
jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

// Mock specific axios methods that aren't automatically mocked
Object.defineProperty(axios, 'isAxiosError', {
  value: jest.fn((error: any) => {
    return error && error.isAxiosError === true;
  }),
  writable: true,
});
```

**Usage in tests:**

```typescript
it("should handle successful HTTP response", async () => {
  const mockResponse = createMockResponse(200, { status: "healthy" });
  mockedAxios.mockResolvedValueOnce(mockResponse);

  const result = await healthCheckService.performBasicHealthCheck("http://example.com/health");

  expect(result.success).toBe(true);
  expect(mockedAxios).toHaveBeenCalledWith({
    method: "GET",
    url: "http://example.com/health",
    timeout: 5000,
    // ... other expected options
  });
});
```

### Logger Factory Mocking

Mock logging to avoid console output and test log interactions:

```typescript
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
```

## Helper Functions for Mock Creation

Create reusable helper functions to generate consistent mock objects:

### HTTP Response Helper

```typescript
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
```

**Usage:**

```typescript
it("should handle different response status codes", async () => {
  const mockResponse = createMockResponse(201, { message: "Created" });
  mockedAxios.mockResolvedValueOnce(mockResponse);
  
  // Test your service method...
});
```

### HTTP Error Helper

```typescript
const createMockAxiosError = (
  code: string,
  message: string = "Network Error"
): AxiosError => {
  const error = new Error(message) as AxiosError;
  error.code = code;
  error.isAxiosError = true;
  error.name = "AxiosError";
  error.response = undefined; // No response for connection errors
  return error;
};
```

**Usage:**

```typescript
it("should handle connection timeout", async () => {
  const error = createMockAxiosError("ETIMEDOUT", "Request timeout");
  mockedAxios.mockRejectedValueOnce(error);
  
  const result = await healthCheckService.performBasicHealthCheck("http://example.com/health");
  
  expect(result.success).toBe(false);
  expect(result.errorMessage).toContain("Request timeout");
});
```

## Time and Date Mocking

### Consistent Response Time Testing

Mock `Date.now()` to control timing-dependent tests:

```typescript
beforeEach(() => {
  mockStartTime = 1000;
  let callCount = 0;
  
  jest.spyOn(Date, 'now').mockImplementation(() => {
    // Alternate between start time and end time to simulate response time
    callCount++;
    return callCount % 2 === 1 ? mockStartTime : mockStartTime + 150;
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});
```

### Custom Response Time Testing

For specific tests requiring different timings:

```typescript
it("should fail when response time exceeds threshold", async () => {
  // Override the default mock for this specific test
  jest.spyOn(Date, 'now').mockRestore();
  jest.spyOn(Date, 'now')
    .mockReturnValueOnce(1000) // Start time
    .mockReturnValueOnce(1200); // End time (200ms response)
  
  const result = await healthCheckService.performComprehensiveHealthCheck({
    endpoint: "http://example.com/health",
    responseTimeThreshold: 50, // Very low threshold
  });

  expect(result.success).toBe(false);
  expect(result.responseTime).toBe(200);
});
```

### Multiple Attempts Timing

For testing retry logic with different response times:

```typescript
it("should track response times across multiple attempts", async () => {
  // Mock Date.now calls for multiple attempts
  jest.spyOn(Date, 'now')
    .mockReturnValueOnce(1000).mockReturnValueOnce(1150) // First attempt (150ms)
    .mockReturnValueOnce(2000).mockReturnValueOnce(2150) // Second attempt (150ms)
    .mockReturnValueOnce(3000).mockReturnValueOnce(3150); // Third attempt (150ms)
    
  // Test retry logic...
});
```

## Private Method Mocking

Sometimes you need to mock private methods to avoid side effects:

```typescript
beforeEach(() => {
  // Mock the private sleep function to avoid real delays
  jest.spyOn(healthCheckService as any, 'sleep').mockImplementation(async () => {
    // Return immediately instead of waiting
    return Promise.resolve();
  });
});
```

**Accessing private properties for testing:**

```typescript
it("should transition to half-open after cooldown period", async () => {
  // Access private circuit breaker state
  const key = (healthCheckService as any).getCircuitBreakerKey(config.endpoint);
  const circuitBreakers = (healthCheckService as any).circuitBreakers;
  const breaker = circuitBreakers.get(key);
  
  // Manipulate private state for testing
  breaker.nextRetryTime = new Date(Date.now() - 1000); // Past time
  
  // Continue with test...
});
```

## Test Setup and Cleanup

### Comprehensive BeforeEach Setup

```typescript
beforeEach(() => {
  healthCheckService = new HealthCheckService();
  jest.clearAllMocks();
  
  // Setup axios defaults mock
  mockedAxios.defaults = {
    timeout: 10000,
  } as any;

  // Setup consistent Date.now mocking
  mockStartTime = 1000;
  let callCount = 0;
  jest.spyOn(Date, 'now').mockImplementation(() => {
    callCount++;
    return callCount % 2 === 1 ? mockStartTime : mockStartTime + 150;
  });

  // Mock async delays
  jest.spyOn(healthCheckService as any, 'sleep').mockImplementation(async () => {
    return Promise.resolve();
  });
});
```

### Proper Cleanup

```typescript
afterEach(() => {
  jest.clearAllMocks();
  jest.restoreAllMocks();
});
```

## Advanced Mock Control

### Sequential Mock Responses

Test retry logic with different responses per attempt:

```typescript
it("should retry failed requests", async () => {
  const error = createMockAxiosError("ECONNREFUSED");
  const mockResponse = createMockResponse(200, "OK");

  // First two calls fail, third succeeds
  mockedAxios
    .mockRejectedValueOnce(error)
    .mockRejectedValueOnce(error)
    .mockResolvedValueOnce(mockResponse);

  const result = await healthCheckService.performHealthCheck(config);

  expect(result.success).toBe(true);
  expect(mockedAxios).toHaveBeenCalledTimes(3);
});
```

### Mock Reset and Reuse

Clear previous mock calls while preserving mock setup:

```typescript
it("should handle different endpoints independently", async () => {
  // Test first endpoint
  for (let i = 0; i < 5; i++) {
    await healthCheckService.performHealthCheck(config1);
  }

  // Reset call count but keep mock setup
  mockedAxios.mockClear();
  mockedAxios.mockRejectedValueOnce(error);

  // Test second endpoint
  await healthCheckService.performHealthCheck(config2);

  expect(mockedAxios).toHaveBeenCalledTimes(1); // Only the last call
});
```

### Conditional Mock Behavior

Create mocks that behave differently based on input:

```typescript
beforeEach(() => {
  mockedAxios.mockImplementation((config) => {
    if (config.url.includes('timeout')) {
      return Promise.reject(createMockAxiosError("ETIMEDOUT"));
    }
    if (config.url.includes('notfound')) {
      return Promise.resolve(createMockResponse(404, "Not Found"));
    }
    return Promise.resolve(createMockResponse(200, "OK"));
  });
});
```

## Best Practices

1. **Use helper functions** for creating consistent mock objects
2. **Clear mocks** between tests to avoid test interdependencies
3. **Restore mocks** after each test to prevent side effects
4. **Mock time-dependent functions** for predictable timing tests
5. **Mock external dependencies** to isolate unit tests
6. **Use sequential mocks** to test complex retry and error handling logic
7. **Access private methods carefully** using `as any` only when necessary for testing

## Testing Different Error Scenarios

The mocking patterns allow comprehensive error scenario testing:

```typescript
describe("Error Handling", () => {
  const errorScenarios = [
    { code: "ECONNREFUSED", message: "Connection refused", expected: "service may be down" },
    { code: "ETIMEDOUT", message: "Request timeout", expected: "Request timeout after" },
    { code: "ENOTFOUND", message: "DNS resolution failed", expected: "hostname not found" },
    { code: "ECONNRESET", message: "Connection reset", expected: "Connection reset by server" },
  ];

  errorScenarios.forEach(({ code, message, expected }) => {
    it(`should handle ${code} errors`, async () => {
      const error = createMockAxiosError(code, message);
      mockedAxios.mockRejectedValueOnce(error);

      const result = await healthCheckService.performBasicHealthCheck("http://example.com/health");

      expect(result.success).toBe(false);
      expect(result.errorMessage).toContain(expected);
    });
  });
});
```

This comprehensive mocking approach ensures reliable, fast, and predictable unit tests while maintaining good coverage of error conditions and edge cases.