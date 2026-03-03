import prisma from "../lib/prisma";
import { PrismaClient } from "@prisma/client";
import { createId } from "@paralleldrive/cuid2";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { securityConfig } from "../lib/security-config";

// Mock environment variables for testing
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "file:./test.db";
process.env.GOOGLE_CLIENT_ID = "test-google-client-id";
process.env.GOOGLE_CLIENT_SECRET = "test-google-client-secret";
process.env.LOG_LEVEL = "silent";

// Initialize security config for tests
securityConfig.setSessionSecret("test-session-secret-key-for-testing-only");
securityConfig.setApiKeySecret("test-api-key-secret-for-hashing");

// Global test Prisma client
let testPrisma: typeof prisma;

// Global setup
beforeAll(async () => {
  // Use worker ID to create separate test databases for parallel execution
  const workerId = process.env.VITEST_POOL_ID || "1";
  const testDbUrl = `file:./test-${workerId}.db`;
  const testDbPath = path.join(process.cwd(), `test-${workerId}.db`);

  // Remove existing test database if it exists
  if (fs.existsSync(testDbPath)) {
    fs.unlinkSync(testDbPath);
  }

  // Set the DATABASE_URL for this specific test worker
  process.env.DATABASE_URL = testDbUrl;

  // Use Prisma to push the schema to the test database
  try {
    execSync(`npx prisma db push --skip-generate --accept-data-loss`, {
      env: { ...process.env, DATABASE_URL: testDbUrl },
      stdio: "pipe", // Suppress output
    });
  } catch (error) {
    console.error("Failed to push Prisma schema to test database:", error);
    throw error;
  }

  testPrisma = new PrismaClient({
    datasources: {
      db: {
        url: testDbUrl,
      },
    },
  });
  await testPrisma.$connect();
});

// Global cleanup
afterAll(async () => {
  await testPrisma.$disconnect();
  // Clear security config
  securityConfig.clear();
});

// Clean up between tests
afterEach(async () => {
  // Clean up test data
  await testPrisma.apiKey.deleteMany();
  await testPrisma.user.deleteMany();
});

// Test utilities
export const createTestUser = async () => {
  const userId = createId();
  const user = await testPrisma.user.create({
    data: {
      id: userId,
      email: `${userId}@example.com`,
      name: `Test User ${userId}`,
      googleId: `google-${userId}`,
      image: `https://example.com/avatar/${userId}.jpg`,
    },
  });
  return user;
};

export const createTestApiKey = async (
  userId: string,
  name: string = "Test API Key",
) => {
  const keyId = createId();
  // Generate a valid mk_ prefixed API key for testing
  const testKey = `mk_${keyId.padEnd(64, '0')}`; // Pad to 64 chars to match real key format
  const apiKey = await testPrisma.apiKey.create({
    data: {
      id: keyId,
      name: name,
      key: testKey,
      userId: userId,
      active: true,
    },
  });
  return apiKey;
};

// Mock logger factory to silence logs during tests
vi.mock("../lib/logger-factory.ts", () => {
  const createMockLogger = () => {
    const logger: any = {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      trace: vi.fn(),
      silent: vi.fn(),
      child: vi.fn(() => logger),
      level: "info",
      levels: { values: { fatal: 60, error: 50, warn: 40, info: 30, debug: 20, trace: 10 } },
    };
    return logger;
  };
  return {
  createLogger: vi.fn(() => createMockLogger()),
  appLogger: vi.fn(() => createMockLogger()),
  httpLogger: vi.fn(() => createMockLogger()),
  prismaLogger: vi.fn(() => createMockLogger()),
  servicesLogger: vi.fn(() => createMockLogger()),
  dockerExecutorLogger: vi.fn(() => createMockLogger()),
  deploymentLogger: vi.fn(() => createMockLogger()),
  loadbalancerLogger: vi.fn(() => createMockLogger()),
  tlsLogger: vi.fn(() => createMockLogger()),
  agentLogger: vi.fn(() => createMockLogger()),
};
});

// Mock Passport for authentication tests
vi.mock("passport", () => ({
  default: {
    use: vi.fn(),
    initialize: vi.fn(() => (req: any, res: any, next: any) => next()),
    session: vi.fn(() => (req: any, res: any, next: any) => next()),
    authenticate: vi.fn(() => (req: any, res: any, next: any) => next()),
    serializeUser: vi.fn(),
    deserializeUser: vi.fn(),
  },
  use: vi.fn(),
  initialize: vi.fn(() => (req: any, res: any, next: any) => next()),
  session: vi.fn(() => (req: any, res: any, next: any) => next()),
  authenticate: vi.fn(() => (req: any, res: any, next: any) => next()),
  serializeUser: vi.fn(),
  deserializeUser: vi.fn(),
}));

export { testPrisma };
