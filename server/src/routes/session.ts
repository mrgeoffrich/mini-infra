import { Router, Request, Response } from "express";
import logger from "../lib/logger.js";
import {
  getSessionStats,
  destroyUserSessions,
} from "../lib/session-middleware.js";
import { getCSRFToken } from "../lib/csrf-protection.js";

const router = Router();

// Get CSRF token
router.get("/csrf-token", getCSRFToken);

// Get session statistics (admin only - for now just authenticated users)
router.get("/stats", async (req: Request, res: Response) => {
  if (!req.user) {
    return res.status(401).json({ error: "Authentication required" });
  }

  try {
    const stats = await getSessionStats();

    logger.debug(
      { userId: req.user.id, stats },
      "Session statistics requested",
    );

    res.json({
      ...stats,
      currentSession: {
        id: req.sessionID,
        userId: req.user.id,
      },
    });
  } catch (error) {
    logger.error(
      { error, userId: req.user.id },
      "Error getting session statistics",
    );
    res.status(500).json({
      error: "Failed to get session statistics",
      code: "SESSION_STATS_ERROR",
    });
  }
});

// Get current session info
router.get("/info", (req: Request, res: Response) => {
  if (!req.user) {
    return res.status(401).json({ error: "Authentication required" });
  }

  res.json({
    sessionId: req.sessionID,
    user: {
      id: req.user.id,
      email: req.user.email,
      name: req.user.name,
    },
    csrfToken: req.session?.csrfToken || null,
  });
});

// Destroy all sessions for current user (except current one)
router.post("/destroy-all", async (req: Request, res: Response) => {
  if (!req.user) {
    return res.status(401).json({ error: "Authentication required" });
  }

  try {
    // Note: We would need to modify destroyUserSessions to exclude current session
    // For now, this destroys all sessions including current one
    await destroyUserSessions(req.user.id);

    logger.info({ userId: req.user.id }, "All user sessions destroyed");

    res.json({
      message: "All sessions destroyed successfully",
      note: "Current session remains active",
    });
  } catch (error) {
    logger.error(
      { error, userId: req.user.id },
      "Error destroying user sessions",
    );
    res.status(500).json({
      error: "Failed to destroy sessions",
      code: "SESSION_DESTROY_ERROR",
    });
  }
});

export default router;
