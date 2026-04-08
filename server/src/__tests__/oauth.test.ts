import { testPrisma, createTestUser } from "./setup";
import type { GoogleOAuthProfile } from "@mini-infra/types";

// Store reference to testPrisma that persists across resetModules
const { prismaRef } = vi.hoisted(() => ({
  prismaRef: { current: null as any },
}));

// Capture the verify callback when GoogleStrategy is constructed
const { verifyCallbackRef } = vi.hoisted(() => ({
  verifyCallbackRef: { current: null as any },
}));

// Mock passport and logger before importing the module
vi.mock("passport", () => ({
  use: vi.fn(),
  serializeUser: vi.fn(),
  deserializeUser: vi.fn(),
  default: {
    use: vi.fn(),
    serializeUser: vi.fn(),
    deserializeUser: vi.fn(),
  },
}));

vi.mock("../lib/logger-factory.ts", () => {
  const mockLoggerInstance = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  };
  return {
    createLogger: vi.fn(function() { return mockLoggerInstance; }),
    appLogger: vi.fn(function() { return mockLoggerInstance; }),
    httpLogger: vi.fn(function() { return mockLoggerInstance; }),
    prismaLogger: vi.fn(function() { return mockLoggerInstance; }),
    servicesLogger: vi.fn(function() { return mockLoggerInstance; }),
    dockerExecutorLogger: vi.fn(function() { return mockLoggerInstance; }),
    deploymentLogger: vi.fn(function() { return mockLoggerInstance; }),
    loadbalancerLogger: vi.fn(function() { return mockLoggerInstance; }),
    tlsLogger: vi.fn(function() { return mockLoggerInstance; }),
    agentLogger: vi.fn(function() { return mockLoggerInstance; }),
    default: vi.fn(function() { return mockLoggerInstance; }),
  };
});

vi.mock("../lib/config.ts", () => ({
  APP_SECRET: "test-secret",
  default: {
    APP_SECRET: "test-secret",
  },
}));

// Mock config-new which passport.ts imports
vi.mock("../lib/config-new", () => ({
  authConfig: {
    appSecret: "test-secret",
    allowedEmails: ["test@example.com", "existing@example.com"],
  },
  serverConfig: {
    nodeEnv: "test",
    port: 5005,
    publicUrl: "http://localhost:5005",
  },
  default: {},
}));

// Mock prisma to use our test instance
vi.mock("../lib/prisma.ts", () => ({
  default: prismaRef.current,
}));

// Mock passport-google-oauth20 to capture the verify callback
vi.mock("passport-google-oauth20", () => ({
  Strategy: vi.fn().mockImplementation(function(_options: any, callback: any) {
    verifyCallbackRef.current = callback;
    return { name: "google", _verify: callback };
  }),
}));

