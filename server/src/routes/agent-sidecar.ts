import express from "express";
import { z } from "zod";
import { appLogger } from "../lib/logger-factory";
import { requirePermission, getCurrentUserId } from "../middleware/auth";
import prisma from "../lib/prisma";
import { getOwnContainerId } from "../services/self-update";
import {
  getAgentSidecarUrl,
  getInternalToken,
  isAgentSidecarHealthy,
  proxyToSidecar,
  restartAgentSidecar,
  findAgentSidecar,
  getAgentSidecarConfig,
} from "../services/agent-sidecar";

const logger = appLogger();
const router = express.Router();

const SETTINGS_CATEGORY = "agent-sidecar";

// Validation schemas
const createTaskSchema = z.object({
  prompt: z.string().min(1).max(4000),
  context: z.record(z.string(), z.unknown()).optional(),
});

const configSchema = z.object({
  enabled: z.boolean().optional(),
  model: z.string().min(1).max(100).optional(),
  maxTurns: z.number().int().min(1).max(200).optional(),
  timeoutMs: z.number().int().min(10000).max(600000).optional(),
  autoStart: z.boolean().optional(),
  image: z.string().min(1).max(500).optional(),
});

// ---------------------------------------------------------------------------
// POST /tasks — create a new agent task
// ---------------------------------------------------------------------------

