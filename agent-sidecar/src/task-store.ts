import { v4 as uuidv4 } from "uuid";
import { EventEmitter } from "events";
import {
  Task,
  TaskStatus,
  TERMINAL_STATUSES,
  TokenUsage,
  SSEEvent,
  CreateTaskRequest,
} from "./types";
import { logger } from "./logger";

const MAX_TASKS = 50;
const MAX_QUEUE_DEPTH = 5;

export class TaskStore {
  private tasks = new Map<string, Task>();
  private emitters = new Map<string, EventEmitter>();
  private totalProcessed = 0;

  // -------------------------------------------------------------------------
  // Task creation
  // -------------------------------------------------------------------------

  createTask(req: CreateTaskRequest): Task {
    const id = `task_${uuidv4().replace(/-/g, "").slice(0, 16)}`;
    const now = new Date().toISOString();

    const task: Task = {
      id,
      status: "running",
      prompt: req.prompt,
      context: req.context,
      result: null,
      error: null,
      toolCalls: [],
      tokenUsage: { input: 0, output: 0 },
      createdAt: now,
      completedAt: null,
      durationMs: null,
    };

    this.tasks.set(id, task);
    this.emitters.set(id, new EventEmitter());
    this.totalProcessed++;

    this.evictOldTasks();

    logger.info(
      { taskId: id, prompt: req.prompt.slice(0, 100) },
      "Task created",
    );
    return task;
  }

  // -------------------------------------------------------------------------
  // Task retrieval
  // -------------------------------------------------------------------------

  getTask(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  listTasks(): Task[] {
    return [...this.tasks.values()].reverse();
  }

  getActiveTasks(): Task[] {
    return [...this.tasks.values()].filter((t) => t.status === "running");
  }

  getStats(): { activeTasks: number; totalTasksProcessed: number } {
    return {
      activeTasks: this.getActiveTasks().length,
      totalTasksProcessed: this.totalProcessed,
    };
  }

  // -------------------------------------------------------------------------
  // Concurrency check
  // -------------------------------------------------------------------------

  canAcceptTask(): boolean {
    return this.getActiveTasks().length < MAX_QUEUE_DEPTH;
  }

  // -------------------------------------------------------------------------
  // Task state transitions
  // -------------------------------------------------------------------------

  completeTask(id: string, result: string): boolean {
    return this.transitionTask(id, "completed", { result });
  }

  failTask(id: string, error: string): boolean {
    return this.transitionTask(id, "failed", { error });
  }

  cancelTask(id: string): boolean {
    return this.transitionTask(id, "cancelled");
  }

  timeoutTask(id: string): boolean {
    return this.transitionTask(id, "timeout", {
      error: "Task execution timed out",
    });
  }

  private transitionTask(
    id: string,
    newStatus: TaskStatus,
    updates?: { result?: string; error?: string },
  ): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;

    if (task.status !== "running") {
      logger.warn(
        {
          taskId: id,
          currentStatus: task.status,
          requestedStatus: newStatus,
        },
        "Cannot transition task from non-running state",
      );
      return false;
    }

    const now = new Date().toISOString();
    task.status = newStatus;
    task.completedAt = now;
    task.durationMs =
      new Date(now).getTime() - new Date(task.createdAt).getTime();

    if (updates?.result !== undefined) task.result = updates.result;
    if (updates?.error !== undefined) task.error = updates.error;

    logger.info(
      { taskId: id, status: newStatus, durationMs: task.durationMs },
      "Task transitioned",
    );
    return true;
  }

  // -------------------------------------------------------------------------
  // Tool call recording
  // -------------------------------------------------------------------------

  addToolCall(id: string, tool: string, input: Record<string, unknown>): void {
    const task = this.tasks.get(id);
    if (!task || task.status !== "running") return;

    task.toolCalls.push({
      tool,
      input,
      timestamp: new Date().toISOString(),
    });
  }

  updateTokenUsage(id: string, usage: TokenUsage): void {
    const task = this.tasks.get(id);
    if (!task) return;
    task.tokenUsage = usage;
  }

  // -------------------------------------------------------------------------
  // SSE event emission
  // -------------------------------------------------------------------------

  getEmitter(id: string): EventEmitter | undefined {
    return this.emitters.get(id);
  }

  emitSSE(id: string, event: SSEEvent): void {
    const emitter = this.emitters.get(id);
    if (emitter) {
      emitter.emit("sse", event);
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private evictOldTasks(): void {
    if (this.tasks.size <= MAX_TASKS) return;

    for (const [id, task] of this.tasks) {
      if (this.tasks.size <= MAX_TASKS) break;
      if (TERMINAL_STATUSES.has(task.status)) {
        this.tasks.delete(id);
        this.emitters.delete(id);
        logger.debug({ taskId: id }, "Evicted old task");
      }
    }
  }
}
