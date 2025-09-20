import prisma from "../lib/prisma";
import { PrismaClient } from "@prisma/client";
import { jest } from "@jest/globals";
import { createId } from "@paralleldrive/cuid2";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

// Mock environment variables for testing
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "file:./test.db";
process.env.SESSION_SECRET = "test-session-secret-key-for-testing-only";
process.env.API_KEY_SECRET = "test-api-key-secret-for-hashing";
process.env.GOOGLE_CLIENT_ID = "test-google-client-id";
process.env.GOOGLE_CLIENT_SECRET = "test-google-client-secret";
process.env.LOG_LEVEL = "silent";

// Global test Prisma client
let testPrisma: typeof prisma;

// Global setup
beforeAll(async () => {
  // Use worker ID to create separate test databases for parallel execution
  const workerId = process.env.JEST_WORKER_ID || "1";
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
jest.mock("../lib/logger-factory.ts", () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  })),
  appLogger: jest.fn(() => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  })),
  httpLogger: jest.fn(() => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  })),
  prismaLogger: jest.fn(() => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  })),
  servicesLogger: jest.fn(() => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  })),
  dockerExecutorLogger: jest.fn(() => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  })),
  deploymentLogger: jest.fn(() => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  })),
  loadbalancerLogger: jest.fn(() => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  })),
}));

// Mock Passport for authentication tests
jest.mock("passport", () => ({
  use: jest.fn(),
  initialize: jest.fn(() => (req: any, res: any, next: any) => next()),
  session: jest.fn(() => (req: any, res: any, next: any) => next()),
  authenticate: jest.fn(() => (req: any, res: any, next: any) => next()),
  serializeUser: jest.fn(),
  deserializeUser: jest.fn(),
}));

export { testPrisma };