router.post(
  "/tasks",
  requirePermission("agent:write"),
  async (req: express.Request, res: express.Response) => {
    try {
      const parsed = createTaskSchema.safeParse(req.body);
      if (!parsed.success) {
        res
          .status(400)
          .json({ success: false, error: "Validation error", details: parsed.error.issues });
        return;
      }

      const sidecarUrl = getAgentSidecarUrl();
      if (!sidecarUrl) {
        res.status(503).json({
          success: false,
          error: "Agent sidecar not available",
          message:
            "The agent sidecar container is not running. Enable it in Settings.",
        });
        return;
      }

      const userId = getCurrentUserId(req);
      if (!userId) {
        res.status(401).json({ success: false, error: "Unauthorized" });
        return;
      }

      logger.info(
        { userId, prompt: parsed.data.prompt.slice(0, 100) },
        "Agent sidecar task requested",
      );

      // Proxy to sidecar
      const response = await proxyToSidecar("/tasks", {
        method: "POST",
        body: parsed.data,
      });

      if (response.status === 429) {
        const body = await response.json();
        res.status(429).json({ success: false, ...body });
        return;
      }

      if (!response.ok) {
        const text = await response.text();
        logger.error(
          { status: response.status, body: text },
          "Sidecar task creation failed",
        );
        res.status(response.status).json({
          success: false,
          error: `Sidecar error: ${response.status}`,
        });
        return;
      }

      const taskData = await response.json();

      // Persist to main DB for audit
      const dbTask = await prisma.agentTask.create({
        data: {
          externalId: taskData.id,
          prompt: parsed.data.prompt,
          status: taskData.status,
          triggeredBy: userId,
          context: parsed.data.context
            ? JSON.stringify(parsed.data.context)
            : null,
        },
      });

      res.status(201).json({
        success: true,
        task: {
          id: dbTask.id,
          externalId: taskData.id,
          status: taskData.status,
          prompt: parsed.data.prompt,
          createdAt: dbTask.createdAt.toISOString(),
        },
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unknown error";
      logger.error({ err }, "Failed to create agent sidecar task");
      res.status(503).json({
        success: false,
        error: "Agent sidecar unreachable",
        message,
      });
    }
  },
);

// ---------------------------------------------------------------------------
// GET /tasks — list recent tasks
// ---------------------------------------------------------------------------

router.get(
  "/tasks",
  requirePermission("agent:read"),
  async (_req: express.Request, res: express.Response) => {
    try {
      const tasks = await prisma.agentTask.findMany({
        orderBy: { createdAt: "desc" },
        take: 50,
      });

      res.json({
        success: true,
        tasks: tasks.map((t) => ({
          id: t.id,
          externalId: t.externalId,
          status: t.status,
          prompt: t.prompt,
          triggeredBy: t.triggeredBy,
          createdAt: t.createdAt.toISOString(),
          completedAt: t.completedAt?.toISOString() ?? null,
          durationMs: t.durationMs,
        })),
      });
    } catch (err) {
      logger.error({ err }, "Failed to list agent tasks");
      res.status(500).json({ success: false, error: "Internal server error" });
    }
  },
);

// ---------------------------------------------------------------------------
// GET /tasks/:id — get task detail
// ---------------------------------------------------------------------------

router.get(
  "/tasks/:id",
  requirePermission("agent:read"),
  async (req: express.Request, res: express.Response) => {
    try {
      const dbTask = await prisma.agentTask.findUnique({
        where: { id: req.params.id },
      });

      if (!dbTask) {
        res.status(404).json({ success: false, error: "Task not found" });
        return;
      }

      // If task is still running, try to get live data from sidecar
      if (dbTask.status === "running" && getAgentSidecarUrl()) {
        try {
          const response = await proxyToSidecar(
            `/tasks/${dbTask.externalId}`,
            { method: "GET" },
          );

          if (response.ok) {
            const liveData = await response.json();

            // Sync terminal status to DB
            if (liveData.status !== "running") {
              await prisma.agentTask.update({
                where: { id: dbTask.id },
                data: {
                  status: liveData.status,
                  result: liveData.result,
                  errorMessage: liveData.error,
                  tokenUsage: liveData.tokenUsage
                    ? JSON.stringify(liveData.tokenUsage)
                    : null,
                  completedAt: liveData.completedAt
                    ? new Date(liveData.completedAt)
                    : null,
                  durationMs: liveData.durationMs,
                },
              });
            }

            res.json({
              success: true,
              task: {
                id: dbTask.id,
                externalId: dbTask.externalId,
                status: liveData.status,
                prompt: dbTask.prompt,
                result: liveData.result,
                errorMessage: liveData.error,
                tokenUsage: liveData.tokenUsage,
                toolCalls: liveData.toolCalls,
                context: dbTask.context
                  ? JSON.parse(dbTask.context)
                  : null,
                triggeredBy: dbTask.triggeredBy,
                createdAt: dbTask.createdAt.toISOString(),
                completedAt: liveData.completedAt,
                durationMs: liveData.durationMs,
              },
            });
            return;
          }
        } catch {
          // Sidecar unreachable — fall through to DB data
        }
      }

      // Return DB data
      res.json({
        success: true,
        task: {
          id: dbTask.id,
          externalId: dbTask.externalId,
          status: dbTask.status,
          prompt: dbTask.prompt,
          result: dbTask.result,
          errorMessage: dbTask.errorMessage,
          tokenUsage: dbTask.tokenUsage
            ? JSON.parse(dbTask.tokenUsage)
            : null,
          context: dbTask.context ? JSON.parse(dbTask.context) : null,
          triggeredBy: dbTask.triggeredBy,
          createdAt: dbTask.createdAt.toISOString(),
          completedAt: dbTask.completedAt?.toISOString() ?? null,
          durationMs: dbTask.durationMs,
        },
      });
    } catch (err) {
      logger.error({ err }, "Failed to get agent task");
      res.status(500).json({ success: false, error: "Internal server error" });
    }
  },
);

// ---------------------------------------------------------------------------
// GET /tasks/:id/stream — SSE relay
// ---------------------------------------------------------------------------

router.get(
  "/tasks/:id/stream",
  requirePermission("agent:read"),
  async (req: express.Request, res: express.Response) => {
    try {
      const dbTask = await prisma.agentTask.findUnique({
        where: { id: req.params.id },
      });

      if (!dbTask) {
        res.status(404).json({ success: false, error: "Task not found" });
        return;
      }

      const sidecarUrl = getAgentSidecarUrl();
      if (!sidecarUrl) {
        res.status(503).json({
          success: false,
          error: "Agent sidecar not available",
        });
        return;
      }

      // Set SSE headers
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");

      // Connect to sidecar SSE stream
      const token = getInternalToken();
      const headers: Record<string, string> = {};
      if (token) {
        headers["Authorization"] = `Bearer ${token}`;
      }

      const upstream = await fetch(
        `${sidecarUrl}/tasks/${dbTask.externalId}/stream`,
        { headers, signal: AbortSignal.timeout(300_000) },
      );

      if (!upstream.ok || !upstream.body) {
        res.write(
          `event: error\ndata: ${JSON.stringify({ status: "failed", error: "Failed to connect to sidecar stream" })}\n\n`,
        );
        res.end();
        return;
      }

      // Pipe upstream SSE to client
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const pump = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            buffer += chunk;
            res.write(chunk);

            // Check for terminal events to sync DB
            if (
              chunk.includes("event: complete") ||
              chunk.includes("event: error")
            ) {
              syncTaskStatusFromSidecar(dbTask.id, dbTask.externalId);
            }
          }
        } catch {
          // Stream closed
        }
        res.end();
      };

      pump();

      req.on("close", () => {
        reader.cancel();
      });
    } catch (err) {
      logger.error({ err }, "Failed to stream agent task");
      if (!res.headersSent) {
        res
          .status(503)
          .json({ success: false, error: "Agent sidecar unreachable" });
      }
    }
  },
);

