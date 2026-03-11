import { Router, Request, Response } from "express";
import { z } from "zod";
import { TaskStore } from "../task-store";
import {
  CreateTaskResponse,
  GetTaskResponse,
  ListTasksResponse,
  CancelTaskResponse,
  TaskSummary,
  SSEEvent,
} from "../types";
import { runAgent, cancelTask } from "../agent/runner";
import { logger } from "../logger";

const createTaskSchema = z.object({
  prompt: z.string().min(1).max(4000),
  context: z.record(z.unknown()).optional(),
});

export function createTasksRouter(store: TaskStore): Router {
  const router = Router();

  // POST /tasks — create a new task
  router.post("/", (req: Request, res: Response) => {
    const parsed = createTaskSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Validation error",
        details: parsed.error.issues,
      });
      return;
    }

    if (!store.canAcceptTask()) {
      res.status(429).json({
        error: "Too many tasks",
        message: "Maximum concurrent task limit reached. Try again later.",
      });
      return;
    }

    const task = store.createTask(parsed.data);

    // Emit initial SSE status event
    store.emitSSE(task.id, {
      type: "status",
      data: {
        status: "running",
        message: "Task created, awaiting agent execution...",
      },
    });

    // Start agent execution asynchronously (fire-and-forget)
    runAgent(task.id, store).catch((err) => {
      logger.error({ err, taskId: task.id }, "Unhandled error in agent runner");
      if (store.getTask(task.id)?.status === "running") {
        store.failTask(task.id, "Agent runner crashed unexpectedly");
        store.emitSSE(task.id, {
          type: "error",
          data: { status: "failed", error: "Agent runner crashed unexpectedly" },
        });
      }
    });

    const body: CreateTaskResponse = {
      id: task.id,
      status: task.status,
      prompt: task.prompt,
      createdAt: task.createdAt,
    };

    res.status(201).json(body);
  });

  // GET /tasks — list recent tasks
  router.get("/", (_req: Request, res: Response) => {
    const tasks = store.listTasks();
    const summaries: TaskSummary[] = tasks.map((t) => ({
      id: t.id,
      status: t.status,
      prompt: t.prompt,
      createdAt: t.createdAt,
      completedAt: t.completedAt,
      durationMs: t.durationMs,
    }));

    const body: ListTasksResponse = { tasks: summaries };
    res.json(body);
  });

  // GET /tasks/:id — get task detail
  router.get("/:id", (req: Request, res: Response) => {
    const task = store.getTask(req.params.id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    const body: GetTaskResponse = { ...task };
    res.json(body);
  });

  // GET /tasks/:id/stream — SSE event stream
  router.get("/:id/stream", (req: Request, res: Response) => {
    const task = store.getTask(req.params.id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    // If task is already terminal, send final event and close
    if (task.status !== "running") {
      const eventType = task.status === "completed" ? "complete" : "error";
      const eventData =
        task.status === "completed"
          ? { status: "completed", result: task.result ?? "" }
          : { status: task.status, error: task.error ?? "Unknown error" };

      res.write(`event: ${eventType}\ndata: ${JSON.stringify(eventData)}\n\n`);
      res.end();
      return;
    }

    // Send initial status
    res.write(
      `event: status\ndata: ${JSON.stringify({ status: "running", message: "Connected to task stream" })}\n\n`,
    );

    const emitter = store.getEmitter(task.id);
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
        res.write(
          `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`,
        );
      } catch {
        cleanup();
      }

      // Close the stream on terminal events
      if (event.type === "complete" || event.type === "error") {
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
      logger.debug({ taskId: task.id }, "SSE client disconnected");
      cleanup();
    });
  });

  // POST /tasks/:id/cancel — cancel a running task
  router.post("/:id/cancel", (req: Request, res: Response) => {
    const task = store.getTask(req.params.id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    if (task.status !== "running") {
      res.status(409).json({
        error: "Task is not running",
        message: `Task is in '${task.status}' state and cannot be cancelled`,
      });
      return;
    }

    // Abort the agent runner if it's running
    cancelTask(task.id);
    store.cancelTask(task.id);

    // Notify SSE subscribers
    store.emitSSE(task.id, {
      type: "error",
      data: { status: "failed", error: "Task was cancelled by user" },
    });

    const body: CancelTaskResponse = {
      id: task.id,
      status: "cancelled",
    };

    res.json(body);
  });

  return router;
}
