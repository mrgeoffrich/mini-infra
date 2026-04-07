import { Router, Request, Response } from "express";
import { z } from "zod";
import { TurnStore } from "../turn-store";
import { SSEEvent, TERMINAL_STATUSES } from "../types";
import { runTurn } from "../agent/runner";
import { logger } from "../logger";

const createTurnSchema = z.object({
  message: z.string().min(1).max(4000),
  currentPath: z.string().max(500).optional(),
  context: z.record(z.string(), z.unknown()).optional(),
  sdkSessionId: z.string().max(200).optional(),
});

const sendMessageSchema = z.object({
  message: z.string().min(1).max(4000),
});

const updateContextSchema = z.object({
  currentPath: z.string().max(500),
});

export function createTurnsRouter(store: TurnStore): Router {
  const router = Router();

  // POST /turns — create a new turn
  router.post("/", (req: Request, res: Response) => {
    const parsed = createTurnSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Validation error",
        details: parsed.error.issues,
      });
      return;
    }

    if (!store.canAcceptTurn()) {
      res.status(429).json({
        error: "Too many turns",
        message: "Maximum concurrent turn limit reached. Try again later.",
      });
      return;
    }

    // createTurn builds the initial SDKUserMessage and pushes it into the queue
    const turn = store.createTurn(parsed.data);

    // Start agent execution asynchronously (fire-and-forget)
    runTurn(turn.id, store).catch((err) => {
      logger.error(
        { err, turnId: turn.id },
        "Unhandled error in turn runner",
      );
      if (store.getTurn(turn.id)?.status === "running") {
        store.failTurn(turn.id, "Agent runner crashed unexpectedly");
        store.emitSSE(turn.id, {
          type: "error",
          data: { message: "Agent runner crashed unexpectedly" },
        });
        store.emitSSE(turn.id, { type: "done", data: {} });
      }
    });

    res.status(201).json({
      id: turn.id,
      status: turn.status,
      createdAt: turn.createdAt,
    });
  });

  // GET /turns/:id/stream — SSE event stream
  router.get("/:id/stream", (req: Request, res: Response) => {
    const turn = store.getTurn(String(req.params.id));
    if (!turn) {
      res.status(404).json({ error: "Turn not found" });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    // If turn is already terminal, send final events and close
    if (TERMINAL_STATUSES.has(turn.status)) {
      if (turn.status === "completed") {
        writeSSE(res, { type: "result", data: { success: true } });
      } else {
        writeSSE(res, {
          type: "error",
          data: { message: `Turn ${turn.status}` },
        });
      }
      writeSSE(res, { type: "done", data: {} });
      res.end();
      return;
    }

    // Send initial connected event
    writeSSE(res, {
      type: "connected",
      data: { turnId: turn.id },
    });

    const emitter = store.getEmitter(turn.id);
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
      logger.debug({ turnId: turn.id }, "SSE client disconnected");
      cleanup();
    });
  });

  // POST /turns/:id/messages — send a follow-up message to a running turn
  router.post("/:id/messages", (req: Request, res: Response) => {
    const turn = store.getTurn(String(req.params.id));
    if (!turn) {
      res.status(404).json({ error: "Turn not found" });
      return;
    }

    if (turn.status !== "running") {
      res.status(409).json({
        error: "Turn not running",
        message: `Turn is ${turn.status} and cannot accept new messages.`,
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

    const pushed = store.pushMessage(turn.id, parsed.data.message);
    if (!pushed) {
      res.status(409).json({
        error: "Failed to send message",
        message: "Turn queue is closed.",
      });
      return;
    }

    logger.info(
      { turnId: turn.id, message: parsed.data.message.slice(0, 100) },
      "Follow-up message sent",
    );
    res.json({ ok: true });
  });

  // PUT /turns/:id/context — update turn context (e.g. current page)
  router.put("/:id/context", (req: Request, res: Response) => {
    const turn = store.getTurn(String(req.params.id));
    if (!turn) {
      res.status(404).json({ error: "Turn not found" });
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

    turn.currentPath = parsed.data.currentPath;
    logger.debug(
      { turnId: turn.id, currentPath: parsed.data.currentPath },
      "Turn context updated",
    );
    res.json({ ok: true });
  });

  // DELETE /turns/:id — close/abort a turn
  router.delete("/:id", (req: Request, res: Response) => {
    const turn = store.getTurn(String(req.params.id));
    if (!turn) {
      res.status(404).json({ error: "Turn not found" });
      return;
    }

    store.deleteTurn(turn.id);
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