// ---------------------------------------------------------------------------
// POST /tasks/:id/cancel — cancel a running task
// ---------------------------------------------------------------------------

router.post(
  "/tasks/:id/cancel",
  requirePermission("agent:write"),
  async (req: express.Request, res: express.Response) => {
    try {
      const dbTask = await prisma.agentTask.findUnique({
        where: { id: req.params.id },
      });

      if (!dbTask) {
        res.status(404).json({ success: false, error: "Task not found" });
        return;
      }

      if (dbTask.status !== "running") {
        res.status(409).json({
          success: false,
          error: "Task is not running",
          message: `Task is in '${dbTask.status}' state and cannot be cancelled`,
        });
        return;
      }

      // Proxy cancel to sidecar
      if (getAgentSidecarUrl()) {
        try {
          await proxyToSidecar(`/tasks/${dbTask.externalId}/cancel`, {
            method: "POST",
          });
        } catch {
          // Sidecar might be down, still update DB
        }
      }

      // Update DB
      await prisma.agentTask.update({
        where: { id: dbTask.id },
        data: {
          status: "cancelled",
          completedAt: new Date(),
          durationMs: Date.now() - dbTask.createdAt.getTime(),
        },
      });

      res.json({ success: true, id: dbTask.id, status: "cancelled" });
    } catch (err) {
      logger.error({ err }, "Failed to cancel agent task");
      res.status(500).json({ success: false, error: "Internal server error" });
    }
  },
);

// ---------------------------------------------------------------------------
// GET /status — agent sidecar health/status
// ---------------------------------------------------------------------------

router.get(
  "/status",
  requirePermission("agent:read"),
  async (_req: express.Request, res: express.Response) => {
    try {
      const containerId = getOwnContainerId();
      if (!containerId) {
        res.json({
          success: true,
          available: false,
          reason: "Not running inside a Docker container",
          containerRunning: false,
          health: null,
        });
        return;
      }

      const sidecarUrl = getAgentSidecarUrl();
      const existing = await findAgentSidecar();
      const healthy = isAgentSidecarHealthy();

      let health = null;
      if (sidecarUrl && healthy) {
        try {
          const response = await proxyToSidecar("/health", { method: "GET" });
          if (response.ok) {
            health = await response.json();
          }
        } catch {
          // Sidecar unreachable
        }
      }

      res.json({
        success: true,
        available: !!sidecarUrl && healthy,
        containerRunning: existing?.state === "running",
        containerId: existing?.id?.slice(0, 12) ?? null,
        health,
      });
    } catch (err) {
      logger.error({ err }, "Failed to get agent sidecar status");
      res.status(500).json({ success: false, error: "Internal server error" });
    }
  },
);

// ---------------------------------------------------------------------------
// POST /restart — restart the agent sidecar
// ---------------------------------------------------------------------------

