import express, { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { appLogger } from "../lib/logger-factory";
import {
  requirePermission,
  getAuthenticatedUser,
  getCurrentUserId,
} from "../middleware/auth";
import {
  getAgentService,
  isAgentAvailable,
  getAgentUnavailableReason,
} from "../services/agent-service";
import { agentConversationService } from "../services/agent-conversation-service";
import { isAgentSidecarHealthy } from "../services/agent-sidecar";
import agentSettingsRouter from "./agent-settings";

const logger = appLogger();
const router = express.Router();

// Mount settings sub-router
router.use("/settings", agentSettingsRouter);

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

router.get("/status", (_req: Request, res: Response) => {
  const enabled = isAgentAvailable();
  const reason = getAgentUnavailableReason();
  const sidecarAvailable = isAgentSidecarHealthy();

  res.json({
    enabled,
    sidecarAvailable,
    ...(reason ? { reason } : {}),
  });
});

// ---------------------------------------------------------------------------
// POST /sessions — create a new agent session (proxied to sidecar)
// ---------------------------------------------------------------------------

const createSessionSchema = z.object({
  message: z.string().min(1).max(4000),
  currentPath: z.string().max(500).optional(),
  conversationId: z.string().min(1).max(100).optional(),
});

router.post(
  "/sessions",
  requirePermission("agent:use"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const service = getAgentService();
      if (!service || !isAgentAvailable()) {
        const reason = getAgentUnavailableReason();
        res.status(503).json({
          error: "Agent service unavailable",
          message:
            reason === "sidecar_unavailable" || reason === "sidecar_unhealthy"
              ? "The AI assistant requires the sidecar container to be running"
              : "ANTHROPIC_API_KEY is not configured",
          reason,
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
      res.status(201).json({
        sessionId: result.sessionId,
        conversationId: result.conversationId,
      });
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
// GET /sessions/:sessionId/stream — SSE relay from sidecar
// ---------------------------------------------------------------------------

router.get(
  "/sessions/:sessionId/stream",
  requirePermission("agent:use"),
  async (req: Request, res: Response) => {
    const service = getAgentService();
    if (!service) {
      res.status(503).json({ error: "Agent service unavailable" });
      return;
    }

    const { sessionId } = req.params;
    const mapping = service.getSessionMapping(sessionId);

    if (!mapping) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    const userId = getUserId(req);
    if (mapping.userId !== userId) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    // Set SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    // Connect to sidecar SSE stream
    let upstreamBody: ReadableStream<Uint8Array> | null;
    try {
      upstreamBody = await service.connectToSidecarStream(sessionId);
    } catch (err) {
      logger.error({ err, sessionId }, "Failed to connect to sidecar stream");
      res.write(
        `data: ${JSON.stringify({ type: "error", data: { message: "Failed to connect to sidecar stream" } })}\n\n`,
      );
      res.write(`data: ${JSON.stringify({ type: "done", data: {} })}\n\n`);
      res.end();
      return;
    }

    if (!upstreamBody) {
      res.write(
        `data: ${JSON.stringify({ type: "error", data: { message: "Sidecar stream unavailable" } })}\n\n`,
      );
      res.write(`data: ${JSON.stringify({ type: "done", data: {} })}\n\n`);
      res.end();
      return;
    }

    // Heartbeat every 15 seconds
    const heartbeat = setInterval(() => {
      try {
        res.write(`: heartbeat\n\n`);
      } catch {
        clearInterval(heartbeat);
      }
    }, 15_000);

    // Pipe upstream SSE to client, parse and persist as side-effect
    const reader = upstreamBody.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const pump = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          buffer += chunk;

          // Write chunk directly to client
          res.write(chunk);

          // Parse SSE events from buffer for persistence
          const events = extractSSEEvents(buffer);
          buffer = events.remaining;

          for (const event of events.parsed) {
            try {
              service.persistFromSSEEvent(sessionId, event);
            } catch {
              // Non-critical
            }
          }
        }
      } catch {
        // Stream closed
      }
      clearInterval(heartbeat);
      res.end();
    };

    pump();

    req.on("close", () => {
      clearInterval(heartbeat);
      reader.cancel();
    });
  },
);

// ---------------------------------------------------------------------------
// PUT /sessions/:sessionId/context
// ---------------------------------------------------------------------------

const updateContextSchema = z.object({
  currentPath: z.string().max(500),
});

router.put(
  "/sessions/:sessionId/context",
  requirePermission("agent:use"),
  async (req: Request, res: Response) => {
    const service = getAgentService();
    if (!service) {
      res.status(503).json({ error: "Agent service unavailable" });
      return;
    }

    const { sessionId } = req.params;
    const mapping = service.getSessionMapping(sessionId);

    if (!mapping) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    const userId = getUserId(req);
    if (mapping.userId !== userId) {
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

    await service.updateContext(sessionId, parsed.data.currentPath);
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
  requirePermission("agent:use"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const service = getAgentService();
      if (!service) {
        res.status(503).json({ error: "Agent service unavailable" });
        return;
      }

      const { sessionId } = req.params;
      const mapping = service.getSessionMapping(sessionId);

      if (!mapping) {
        res.status(404).json({ error: "Session not found" });
        return;
      }

      const userId = getUserId(req);
      if (mapping.userId !== userId) {
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

      const sent = await service.sendMessage(sessionId, parsed.data.message);
      if (!sent) {
        res.status(409).json({
          error: "Session is not accepting messages",
          message:
            "The agent session may have completed or been closed",
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
  requirePermission("agent:use"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const service = getAgentService();
      if (!service) {
        res.status(503).json({ error: "Agent service unavailable" });
        return;
      }

      const { sessionId } = req.params;
      const mapping = service.getSessionMapping(sessionId);

      if (!mapping) {
        res.status(404).json({ error: "Session not found" });
        return;
      }

      const userId = getUserId(req);
      if (mapping.userId !== userId) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }

      await service.deleteSession(sessionId);
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
      const limit = limitParam
        ? Math.min(parseInt(String(limitParam), 10) || 50, 200)
        : 50;

      const conversations =
        await agentConversationService.listConversations(userId, limit);
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
// Shared param validation for conversation ID routes
// ---------------------------------------------------------------------------

const conversationIdParamSchema = z.object({
  id: z.string().min(1).max(100),
});

// ---------------------------------------------------------------------------
// GET /conversations/:id — get messages for a conversation
// ---------------------------------------------------------------------------

router.get(
  "/conversations/:id",
  requirePermission("agent:use"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const paramParsed = conversationIdParamSchema.safeParse(req.params);
      if (!paramParsed.success) {
        res.status(400).json({ error: "Invalid conversation ID" });
        return;
      }

      const userId = getUserId(req);
      if (!userId) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      const conversation =
        await agentConversationService.getConversationDetail(
          paramParsed.data.id,
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
      const paramParsed = conversationIdParamSchema.safeParse(req.params);
      if (!paramParsed.success) {
        res.status(400).json({ error: "Invalid conversation ID" });
        return;
      }

      const userId = getUserId(req);
      if (!userId) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      const deleted = await agentConversationService.deleteConversation(
        paramParsed.data.id,
        userId,
      );
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

// ---------------------------------------------------------------------------
// SSE event parser for persistence side-effects
// ---------------------------------------------------------------------------

interface ParsedSSEEvent {
  type: string;
  data: Record<string, unknown>;
}

function extractSSEEvents(buffer: string): {
  parsed: ParsedSSEEvent[];
  remaining: string;
} {
  const parsed: ParsedSSEEvent[] = [];
  const lines = buffer.split("\n");
  let remaining = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("data: ")) {
      const jsonStr = line.slice(6);
      // Check if there's a blank line after (end of event)
      if (i + 1 < lines.length && lines[i + 1] === "") {
        try {
          const event = JSON.parse(jsonStr) as ParsedSSEEvent;
          if (event.type && event.data) {
            parsed.push(event);
          }
        } catch {
          // Malformed JSON, skip
        }
        i++; // Skip the blank line
      } else if (i === lines.length - 1) {
        // Incomplete event at end of buffer
        remaining = line + "\n";
      }
    } else if (line.startsWith(":") || line === "") {
      // Comment or blank line, skip
      continue;
    } else if (i === lines.length - 1 && line !== "") {
      // Incomplete line at end of buffer
      remaining = line;
    }
  }

  return { parsed, remaining };
}

export default router;
