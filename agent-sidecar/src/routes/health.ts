import { Router, Request, Response } from "express";
import { SessionStore } from "../session-store";
import { HealthResponse } from "../types";

const startTime = Date.now();

export function createHealthRouter(store: SessionStore): Router {
  const router = Router();

  router.get("/", (_req: Request, res: Response) => {
    const stats = store.getStats();
    const body: HealthResponse = {
      status: "ok",
      uptime: Math.floor((Date.now() - startTime) / 1000),
      activeSessions: stats.activeSessions,
      totalSessionsProcessed: stats.totalSessionsProcessed,
    };
    res.json(body);
  });

  return router;
}
