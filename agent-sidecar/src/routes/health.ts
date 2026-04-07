import { Router, Request, Response } from "express";
import { TurnStore } from "../turn-store";
import { HealthResponse } from "../types";

const startTime = Date.now();

export function createHealthRouter(store: TurnStore): Router {
  const router = Router();

  router.get("/", (_req: Request, res: Response) => {
    const stats = store.getStats();
    const body: HealthResponse = {
      status: "ok",
      uptime: Math.floor((Date.now() - startTime) / 1000),
      activeTurns: stats.activeTurns,
      totalTurnsProcessed: stats.totalTurnsProcessed,
    };
    res.json(body);
  });

  return router;
}
