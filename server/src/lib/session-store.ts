import { Store } from "express-session";
import prisma from "./prisma";
import logger from "./logger";

// Custom Prisma session store for express-session
export class PrismaSessionStore extends Store {
  constructor() {
    super();
  }

  // Get session data from database
  async get(
    sessionId: string,
    callback: (err?: any, session?: any) => void,
  ): Promise<void> {
    try {
      logger.debug({ sessionId }, "Getting session from database");

      const session = await prisma.session.findUnique({
        where: { sessionToken: sessionId },
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

      if (!session) {
        logger.debug({ sessionId }, "Session not found in database");
        return callback(null, null);
      }

      // Check if session is expired
      if (session.expires < new Date()) {
        logger.debug(
          { sessionId, expires: session.expires },
          "Session expired, cleaning up",
        );
        await this.destroy(sessionId, () => {});
        return callback(null, null);
      }

      // Return session data in the format express-session expects
      const sessionData = {
        passport: {
          user: session.userId,
        },
        user: session.user,
      };

      logger.debug(
        { sessionId, userId: session.userId },
        "Session retrieved successfully",
      );
      callback(null, sessionData);
    } catch (error) {
      logger.error({ error, sessionId }, "Error getting session from database");
      callback(error);
    }
  }

  // Set session data in database
  async set(
    sessionId: string,
    session: any,
    callback?: (err?: any) => void,
  ): Promise<void> {
    try {
      const userId = session.passport?.user;
      if (!userId) {
        logger.warn({ sessionId }, "No user ID found in session data");
        return callback?.(new Error("No user ID in session"));
      }

      // Calculate expiration date (default 24 hours from now)
      const expires = new Date();
      expires.setTime(
        expires.getTime() + (session.cookie?.maxAge || 24 * 60 * 60 * 1000),
      );

      logger.debug(
        { sessionId, userId, expires },
        "Saving session to database",
      );

      await prisma.session.upsert({
        where: { sessionToken: sessionId },
        update: {
          expires,
          updatedAt: new Date(),
        },
        create: {
          sessionToken: sessionId,
          userId,
          expires,
        },
      });

      logger.debug({ sessionId, userId }, "Session saved successfully");
      callback?.();
    } catch (error) {
      logger.error({ error, sessionId }, "Error saving session to database");
      callback?.(error);
    }
  }

  // Destroy session from database
  async destroy(
    sessionId: string,
    callback?: (err?: any) => void,
  ): Promise<void> {
    try {
      logger.debug({ sessionId }, "Destroying session from database");

      await prisma.session.delete({
        where: { sessionToken: sessionId },
      });

      logger.debug({ sessionId }, "Session destroyed successfully");
      callback?.();
    } catch (error) {
      // If session doesn't exist, that's fine
      if (error && (error as any).code === "P2025") {
        logger.debug({ sessionId }, "Session already not found in database");
        return callback?.();
      }

      logger.error(
        { error, sessionId },
        "Error destroying session from database",
      );
      callback?.(error);
    }
  }

  // Get all session IDs (optional method)
  async all(callback: (err?: any, sessions?: any) => void): Promise<void> {
    try {
      const sessions = await prisma.session.findMany({
        where: {
          expires: {
            gt: new Date(),
          },
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

      const sessionData = sessions.reduce((acc, session) => {
        acc[session.sessionToken] = {
          passport: {
            user: session.userId,
          },
          user: session.user,
        };
        return acc;
      }, {} as any);

      callback(null, sessionData);
    } catch (error) {
      logger.error({ error }, "Error getting all sessions from database");
      callback(error);
    }
  }

  // Get length of active sessions (optional method)
  async length(callback: (err?: any, length?: number) => void): Promise<void> {
    try {
      const count = await prisma.session.count({
        where: {
          expires: {
            gt: new Date(),
          },
        },
      });

      callback(null, count);
    } catch (error) {
      logger.error({ error }, "Error getting session count from database");
      callback(error);
    }
  }

  // Clear all sessions (optional method)
  async clear(callback?: (err?: any) => void): Promise<void> {
    try {
      logger.info("Clearing all sessions from database");

      await prisma.session.deleteMany({});

      logger.info("All sessions cleared successfully");
      callback?.();
    } catch (error) {
      logger.error({ error }, "Error clearing all sessions from database");
      callback?.(error);
    }
  }

  // Clean up expired sessions
  async cleanup(): Promise<void> {
    try {
      logger.debug("Cleaning up expired sessions");

      const result = await prisma.session.deleteMany({
        where: {
          expires: {
            lt: new Date(),
          },
        },
      });

      if (result.count > 0) {
        logger.info(
          { deletedCount: result.count },
          "Cleaned up expired sessions",
        );
      }
    } catch (error) {
      logger.error({ error }, "Error cleaning up expired sessions");
    }
  }
}
