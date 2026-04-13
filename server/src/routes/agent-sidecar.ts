import express from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { appLogger } from "../lib/logger-factory";
import { requirePermission, getCurrentUserId } from "../middleware/auth";
import prisma from "../lib/prisma";
import { getOwnContainerId } from "../services/self-update";
import {
  getAgentSidecarUrl,
  isAgentSidecarHealthy,
  proxyToSidecar,
  restartAgentSidecar,
  findAgentSidecar,
  getAgentSidecarConfig,
  SIDECAR_STARTUP_STEPS,
} from "../services/agent-sidecar";
import { emitToChannel } from "../lib/socket";
import { Channel, ServerEvent, type OperationStep } from "@mini-infra/types";

const logger = appLogger();
const router = express.Router();

const SETTINGS_CATEGORY = "agent-sidecar";

const configSchema = z.object({
  model: z.string().min(1).max(100).optional(),
  timeoutMs: z.number().int().min(10000).max(600000).optional(),
  autoStart: z.boolean().optional(),
  image: z.string().min(1).max(500).optional(),
});

// ---------------------------------------------------------------------------
// GET /status — agent sidecar health/status
// ---------------------------------------------------------------------------

router.get(
  "/status",
  requirePermission("agent:read"),
  async (_req: express.Request, res: express.Response) => {
    try {
      const containerId = getOwnContainerId();
      const sidecarUrl = getAgentSidecarUrl();
      const healthy = isAgentSidecarHealthy();

      if (!containerId && !sidecarUrl) {
        res.json({
          success: true,
          available: false,
          reason: "Not running inside a Docker container",
          containerRunning: false,
          health: null,
        });
        return;
      }

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

      // Dev mode: no Docker container info
      if (!containerId) {
        res.json({
          success: true,
          available: !!sidecarUrl && healthy,
          containerRunning: false,
          containerId: "dev-local",
          health,
        });
        return;
      }

      const existing = await findAgentSidecar();

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
// POST /restart — restart the agent sidecar (long-running, tracked via Socket.IO)
// ---------------------------------------------------------------------------

const restartingAgentSidecar = new Set<string>();
const RESTART_GUARD_KEY = "agent-sidecar";

router.post(
  "/restart",
  requirePermission("agent:write"),
  async (_req: express.Request, res: express.Response) => {
    try {
      if (restartingAgentSidecar.has(RESTART_GUARD_KEY)) {
        res.status(409).json({
          success: false,
          error: "Agent sidecar startup already in progress",
        });
        return;
      }

      const operationId = randomUUID();
      const stepNames = [...SIDECAR_STARTUP_STEPS];
      const totalSteps = stepNames.length;

      restartingAgentSidecar.add(RESTART_GUARD_KEY);

      // Return immediately with operationId
      res.json({ success: true, data: { operationId } });

      // Run in background
      (async () => {
        const steps: OperationStep[] = [];

        try {
          emitToChannel(Channel.AGENT_SIDECAR, ServerEvent.SIDECAR_STARTUP_STARTED, {
            operationId,
            totalSteps,
            stepNames: [...stepNames],
          });

          const result = await restartAgentSidecar({
            onProgress: (step, completedCount, total) => {
              steps.push(step);
              try {
                emitToChannel(Channel.AGENT_SIDECAR, ServerEvent.SIDECAR_STARTUP_STEP, {
                  operationId,
                  step,
                  completedCount,
                  totalSteps: total,
                });
              } catch { /* never break restart */ }
            },
          });

          if (!result) {
            emitToChannel(Channel.AGENT_SIDECAR, ServerEvent.SIDECAR_STARTUP_COMPLETED, {
              operationId,
              success: false,
              steps,
              errors: ["Sidecar could not be started. Check settings and Docker availability."],
            });
            return;
          }

          emitToChannel(Channel.AGENT_SIDECAR, ServerEvent.SIDECAR_STARTUP_COMPLETED, {
            operationId,
            success: true,
            steps,
            errors: [],
          });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error({ err }, "Agent sidecar restart failed");
          emitToChannel(Channel.AGENT_SIDECAR, ServerEvent.SIDECAR_STARTUP_COMPLETED, {
            operationId,
            success: false,
            steps,
            errors: [message],
          });
        } finally {
          restartingAgentSidecar.delete(RESTART_GUARD_KEY);
        }
      })();
    } catch (err) {
      restartingAgentSidecar.delete(RESTART_GUARD_KEY);
      logger.error({ err }, "Failed to initiate agent sidecar restart");
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
          .json({
            success: false,
            error: "Validation error",
            details: parsed.error.issues,
          });
        return;
      }

      const userId = getCurrentUserId(req);
      if (!userId) {
        res.status(401).json({ success: false, error: "Unauthorized" });
        return;
      }

      const updates = parsed.data;
      const settingEntries: Array<{ key: string; value: string }> = [];

      if (updates.model !== undefined)
        settingEntries.push({ key: "model", value: updates.model });
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

export default router;
