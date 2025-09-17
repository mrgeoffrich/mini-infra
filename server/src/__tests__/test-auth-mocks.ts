/**
 * Reusable authentication mocks for testing
 *
 * This module provides standard authentication mocks that can be imported
 * by test files to properly mock the authentication middleware.
 */

export const mockAuthMiddleware = () => {
  // Mock auth middleware - need to mock the api-key-middleware functions that are re-exported through middleware/auth
  jest.mock("../lib/api-key-middleware", () => ({
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
  jest.mock("../lib/auth-middleware", () => ({
    getAuthenticatedUser: (req: any) => ({ id: "test-user-id", email: "test@example.com" }),
    requireAuth: (req: any, res: any, next: any) => {
      res.locals = {
        user: { id: "test-user-id" },
        requestId: "test-request-id",
      };
      next();
    }
  }));
};

// Mock logger functions that are commonly needed
export const mockLoggers = () => {
  jest.mock("../lib/logger-factory.ts", () => ({
    appLogger: jest.fn(() => ({
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
    })),
    servicesLogger: jest.fn(() => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    })),
    httpLogger: jest.fn(() => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    })),
    prismaLogger: jest.fn(() => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
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
};

export const TEST_USER_ID = "test-user-id";
export const TEST_USER_EMAIL = "test@example.com";
export const TEST_REQUEST_ID = "test-request-id";
export const TEST_KEY_ID = "test-key-id";