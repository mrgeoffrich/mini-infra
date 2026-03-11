import { Router, Request, Response } from "express";
import { TaskStore } from "../task-store";
import { HealthResponse } from "../types";

const startTime = Date.now();

export function createHealthRouter(store: TaskStore): Router {
  const router = Router();

  router.get("/", (_req: Request, res: Response) => {
    const stats = store.getStats();
    const body: HealthResponse = {
      status: "ok",
      uptime: Math.floor((Date.now() - startTime) / 1000),
      activeTasks: stats.activeTasks,
      totalTasksProcessed: stats.totalTasksProcessed,
    };
    res.json(body);
  });

  return router;
}
