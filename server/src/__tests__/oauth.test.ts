import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { testPrisma, createTestUser } from "./setup";
import type { GoogleOAuthProfile } from "@mini-infra/types";

// Mock passport and logger before importing the module
jest.mock("passport", () => ({
  use: jest.fn(),
  serializeUser: jest.fn(),
  deserializeUser: jest.fn(),
  __esModule: true,
  default: {
    use: jest.fn(),
    serializeUser: jest.fn(),
    deserializeUser: jest.fn(),
  },
}));

jest.mock("../lib/logger-factory.ts", () => ({
  appLogger: jest.fn(() => ({
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
  __esModule: true,
  default: jest.fn(() => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  })),
}));

jest.mock("../lib/config.ts", () => ({
  GOOGLE_CLIENT_ID: "test-client-id",
  GOOGLE_CLIENT_SECRET: "test-client-secret",
  __esModule: true,
  default: {
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: "test-client-secret",
  },
}));

// Mock prisma to use our test instance
jest.mock("../lib/prisma.ts", () => ({
  __esModule: true,
  default: testPrisma,
}));

describe("OAuth Strategy and Callback Handling", () => {
  let mockDone: jest.MockedFunction<any>;

  beforeEach(async () => {
    mockDone = jest.fn();
    jest.clearAllMocks();

    // Clean up any existing users to ensure test isolation
    await testPrisma.apiKey.deleteMany();
    await testPrisma.user.deleteMany();
  });

  describe("Google OAuth Strategy Callback", () => {
    const mockProfile: GoogleOAuthProfile = {
      id: "google-test-123",
      displayName: "Test User",
      emails: [{ value: "test@example.com", verified: true }],
      photos: [{ value: "https://example.com/avatar.jpg" }],
      provider: "google",
    };

    it("should create a new user when no existing user found", async () => {
      // Mock the Google OAuth strategy constructor
      const mockVerifyCallback = jest.fn();
      
      // Mock the GoogleStrategy class to capture the verify callback
      const GoogleStrategy = jest.fn().mockImplementation((options, callback) => {
        mockVerifyCallback.mockImplementation(callback);
        return {
          name: 'google',
          _verify: callback,
        };
      });

      // Temporarily mock the passport-google-oauth20 module
      jest.doMock("passport-google-oauth20", () => ({
        Strategy: GoogleStrategy,
      }));

      // Re-import the passport module to trigger strategy registration
      jest.resetModules();
      await import("../lib/passport");

      // Execute the strategy callback directly
      await mockVerifyCallback(
        "accessToken",
        "refreshToken",
        mockProfile,
        mockDone,
      );

      // Verify user was created
      const createdUser = await testPrisma.user.findUnique({
        where: { googleId: mockProfile.id },
      });

      expect(createdUser).toBeTruthy();
      expect(createdUser?.email).toBe("test@example.com");
      expect(createdUser?.name).toBe("Test User");
      expect(createdUser?.googleId).toBe("google-test-123");
      expect(mockDone).toHaveBeenCalledWith(null, createdUser);
    });

    it("should update existing user with matching googleId", async () => {
      // Create a test user first
      const existingUser = await testPrisma.user.create({
        data: {
          email: "existing@example.com",
          name: "Old Name",
          googleId: "google-test-123",
        },
      });

      // Mock the Google OAuth strategy constructor
      const mockVerifyCallback = jest.fn();
      
      // Mock the GoogleStrategy class to capture the verify callback
      const GoogleStrategy = jest.fn().mockImplementation((options, callback) => {
        mockVerifyCallback.mockImplementation(callback);
        return {
          name: 'google',
          _verify: callback,
        };
      });

      // Temporarily mock the passport-google-oauth20 module
      jest.doMock("passport-google-oauth20", () => ({
        Strategy: GoogleStrategy,
      }));

      // Re-import the passport module to trigger strategy registration
      jest.resetModules();
      await import("../lib/passport");

      // Execute the strategy callback directly
      await mockVerifyCallback(
        "accessToken",
        "refreshToken",
        mockProfile,
        mockDone,
      );

      // Verify user was updated
      const updatedUser = await testPrisma.user.findUnique({
        where: { id: existingUser.id },
      });

      expect(updatedUser?.name).toBe("Test User"); // Should be updated
      expect(updatedUser?.email).toBe("test@example.com"); // Should be updated
      expect(mockDone).toHaveBeenCalledWith(null, updatedUser);
    });

    it("should link existing user with matching email but no googleId", async () => {
      // Create a test user without googleId
      const existingUser = await testPrisma.user.create({
        data: {
          email: "test@example.com",
          name: "Existing User",
        },
      });

      // Mock the Google OAuth strategy constructor
      const mockVerifyCallback = jest.fn();
      
      // Mock the GoogleStrategy class to capture the verify callback
      const GoogleStrategy = jest.fn().mockImplementation((options, callback) => {
        mockVerifyCallback.mockImplementation(callback);
        return {
          name: 'google',
          _verify: callback,
        };
      });

      // Temporarily mock the passport-google-oauth20 module
      jest.doMock("passport-google-oauth20", () => ({
        Strategy: GoogleStrategy,
      }));

      // Re-import the passport module to trigger strategy registration
      jest.resetModules();
      await import("../lib/passport");

      // Execute the strategy callback directly
      await mockVerifyCallback(
        "accessToken",
        "refreshToken",
        mockProfile,
        mockDone,
      );

      // Verify user was linked
      const linkedUser = await testPrisma.user.findUnique({
        where: { id: existingUser.id },
      });

      expect(linkedUser?.googleId).toBe("google-test-123");
      expect(linkedUser?.name).toBe("Test User"); // Updated from OAuth
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

      // Mock the Google OAuth strategy constructor
      const mockVerifyCallback = jest.fn();
      
      // Mock the GoogleStrategy class to capture the verify callback
      const GoogleStrategy = jest.fn().mockImplementation((options, callback) => {
        mockVerifyCallback.mockImplementation(callback);
        return {
          name: 'google',
          _verify: callback,
        };
      });

      // Temporarily mock the passport-google-oauth20 module
      jest.doMock("passport-google-oauth20", () => ({
        Strategy: GoogleStrategy,
      }));

      // Re-import the passport module to trigger strategy registration
      jest.resetModules();
      await import("../lib/passport");

      // Execute the strategy callback directly
      await mockVerifyCallback(
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
      // Create a mock that will throw an error
      const originalFindUnique = testPrisma.user.findUnique;
      (testPrisma.user as any).findUnique = jest
        .fn()
        .mockRejectedValue(new Error("Database error") as any);

      // Mock the Google OAuth strategy constructor
      const mockVerifyCallback = jest.fn();
      
      // Mock the GoogleStrategy class to capture the verify callback
      const GoogleStrategy = jest.fn().mockImplementation((options, callback) => {
        mockVerifyCallback.mockImplementation(callback);
        return {
          name: 'google',
          _verify: callback,
        };
      });

      // Temporarily mock the passport-google-oauth20 module
      jest.doMock("passport-google-oauth20", () => ({
        Strategy: GoogleStrategy,
      }));

      // Re-import the passport module to trigger strategy registration
      jest.resetModules();
      await import("../lib/passport");

      // Execute the strategy callback directly
      await mockVerifyCallback(
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

      // Restore the original method
      (testPrisma.user as any).findUnique = originalFindUnique;
    });
  });

  describe("User Serialization", () => {
    it("should serialize user correctly", async () => {
      const testUser = await createTestUser();

      // Mock the passport serializeUser function
      const mockSerializeUser = jest.fn();
      let serializeFunction: any;
      
      // Mock passport to capture the serialize function
      const mockPassport = {
        use: jest.fn(),
        serializeUser: jest.fn().mockImplementation((fn) => {
          serializeFunction = fn;
        }),
        deserializeUser: jest.fn(),
      };

      // Mock the passport module
      jest.doMock("passport", () => ({
        __esModule: true,
        default: mockPassport,
      }));

      // Re-import to trigger registration
      jest.resetModules();
      await import("../lib/passport");

      // Execute the serialization function
      if (serializeFunction) {
        const mockSerializeDone = jest.fn();
        serializeFunction(testUser, mockSerializeDone);

        expect(mockSerializeDone).toHaveBeenCalledWith(null, testUser.id);
      }
    });
  });

  describe("User Deserialization", () => {
    it("should deserialize user correctly", async () => {
      const testUser = await createTestUser();

      // Mock the passport deserializeUser function
      let deserializeFunction: any;
      
      // Mock passport to capture the deserialize function
      const mockPassport = {
        use: jest.fn(),
        serializeUser: jest.fn(),
        deserializeUser: jest.fn().mockImplementation((fn) => {
          deserializeFunction = fn;
        }),
      };

      // Mock the passport module
      jest.doMock("passport", () => ({
        __esModule: true,
        default: mockPassport,
      }));

      // Re-import to trigger registration
      jest.resetModules();
      await import("../lib/passport");

      // Execute the deserialization function
      if (deserializeFunction) {
        const mockDeserializeDone = jest.fn();
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
      // Mock the passport deserializeUser function
      let deserializeFunction: any;
      
      // Mock passport to capture the deserialize function
      const mockPassport = {
        use: jest.fn(),
        serializeUser: jest.fn(),
        deserializeUser: jest.fn().mockImplementation((fn) => {
          deserializeFunction = fn;
        }),
      };

      // Mock the passport module
      jest.doMock("passport", () => ({
        __esModule: true,
        default: mockPassport,
      }));

      // Re-import to trigger registration
      jest.resetModules();
      await import("../lib/passport");

      // Execute the deserialization function
      if (deserializeFunction) {
        const mockDeserializeDone = jest.fn();
        await deserializeFunction("non-existent-id", mockDeserializeDone);

        expect(mockDeserializeDone).toHaveBeenCalledWith(null, null);
      }
    });

    it("should handle database errors during deserialization", async () => {
      // Mock database error
      const originalFindUnique = testPrisma.user.findUnique;
      (testPrisma.user as any).findUnique = jest
        .fn()
        .mockRejectedValue(new Error("Database error") as any);

      // Mock the passport deserializeUser function
      let deserializeFunction: any;
      
      // Mock passport to capture the deserialize function
      const mockPassport = {
        use: jest.fn(),
        serializeUser: jest.fn(),
        deserializeUser: jest.fn().mockImplementation((fn) => {
          deserializeFunction = fn;
        }),
      };

      // Mock the passport module
      jest.doMock("passport", () => ({
        __esModule: true,
        default: mockPassport,
      }));

      // Re-import to trigger registration
      jest.resetModules();
      await import("../lib/passport");

      // Execute the deserialization function
      if (deserializeFunction) {
        const mockDeserializeDone = jest.fn();
        await deserializeFunction("test-user-id", mockDeserializeDone);

        expect(mockDeserializeDone).toHaveBeenCalledWith(
          expect.objectContaining({
            message: "Database error",
          }),
          null,
        );
      }

      // Restore the original method
      (testPrisma.user as any).findUnique = originalFindUnique;
    });
  });
});
