import { Router, Request, Response } from "express";
import { z } from "zod";
import { SessionStore } from "../session-store";
import { SSEEvent, TERMINAL_STATUSES } from "../types";
import { runSession } from "../agent/runner";
import { logger } from "../logger";

const createSessionSchema = z.object({
  message: z.string().min(1).max(4000),
  currentPath: z.string().max(500).optional(),
  context: z.record(z.string(), z.unknown()).optional(),
  sdkSessionId: z.string().max(500).optional(),
});

const sendMessageSchema = z.object({
  message: z.string().min(1).max(4000),
});

const updateContextSchema = z.object({
  currentPath: z.string().max(500),
});

export function createSessionsRouter(store: SessionStore): Router {
  const router = Router();

  // POST /sessions — create a new session
  router.post("/", (req: Request, res: Response) => {
    const parsed = createSessionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Validation error",
        details: parsed.error.issues,
      });
      return;
    }

    if (!store.canAcceptSession()) {
      res.status(429).json({
        error: "Too many sessions",
        message: "Maximum concurrent session limit reached. Try again later.",
      });
      return;
    }

    // createSession builds the initial SDKUserMessage and pushes it into the queue
    const session = store.createSession(parsed.data);

    // Start agent execution asynchronously (fire-and-forget)
    runSession(session.id, store).catch((err) => {
      logger.error(
        { err, sessionId: session.id },
        "Unhandled error in session runner",
      );
      if (store.getSession(session.id)?.status === "running") {
        store.failSession(session.id, "Agent runner crashed unexpectedly");
        store.emitSSE(session.id, {
          type: "error",
          data: { message: "Agent runner crashed unexpectedly" },
        });
        store.emitSSE(session.id, { type: "done", data: {} });
      }
    });

    res.status(201).json({
      id: session.id,
      status: session.status,
      createdAt: session.createdAt,
    });
  });

  // GET /sessions/:id/stream — SSE event stream
  router.get("/:id/stream", (req: Request, res: Response) => {
    const session = store.getSession(String(req.params.id));
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    // If session is already terminal, send final events and close
    if (TERMINAL_STATUSES.has(session.status)) {
      if (session.status === "completed") {
        writeSSE(res, { type: "result", data: { success: true } });
      } else {
        writeSSE(res, {
          type: "error",
          data: { message: `Session ${session.status}` },
        });
      }
      writeSSE(res, { type: "done", data: {} });
      res.end();
      return;
    }

    // Send initial connected event
    writeSSE(res, {
      type: "connected",
      data: { sessionId: session.id },
    });

    const emitter = store.getEmitter(session.id);
    if (!emitter) {
      res.end();
      return;
    }

    const cleanup = () => {
      clearInterval(heartbeat);
      emitter.removeListener("sse", onSSE);
    };

    const onSSE = (event: SSEEvent) => {
      try {
        writeSSE(res, event);
      } catch {
        cleanup();
      }

      // Close the stream on terminal events
      if (event.type === "done") {
        cleanup();
        res.end();
      }
    };

    // Heartbeat every 15s to keep the connection alive
    const heartbeat = setInterval(() => {
      try {
        res.write(`: heartbeat\n\n`);
      } catch {
        cleanup();
      }
    }, 15_000);

    emitter.on("sse", onSSE);

    req.on("close", () => {
      logger.debug({ sessionId: session.id }, "SSE client disconnected");
      cleanup();
    });
  });

  // POST /sessions/:id/messages — send a follow-up message to a running session
  router.post("/:id/messages", (req: Request, res: Response) => {
    const session = store.getSession(String(req.params.id));
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    if (session.status !== "running") {
      res.status(409).json({
        error: "Session not running",
        message: `Session is ${session.status} and cannot accept new messages.`,
      });
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

    const pushed = store.pushMessage(session.id, parsed.data.message);
    if (!pushed) {
      res.status(409).json({
        error: "Failed to send message",
        message: "Session queue is closed.",
      });
      return;
    }

    logger.info(
      { sessionId: session.id, message: parsed.data.message.slice(0, 100) },
      "Follow-up message sent",
    );
    res.json({ ok: true });
  });

  // PUT /sessions/:id/context — update session context (e.g. current page)
  router.put("/:id/context", (req: Request, res: Response) => {
    const session = store.getSession(String(req.params.id));
    if (!session) {
      res.status(404).json({ error: "Session not found" });
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

    session.currentPath = parsed.data.currentPath;
    logger.debug(
      { sessionId: session.id, currentPath: parsed.data.currentPath },
      "Session context updated",
    );
    res.json({ ok: true });
  });

  // DELETE /sessions/:id — close/abort a session
  router.delete("/:id", (req: Request, res: Response) => {
    const session = store.getSession(String(req.params.id));
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    store.deleteSession(session.id);
    res.json({ ok: true });
  });

  return router;
}

// ---------------------------------------------------------------------------
// Helper: write SSE event in the format the chat panel expects
// ---------------------------------------------------------------------------

function writeSSE(res: Response, event: SSEEvent): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}
