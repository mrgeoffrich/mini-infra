import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { Request, Response, NextFunction } from "express";
import { testPrisma, createTestUser, createTestSession } from "./setup";

// Mock logger
jest.mock("../lib/logger.ts", () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
  __esModule: true,
  default: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

describe("Session Management and Lifecycle", () => {
  describe("Session Store Operations", () => {
    it("should create and retrieve session data correctly", async () => {
      const testUser = await createTestUser();

      // Create a session directly in the database
      const sessionToken = "test-session-token";
      const expires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours from now

      await testPrisma.session.create({
        data: {
          sessionToken,
          userId: testUser.id,
          expires,
        },
      });

      // Retrieve the session
      const session = await testPrisma.session.findUnique({
        where: { sessionToken },
        include: {
          user: {
            select: {
              id: true,
              email: true,
              name: true,
              image: true,
              createdAt: true,
            },
          },
        },
      });

      expect(session).toBeTruthy();
      expect(session?.userId).toBe(testUser.id);
      expect(session?.user.email).toBe(testUser.email);
      expect(session?.expires.getTime()).toBeGreaterThan(Date.now());
    });

    it("should handle session expiration correctly", async () => {
      const testUser = await createTestUser();

      // Create an expired session
      const expiredSessionToken = "expired-session-token";
      const expires = new Date(Date.now() - 1000); // 1 second ago

      await testPrisma.session.create({
        data: {
          sessionToken: expiredSessionToken,
          userId: testUser.id,
          expires,
        },
      });

      const session = await testPrisma.session.findUnique({
        where: { sessionToken: expiredSessionToken },
      });

      expect(session).toBeTruthy();
      expect(session?.expires.getTime()).toBeLessThan(Date.now());

      // Clean up expired session
      await testPrisma.session.delete({
        where: { sessionToken: expiredSessionToken },
      });

      const deletedSession = await testPrisma.session.findUnique({
        where: { sessionToken: expiredSessionToken },
      });

      expect(deletedSession).toBeNull();
    });

    it("should update session data correctly", async () => {
      const testUser = await createTestUser();
      const sessionToken = "update-session-token";

      const originalSession = await testPrisma.session.create({
        data: {
          sessionToken,
          userId: testUser.id,
          expires: new Date(Date.now() + 60 * 60 * 1000), // 1 hour
        },
      });

      // Update session
      const newExpires = new Date(Date.now() + 2 * 60 * 60 * 1000); // 2 hours
      const updatedSession = await testPrisma.session.update({
        where: { sessionToken },
        data: {
          expires: newExpires,
          updatedAt: new Date(),
        },
      });

      expect(updatedSession.expires.getTime()).toBeGreaterThan(
        originalSession.expires.getTime(),
      );
      expect(updatedSession.updatedAt.getTime()).toBeGreaterThan(
        originalSession.updatedAt.getTime(),
      );
    });

    it("should upsert session correctly", async () => {
      const testUser = await createTestUser();
      const sessionToken = "upsert-session-token";
      const expires = new Date(Date.now() + 60 * 60 * 1000);

      // First upsert (create)
      const createdSession = await testPrisma.session.upsert({
        where: { sessionToken },
        update: {
          expires,
          updatedAt: new Date(),
        },
        create: {
          sessionToken,
          userId: testUser.id,
          expires,
        },
      });

      expect(createdSession.userId).toBe(testUser.id);

      // Second upsert (update)
      const newExpires = new Date(Date.now() + 2 * 60 * 60 * 1000);
      const updatedSession = await testPrisma.session.upsert({
        where: { sessionToken },
        update: {
          expires: newExpires,
          updatedAt: new Date(),
        },
        create: {
          sessionToken,
          userId: testUser.id,
          expires: newExpires,
        },
      });

      expect(updatedSession.id).toBe(createdSession.id); // Same session
      expect(updatedSession.expires.getTime()).toBeGreaterThan(
        createdSession.expires.getTime(),
      );
    });
  });

  describe("Session Cleanup Operations", () => {
    it("should count sessions correctly", async () => {
      const testUser1 = await createTestUser();
      const testUser2 = await createTestUser();

      // Create active sessions
      await createTestSession(testUser1.id);
      await createTestSession(testUser2.id);

      // Create expired session
      await testPrisma.session.create({
        data: {
          sessionToken: "expired-for-count",
          userId: testUser1.id,
          expires: new Date(Date.now() - 1000),
        },
      });

      const totalCount = await testPrisma.session.count();
      const activeCount = await testPrisma.session.count({
        where: {
          expires: { gt: new Date() },
        },
      });
      const expiredCount = await testPrisma.session.count({
        where: {
          expires: { lt: new Date() },
        },
      });

      expect(totalCount).toBe(3);
      expect(activeCount).toBe(2);
      expect(expiredCount).toBe(1);
    });

    it("should delete expired sessions correctly", async () => {
      const testUser = await createTestUser();

      // Create active session
      await createTestSession(testUser.id);

      // Create expired sessions
      await testPrisma.session.create({
        data: {
          sessionToken: "expired-1",
          userId: testUser.id,
          expires: new Date(Date.now() - 1000),
        },
      });

      await testPrisma.session.create({
        data: {
          sessionToken: "expired-2",
          userId: testUser.id,
          expires: new Date(Date.now() - 2000),
        },
      });

      // Delete expired sessions
      const result = await testPrisma.session.deleteMany({
        where: {
          expires: { lt: new Date() },
        },
      });

      expect(result.count).toBe(2);

      const remainingSessions = await testPrisma.session.findMany();
      expect(remainingSessions.length).toBe(1);
    });

    it("should delete all sessions for a user", async () => {
      const testUser1 = await createTestUser();
      const testUser2 = await createTestUser();

      // Create sessions for both users
      await createTestSession(testUser1.id);
      await createTestSession(testUser1.id);
      await createTestSession(testUser2.id);

      // Delete all sessions for user1
      const result = await testPrisma.session.deleteMany({
        where: { userId: testUser1.id },
      });

      expect(result.count).toBe(2);

      const remainingSessions = await testPrisma.session.findMany();
      expect(remainingSessions.length).toBe(1);
      expect(remainingSessions[0].userId).toBe(testUser2.id);
    });

    it("should clear all sessions", async () => {
      const testUser1 = await createTestUser();
      const testUser2 = await createTestUser();

      await createTestSession(testUser1.id);
      await createTestSession(testUser2.id);

      // Clear all sessions
      const result = await testPrisma.session.deleteMany({});

      expect(result.count).toBe(2);

      const remainingSessions = await testPrisma.session.findMany();
      expect(remainingSessions.length).toBe(0);
    });
  });

  describe("Session Data Validation", () => {
    it("should validate session token uniqueness", async () => {
      const testUser = await createTestUser();
      const sessionToken = "unique-session-token";

      // Create first session
      await testPrisma.session.create({
        data: {
          sessionToken,
          userId: testUser.id,
          expires: new Date(Date.now() + 60 * 60 * 1000),
        },
      });

      // Attempt to create duplicate session should fail
      await expect(
        testPrisma.session.create({
          data: {
            sessionToken, // Same token
            userId: testUser.id,
            expires: new Date(Date.now() + 60 * 60 * 1000),
          },
        }),
      ).rejects.toThrow();
    });

    it("should handle user deletion with cascade", async () => {
      const testUser = await createTestUser();
      await createTestSession(testUser.id);

      // Verify session exists
      const sessionsBefore = await testPrisma.session.findMany({
        where: { userId: testUser.id },
      });
      expect(sessionsBefore.length).toBe(1);

      // Delete user (should cascade to sessions)
      await testPrisma.user.delete({
        where: { id: testUser.id },
      });

      // Verify sessions are deleted
      const sessionsAfter = await testPrisma.session.findMany({
        where: { userId: testUser.id },
      });
      expect(sessionsAfter.length).toBe(0);
    });

    it("should retrieve sessions with user data", async () => {
      const testUser = await createTestUser();
      const sessionToken = "session-with-user-data";

      await testPrisma.session.create({
        data: {
          sessionToken,
          userId: testUser.id,
          expires: new Date(Date.now() + 60 * 60 * 1000),
        },
      });

      const sessionWithUser = await testPrisma.session.findUnique({
        where: { sessionToken },
        include: {
          user: {
            select: {
              id: true,
              email: true,
              name: true,
              image: true,
              createdAt: true,
            },
          },
        },
      });

      expect(sessionWithUser).toBeTruthy();
      expect(sessionWithUser?.user).toBeTruthy();
      expect(sessionWithUser?.user.email).toBe(testUser.email);
      expect(sessionWithUser?.user.name).toBe(testUser.name);
    });
  });

  describe("Session Lifecycle Management", () => {
    it("should find active sessions only", async () => {
      const testUser = await createTestUser();

      // Create active session
      await testPrisma.session.create({
        data: {
          sessionToken: "active-session",
          userId: testUser.id,
          expires: new Date(Date.now() + 60 * 60 * 1000),
        },
      });

      // Create expired session
      await testPrisma.session.create({
        data: {
          sessionToken: "expired-session",
          userId: testUser.id,
          expires: new Date(Date.now() - 1000),
        },
      });

      const activeSessions = await testPrisma.session.findMany({
        where: {
          expires: { gt: new Date() },
        },
        include: {
          user: {
            select: {
              id: true,
              email: true,
              name: true,
              image: true,
            },
          },
        },
      });

      expect(activeSessions.length).toBe(1);
      expect(activeSessions[0].sessionToken).toBe("active-session");
    });

    it("should update session activity correctly", async () => {
      const testUser = await createTestUser();
      const session = await createTestSession(testUser.id);

      const originalUpdatedAt = session.updatedAt;

      // Wait a moment to ensure different timestamps
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Update session activity
      const updatedSession = await testPrisma.session.update({
        where: { id: session.id },
        data: { updatedAt: new Date() },
      });

      expect(updatedSession.updatedAt.getTime()).toBeGreaterThan(
        originalUpdatedAt.getTime(),
      );
    });
  });
});
