import { internalSecrets } from "../lib/security-config";
import {
  disconnectIntegrationTestDatabase,
  getWorkerTestDatabaseUrl,
  initializeIntegrationTestDatabase,
  resetWorkerIntegrationTestDatabase,
  truncateIntegrationTestDatabase,
} from "./integration-test-helpers";

// Mock environment variables for testing
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = getWorkerTestDatabaseUrl();
process.env.LOG_LEVEL = "silent";

// Initialize internal auth secret for tests
internalSecrets.setAuthSecret("test-secret-key-for-testing-only");

await resetWorkerIntegrationTestDatabase();
await initializeIntegrationTestDatabase();

afterAll(async () => {
  await disconnectIntegrationTestDatabase();
  internalSecrets.clear();
});

afterEach(async () => {
  await truncateIntegrationTestDatabase();
});

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
    getLogger: vi.fn((_component: string, _subcomponent?: string) => createMockLogger()),
    createLogger: vi.fn(() => createMockLogger()),
    appLogger: vi.fn(() => createMockLogger()),
    httpLogger: vi.fn(() => createMockLogger()),
    prismaLogger: vi.fn(() => createMockLogger()),
    servicesLogger: vi.fn(() => createMockLogger()),
    dockerExecutorLogger: vi.fn(() => createMockLogger()),
    deploymentLogger: vi.fn(() => createMockLogger()),
    loadbalancerLogger: vi.fn(() => createMockLogger()),
    selfBackupLogger: vi.fn(() => createMockLogger()),
    tlsLogger: vi.fn(() => createMockLogger()),
    agentLogger: vi.fn(() => createMockLogger()),
    clearLoggerCache: vi.fn(),
    createChildLogger: vi.fn(() => createMockLogger()),
    serializeError: (e: unknown) => e,
    default: vi.fn(() => createMockLogger()),
  };
});

// Mock logging context so ALS calls are no-ops in tests
vi.mock("../lib/logging-context.ts", () => ({
  runWithContext: <T>(_ctx: unknown, fn: () => T) => fn(),
  getContext: () => undefined,
  setUserId: vi.fn(),
  setOperationId: vi.fn(),
}));

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
