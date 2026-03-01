import express, { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { appLogger } from "../lib/logger-factory";
import {
  requirePermission,
  getAuthenticatedUser,
  getCurrentUserId,
} from "../middleware/auth";
import { getAgentService } from "../services/agent-service";
import { agentConversationService } from "../services/agent-conversation-service";

const logger = appLogger();
const router = express.Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getUserId(req: Request): string | null {
  const user = getAuthenticatedUser(req);
  if (user) return user.id;
  return getCurrentUserId(req);
}

// ---------------------------------------------------------------------------
// GET /status — public, no auth
// ---------------------------------------------------------------------------

router.get(
  "/status",
  (req: Request, res: Response) => {
    const service = getAgentService();
    res.json({ enabled: service !== null });
  },
);

// ---------------------------------------------------------------------------
// POST /sessions — create a new agent session
// ---------------------------------------------------------------------------

const createSessionSchema = z.object({
  message: z.string().min(1).max(4000),
  currentPath: z.string().max(500).optional(),
  conversationId: z.string().optional(),
});

router.post(
  "/sessions",
  requirePermission('agent:use'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const service = getAgentService();
      if (!service) {
        res.status(503).json({
          error: "Agent service unavailable",
          message: "ANTHROPIC_API_KEY is not configured",
        });
        return;
      }

      const parsed = createSessionSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "Validation error",
          details: parsed.error.issues,
        });
        return;
      }

      const userId = getUserId(req);
      if (!userId) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      const result = await service.createSession(
        userId,
        parsed.data.message,
        parsed.data.currentPath,
        parsed.data.conversationId,
      );
      res.status(201).json({ sessionId: result.sessionId, conversationId: result.conversationId });
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : "Unknown error" },
        "Failed to create agent session",
      );
      next(error);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /sessions/:sessionId/stream — SSE event stream
// ---------------------------------------------------------------------------

router.get(
  "/sessions/:sessionId/stream",
  requirePermission('agent:use'),
  (req: Request, res: Response) => {
    const service = getAgentService();
    if (!service) {
      res.status(503).json({ error: "Agent service unavailable" });
      return;
    }

    const { sessionId } = req.params;
    const session = service.getSession(sessionId);

    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    const userId = getUserId(req);
    if (session.userId !== userId) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    // Set SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    // Send initial connected event
    res.write(
      `data: ${JSON.stringify({ type: "connected", data: { sessionId } })}\n\n`,
    );

    // Register as subscriber
    service.addSubscriber(sessionId, res);

    // Heartbeat every 15 seconds
    const heartbeat = setInterval(() => {
      try {
        res.write(`: heartbeat\n\n`);
      } catch {
        clearInterval(heartbeat);
      }
    }, 15_000);

    // Cleanup on disconnect
    req.on("close", () => {
      clearInterval(heartbeat);
      service.removeSubscriber(sessionId, res);
    });
  },
);

// ---------------------------------------------------------------------------
// PUT /sessions/:sessionId/context — update session context (e.g. current page)
// ---------------------------------------------------------------------------

const updateContextSchema = z.object({
  currentPath: z.string().max(500),
});

router.put(
  "/sessions/:sessionId/context",
  requirePermission('agent:use'),
  (req: Request, res: Response) => {
    const service = getAgentService();
    if (!service) {
      res.status(503).json({ error: "Agent service unavailable" });
      return;
    }

    const { sessionId } = req.params;
    const session = service.getSession(sessionId);

    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    const userId = getUserId(req);
    if (session.userId !== userId) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const parsed = updateContextSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Validation error",
        details: parsed.error.issues,
      });
      return;
    }

    service.updateCurrentPath(sessionId, parsed.data.currentPath);
    res.json({ ok: true });
  },
);

// ---------------------------------------------------------------------------
// POST /sessions/:sessionId/messages — send follow-up message
// ---------------------------------------------------------------------------

const sendMessageSchema = z.object({
  message: z.string().min(1).max(4000),
});

router.post(
  "/sessions/:sessionId/messages",
  requirePermission('agent:use'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const service = getAgentService();
      if (!service) {
        res.status(503).json({ error: "Agent service unavailable" });
        return;
      }

      const { sessionId } = req.params;
      const session = service.getSession(sessionId);

      if (!session) {
        res.status(404).json({ error: "Session not found" });
        return;
      }

      const userId = getUserId(req);
      if (session.userId !== userId) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }

      const parsed = sendMessageSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "Validation error",
          details: parsed.error.issues,
        });
        return;
      }

      const sent = service.sendMessage(sessionId, parsed.data.message);
      if (!sent) {
        res.status(409).json({
          error: "Session is not accepting messages",
          message: "The agent session may have completed or been closed",
        });
        return;
      }

      res.json({ ok: true });
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : "Unknown error" },
        "Failed to send message to agent session",
      );
      next(error);
    }
  },
);

// ---------------------------------------------------------------------------
// DELETE /sessions/:sessionId — close session
// ---------------------------------------------------------------------------

router.delete(
  "/sessions/:sessionId",
  requirePermission('agent:use'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const service = getAgentService();
      if (!service) {
        res.status(503).json({ error: "Agent service unavailable" });
        return;
      }

      const { sessionId } = req.params;
      const session = service.getSession(sessionId);

      if (!session) {
        res.status(404).json({ error: "Session not found" });
        return;
      }

      const userId = getUserId(req);
      if (session.userId !== userId) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }

      service.deleteSession(sessionId);
      res.json({ ok: true });
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : "Unknown error" },
        "Failed to delete agent session",
      );
      next(error);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /conversations — list the authenticated user's conversations
// ---------------------------------------------------------------------------

router.get(
  "/conversations",
  requirePermission("agent:use"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      const limitParam = req.query.limit;
      const limit = limitParam ? Math.min(parseInt(String(limitParam), 10) || 50, 200) : 50;

      const conversations = await agentConversationService.listConversations(userId, limit);
      res.json({ conversations });
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : "Unknown error" },
        "Failed to list agent conversations",
      );
      next(error);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /conversations/:id — get messages for a conversation
// ---------------------------------------------------------------------------

router.get(
  "/conversations/:id",
  requirePermission("agent:use"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      const conversation = await agentConversationService.getConversationDetail(
        req.params.id,
        userId,
      );

      if (!conversation) {
        res.status(404).json({ error: "Conversation not found" });
        return;
      }

      res.json({ conversation });
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : "Unknown error" },
        "Failed to get agent conversation",
      );
      next(error);
    }
  },
);

// ---------------------------------------------------------------------------
// DELETE /conversations/:id — delete a conversation
// ---------------------------------------------------------------------------

router.delete(
  "/conversations/:id",
  requirePermission("agent:use"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      const deleted = await agentConversationService.deleteConversation(req.params.id, userId);
      if (!deleted) {
        res.status(404).json({ error: "Conversation not found" });
        return;
      }

      res.json({ ok: true });
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : "Unknown error" },
        "Failed to delete agent conversation",
      );
      next(error);
    }
  },
);

export default router;
