import { Request, Response, NextFunction } from "express";
import { PrismaSessionStore } from "./session-store";
import logger from "./logger";
import prisma from "./prisma";

// Session validation middleware
export const validateSession = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    // Skip validation for auth routes and health check
    if (
      req.path.startsWith("/auth") ||
      req.path === "/health" ||
      !req.session ||
      !req.sessionID
    ) {
      return next();
    }

    const sessionId = req.sessionID;
    logger.debug({ sessionId, userId: req.user?.id }, "Validating session");

    // Check if session exists in database and is not expired
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
      logger.debug(
        { sessionId },
        "Session not found in database, destroying session",
      );
      req.session.destroy(() => {});
      return next();
    }

    if (session.expires < new Date()) {
      logger.debug(
        { sessionId, expires: session.expires },
        "Session expired, destroying",
      );
      await prisma.session.delete({ where: { id: session.id } });
      req.session.destroy(() => {});
      return next();
    }

    // Update session activity timestamp
    await prisma.session.update({
      where: { id: session.id },
      data: { updatedAt: new Date() },
    });

    logger.debug(
      { sessionId, userId: session.userId },
      "Session validated successfully",
    );
    next();
  } catch (error) {
    logger.error(
      { error, sessionId: req.sessionID },
      "Error validating session",
    );
    next();
  }
};

// Extract user context from session
export const extractUserContext = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    // Skip for auth routes and health check
    if (req.path.startsWith("/auth") || req.path === "/health") {
      return next();
    }

    const sessionId = req.sessionID;

    if (!sessionId || !req.session?.passport?.user) {
      logger.debug("No session or user ID found in request");
      return next();
    }

    const userId = req.session.passport.user;

    // Get user data from database if not already attached
    if (!req.user) {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          name: true,
          image: true,
          createdAt: true,
        },
      });

      if (user) {
        req.user = user;
        logger.debug(
          { userId, email: user.email },
          "User context extracted from session",
        );
      } else {
        logger.warn(
          { userId, sessionId },
          "User not found in database, session may be stale",
        );
        req.session.destroy(() => {});
      }
    }

    next();
  } catch (error) {
    logger.error(
      { error, sessionId: req.sessionID },
      "Error extracting user context",
    );
    next();
  }
};

// Session regeneration utility
export const regenerateSession = (req: Request): Promise<void> => {
  return new Promise((resolve, reject) => {
    const user = req.user;

    req.session.regenerate((err) => {
      if (err) {
        logger.error(
          { error: err, userId: user?.id },
          "Error regenerating session",
        );
        return reject(err);
      }

      // Restore user data after regeneration
      if (user) {
        req.session.passport = { user: user.id };
        req.user = user;
      }

      req.session.save((saveErr) => {
        if (saveErr) {
          logger.error(
            { error: saveErr, userId: user?.id },
            "Error saving regenerated session",
          );
          return reject(saveErr);
        }

        logger.info(
          { userId: user?.id, sessionId: req.sessionID },
          "Session regenerated successfully",
        );
        resolve();
      });
    });
  });
};

// Session cleanup scheduler
let cleanupInterval: NodeJS.Timeout | null = null;

export const startSessionCleanup = (intervalMinutes: number = 60): void => {
  // Clear existing interval if any
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
  }

  const store = new PrismaSessionStore();

  const cleanup = async () => {
    try {
      await store.cleanup();
    } catch (error) {
      logger.error({ error }, "Session cleanup failed");
    }
  };

  // Run initial cleanup
  cleanup();

  // Schedule periodic cleanup
  cleanupInterval = setInterval(cleanup, intervalMinutes * 60 * 1000);

  logger.info({ intervalMinutes }, "Session cleanup scheduler started");
};

export const stopSessionCleanup = (): void => {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
    logger.info("Session cleanup scheduler stopped");
  }
};

// Utility to get session statistics
export const getSessionStats = async (): Promise<{
  totalSessions: number;
  activeSessions: number;
  expiredSessions: number;
}> => {
  try {
    const now = new Date();

    const [totalSessions, expiredSessions] = await Promise.all([
      prisma.session.count(),
      prisma.session.count({
        where: {
          expires: { lt: now },
        },
      }),
    ]);

    const activeSessions = totalSessions - expiredSessions;

    return {
      totalSessions,
      activeSessions,
      expiredSessions,
    };
  } catch (error) {
    logger.error({ error }, "Error getting session statistics");
    throw error;
  }
};

// Utility to destroy all sessions for a user
export const destroyUserSessions = async (userId: string): Promise<void> => {
  try {
    logger.info({ userId }, "Destroying all sessions for user");

    const result = await prisma.session.deleteMany({
      where: { userId },
    });

    logger.info(
      { userId, deletedCount: result.count },
      "User sessions destroyed",
    );
  } catch (error) {
    logger.error({ error, userId }, "Error destroying user sessions");
    throw error;
  }
};