router.post(
  "/restart",
  requirePermission("agent:write"),
  async (_req: express.Request, res: express.Response) => {
    try {
      const result = await restartAgentSidecar();
      if (!result) {
        res.status(503).json({
          success: false,
          error: "Failed to restart agent sidecar",
          message:
            "The sidecar could not be started. Check settings and Docker availability.",
        });
        return;
      }

      res.json({
        success: true,
        containerId: result.containerId.slice(0, 12),
        url: result.url,
      });
    } catch (err) {
      logger.error({ err }, "Failed to restart agent sidecar");
      res.status(500).json({ success: false, error: "Internal server error" });
    }
  },
);

// ---------------------------------------------------------------------------
// GET /config — get agent sidecar configuration
// ---------------------------------------------------------------------------

router.get(
  "/config",
  requirePermission("settings:read"),
  async (_req: express.Request, res: express.Response) => {
    try {
      const config = await getAgentSidecarConfig();
      res.json({ success: true, config });
    } catch (err) {
      logger.error({ err }, "Failed to get agent sidecar config");
      res.status(500).json({ success: false, error: "Internal server error" });
    }
  },
);

// ---------------------------------------------------------------------------
// PUT /config — update agent sidecar configuration
// ---------------------------------------------------------------------------

router.put(
  "/config",
  requirePermission("settings:write"),
  async (req: express.Request, res: express.Response) => {
    try {
      const parsed = configSchema.safeParse(req.body);
      if (!parsed.success) {
        res
          .status(400)
          .json({ success: false, error: "Validation error", details: parsed.error.issues });
        return;
      }

      const userId = getCurrentUserId(req);
      if (!userId) {
        res.status(401).json({ success: false, error: "Unauthorized" });
        return;
      }

      const updates = parsed.data;
      const settingEntries: Array<{ key: string; value: string }> = [];

      if (updates.enabled !== undefined)
        settingEntries.push({ key: "enabled", value: String(updates.enabled) });
      if (updates.model !== undefined)
        settingEntries.push({ key: "model", value: updates.model });
      if (updates.maxTurns !== undefined)
        settingEntries.push({
          key: "max_turns",
          value: String(updates.maxTurns),
        });
      if (updates.timeoutMs !== undefined)
        settingEntries.push({
          key: "timeout_ms",
          value: String(updates.timeoutMs),
        });
      if (updates.autoStart !== undefined)
        settingEntries.push({
          key: "auto_start",
          value: String(updates.autoStart),
        });
      if (updates.image !== undefined)
        settingEntries.push({ key: "image", value: updates.image });

      for (const { key, value } of settingEntries) {
        await prisma.systemSettings.upsert({
          where: {
            category_key: { category: SETTINGS_CATEGORY, key },
          },
          create: {
            category: SETTINGS_CATEGORY,
            key,
            value,
            createdBy: userId,
            updatedBy: userId,
          },
          update: {
            value,
            updatedBy: userId,
          },
        });
      }

      const config = await getAgentSidecarConfig();
      res.json({ success: true, config });
    } catch (err) {
      logger.error({ err }, "Failed to update agent sidecar config");
      res.status(500).json({ success: false, error: "Internal server error" });
    }
  },
);

// ---------------------------------------------------------------------------
// Helper: sync task status from sidecar to DB (fire-and-forget)
// ---------------------------------------------------------------------------

async function syncTaskStatusFromSidecar(
  dbTaskId: string,
  externalId: string,
): Promise<void> {
  try {
    const response = await proxyToSidecar(`/tasks/${externalId}`, {
      method: "GET",
    });
    if (!response.ok) return;

    const data = await response.json();
    if (data.status === "running") return;

    await prisma.agentTask.update({
      where: { id: dbTaskId },
      data: {
        status: data.status,
        result: data.result,
        errorMessage: data.error,
        tokenUsage: data.tokenUsage
          ? JSON.stringify(data.tokenUsage)
          : null,
        completedAt: data.completedAt ? new Date(data.completedAt) : new Date(),
        durationMs: data.durationMs,
      },
    });
  } catch {
    // Non-critical — status will sync on next GET
  }
}

export default router;