describe("OAuth Strategy and Callback Handling", () => {
  let mockDone: MockedFunction<any>;

  beforeEach(async () => {
    mockDone = vi.fn();
    vi.clearAllMocks();
    verifyCallbackRef.current = null;

    // Set the prisma reference so the mock uses the real test database
    prismaRef.current = testPrisma;

    // Clean up any existing users to ensure test isolation
    await testPrisma.apiKey.deleteMany();
    await testPrisma.passwordResetToken.deleteMany();
    await testPrisma.user.deleteMany();
  });

  /**
   * Helper: import passport and call configureGoogleStrategy to register
   * the strategy (which captures the verify callback via our mock).
   */
  async function setupStrategy() {
    vi.resetModules();
    const passportModule = await import("../lib/passport");
    passportModule.configureGoogleStrategy("test-client-id", "test-client-secret");
    return verifyCallbackRef.current;
  }

  describe("Google OAuth Strategy Callback", () => {
    const mockProfile: GoogleOAuthProfile = {
      id: "google-test-123",
      displayName: "Test User",
      emails: [{ value: "test@example.com", verified: true }],
      photos: [{ value: "https://example.com/avatar.jpg" }],
      provider: "google",
    };

    it("should create a new user when no existing user found", async () => {
      const verifyCallback = await setupStrategy();

      await verifyCallback(
        "accessToken",
        "refreshToken",
        mockProfile,
        mockDone,
      );

      const createdUser = await testPrisma.user.findUnique({
        where: { googleId: mockProfile.id },
      });

      expect(createdUser).toBeTruthy();
      expect(createdUser?.email).toBe("test@example.com");
      expect(createdUser?.name).toBe("Test User");
      expect(createdUser?.googleId).toBe("google-test-123");
      expect(createdUser?.authMethod).toBe("google");
      expect(mockDone).toHaveBeenCalledWith(null, createdUser);
    });

    it("should update existing user with matching googleId", async () => {
      const existingUser = await testPrisma.user.create({
        data: {
          email: "existing@example.com",
          name: "Old Name",
          googleId: "google-test-123",
          authMethod: "google",
        },
      });

      const verifyCallback = await setupStrategy();

      await verifyCallback(
        "accessToken",
        "refreshToken",
        mockProfile,
        mockDone,
      );

      const updatedUser = await testPrisma.user.findUnique({
        where: { id: existingUser.id },
      });

      expect(updatedUser?.name).toBe("Test User");
      expect(updatedUser?.email).toBe("test@example.com");
      expect(mockDone).toHaveBeenCalledWith(null, updatedUser);
    });

    it("should link existing local user with matching email but no googleId", async () => {
      const existingUser = await testPrisma.user.create({
        data: {
          email: "test@example.com",
          name: "Existing User",
          authMethod: "local",
        },
      });

      const verifyCallback = await setupStrategy();

      await verifyCallback(
        "accessToken",
        "refreshToken",
        mockProfile,
        mockDone,
      );

      const linkedUser = await testPrisma.user.findUnique({
        where: { id: existingUser.id },
      });

      expect(linkedUser?.googleId).toBe("google-test-123");
      expect(linkedUser?.authMethod).toBe("both");
      expect(linkedUser?.name).toBe("Test User");
      expect(mockDone).toHaveBeenCalledWith(null, linkedUser);
    });

    it("should handle error when no email provided in profile", async () => {
      const profileWithoutEmail: GoogleOAuthProfile = {
        id: "google-test-456",
        displayName: "Test User",
        emails: [],
        photos: [{ value: "https://example.com/avatar.jpg" }],
        provider: "google",
      };

      const verifyCallback = await setupStrategy();

      await verifyCallback(
        "accessToken",
        "refreshToken",
        profileWithoutEmail,
        mockDone,
      );

      expect(mockDone).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "No email found in Google profile",
        }),
        null,
      );
    });

    it("should handle database errors gracefully", async () => {
      const originalFindUnique = testPrisma.user.findUnique;
      (testPrisma.user as any).findUnique = vi
        .fn()
        .mockRejectedValue(new Error("Database error") as any);

      const verifyCallback = await setupStrategy();

      await verifyCallback(
        "accessToken",
        "refreshToken",
        mockProfile,
        mockDone,
      );

      expect(mockDone).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Database error",
        }),
        null,
      );

      (testPrisma.user as any).findUnique = originalFindUnique;
    });
  });

  describe("User Serialization", () => {
    it("should serialize user correctly", async () => {
      const testUser = await createTestUser();

      let serializeFunction: any;

      const mockPassport = {
        use: vi.fn(),
        serializeUser: vi.fn().mockImplementation((fn) => {
          serializeFunction = fn;
        }),
        deserializeUser: vi.fn(),
      };

      vi.doMock("passport", () => ({
        default: mockPassport,
      }));

      vi.resetModules();
      await import("../lib/passport");

      if (serializeFunction) {
        const mockSerializeDone = vi.fn();
        serializeFunction(testUser, mockSerializeDone);

        expect(mockSerializeDone).toHaveBeenCalledWith(null, testUser.id);
      }
    });
  });

  describe("User Deserialization", () => {
    it("should deserialize user correctly", async () => {
      const testUser = await createTestUser();

      let deserializeFunction: any;

      const mockPassport = {
        use: vi.fn(),
        serializeUser: vi.fn(),
        deserializeUser: vi.fn().mockImplementation((fn) => {
          deserializeFunction = fn;
        }),
      };

      vi.doMock("passport", () => ({
        default: mockPassport,
      }));

      vi.resetModules();
      await import("../lib/passport");

      if (deserializeFunction) {
        const mockDeserializeDone = vi.fn();
        await deserializeFunction(testUser.id, mockDeserializeDone);

        expect(mockDeserializeDone).toHaveBeenCalledWith(
          null,
          expect.objectContaining({
            id: testUser.id,
            email: testUser.email,
            name: testUser.name,
          }),
        );
      }
    });

    it("should handle non-existent user during deserialization", async () => {
      let deserializeFunction: any;

      const mockPassport = {
        use: vi.fn(),
        serializeUser: vi.fn(),
        deserializeUser: vi.fn().mockImplementation((fn) => {
          deserializeFunction = fn;
        }),
      };

      vi.doMock("passport", () => ({
        default: mockPassport,
      }));

      vi.resetModules();
      await import("../lib/passport");

      if (deserializeFunction) {
        const mockDeserializeDone = vi.fn();
        await deserializeFunction("non-existent-id", mockDeserializeDone);

        expect(mockDeserializeDone).toHaveBeenCalledWith(null, null);
      }
    });

    it("should handle database errors during deserialization", async () => {
      const originalFindUnique = testPrisma.user.findUnique;
      (testPrisma.user as any).findUnique = vi
        .fn()
        .mockRejectedValue(new Error("Database error") as any);

      let deserializeFunction: any;

      const mockPassport = {
        use: vi.fn(),
        serializeUser: vi.fn(),
        deserializeUser: vi.fn().mockImplementation((fn) => {
          deserializeFunction = fn;
        }),
      };

      vi.doMock("passport", () => ({
        default: mockPassport,
      }));

      vi.resetModules();
      await import("../lib/passport");

      if (deserializeFunction) {
        const mockDeserializeDone = vi.fn();
        await deserializeFunction("test-user-id", mockDeserializeDone);

        expect(mockDeserializeDone).toHaveBeenCalledWith(
          expect.objectContaining({
            message: "Database error",
          }),
          null,
        );
      }

      (testPrisma.user as any).findUnique = originalFindUnique;
    });
  });
});
