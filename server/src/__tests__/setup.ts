import { PrismaClient } from "../generated/prisma/index.js";
import { jest } from "@jest/globals";
import { createId } from "@paralleldrive/cuid2";

// Mock environment variables for testing
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "file:./test.db";
process.env.SESSION_SECRET = "test-session-secret-key-for-testing-only";
process.env.API_KEY_SECRET = "test-api-key-secret-for-hashing";
process.env.GOOGLE_CLIENT_ID = "test-google-client-id";
process.env.GOOGLE_CLIENT_SECRET = "test-google-client-secret";
process.env.LOG_LEVEL = "silent";

// Global test Prisma client
let testPrisma: PrismaClient;

// Global setup
beforeAll(async () => {
  testPrisma = new PrismaClient({
    datasources: {
      db: {
        url: "file:./test.db",
      },
    },
  });
  await testPrisma.$connect();

  // Ensure database schema exists - this will create the tables if they don't exist
  try {
    await testPrisma.$queryRaw`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT,
      image TEXT,
      googleId TEXT UNIQUE,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )`;

    await testPrisma.$queryRaw`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      sessionToken TEXT UNIQUE NOT NULL,
      userId TEXT NOT NULL,
      expires DATETIME NOT NULL,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (userId) REFERENCES users (id) ON DELETE CASCADE
    )`;

    await testPrisma.$queryRaw`CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      key TEXT UNIQUE NOT NULL,
      userId TEXT NOT NULL,
      active BOOLEAN DEFAULT 1,
      lastUsedAt DATETIME,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (userId) REFERENCES users (id) ON DELETE CASCADE
    )`;
  } catch (error) {
    // Tables may already exist, that's ok
    console.log("Database setup complete (tables may already exist)");
  }
});

// Global cleanup
afterAll(async () => {
  await testPrisma.$disconnect();
});

// Clean up between tests
afterEach(async () => {
  // Clean up test data
  await testPrisma.session.deleteMany();
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
  const apiKey = await testPrisma.apiKey.create({
    data: {
      id: keyId,
      name: name,
      key: `test-key-${keyId}`,
      userId: userId,
      active: true,
    },
  });
  return apiKey;
};

export const createTestSession = async (userId: string) => {
  const sessionId = createId();
  const session = await testPrisma.session.create({
    data: {
      id: sessionId,
      sessionToken: `test-session-${sessionId}`,
      userId: userId,
      expires: new Date(Date.now() + 1000 * 60 * 60 * 24), // 24 hours
    },
  });
  return session;
};

// Mock logger to silence logs during tests
jest.mock("../lib/logger.ts", () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
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
