import express from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getLogger } from "../lib/logger-factory";
import { requirePermission, getCurrentUserId } from "../middleware/auth";
import prisma from "../lib/prisma";
import { getOwnContainerId } from "../services/self-update";
import {
  ensureFwAgent,
  restartFwAgent,
  findFwAgent,
  isFwAgentHealthy,
  getFwAgentConfig,
  FW_AGENT_STARTUP_STEPS,
} from "../services/egress/fw-agent-sidecar";
import { emitToChannel } from "../lib/socket";
import {
  Channel,
  ServerEvent,
  type EgressFwAgentStatus,
  type OperationStep,
} from "@mini-infra/types";

const logger = getLogger("stacks", "egress-fw-agent-routes");
const router = express.Router();

const SETTINGS_CATEGORY = "egress-fw-agent";

const configSchema = z.object({
  image: z.string().min(1).max(500).optional(),
  autoStart: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// GET /status — fw-agent health/status
// ---------------------------------------------------------------------------

router.get(
  "/status",
  requirePermission("egress:read"),
  async (_req: express.Request, res: express.Response) => {
    try {
      const ownContainerId = getOwnContainerId();
      if (!ownContainerId) {
        const status: EgressFwAgentStatus = {
          available: false,
          containerRunning: false,
          containerId: null,
          reason: "Not running inside a Docker container",
          health: null,
        };
        res.json({ success: true, ...status });
        return;
      }

      const existing = await findFwAgent();
      const healthy = isFwAgentHealthy();

      const status: EgressFwAgentStatus = {
        available: healthy && existing?.state === "running",
        containerRunning: existing?.state === "running",
        containerId: existing?.id?.slice(0, 12) ?? null,
        health: healthy ? { status: "ok" } : null,
      };
      res.json({ success: true, ...status });
    } catch (err) {
      logger.error({ err }, "Failed to get egress fw-agent status");
      res.status(500).json({ success: false, error: "Internal server error" });
    }
  },
);

// ---------------------------------------------------------------------------
// POST /restart — restart the fw-agent (long-running, tracked via Socket.IO)
// ---------------------------------------------------------------------------

const restartingFwAgent = new Set<string>();
const RESTART_GUARD_KEY = "egress-fw-agent";

router.post(
  "/restart",
  requirePermission("egress:write"),
  async (_req: express.Request, res: express.Response) => {
    try {
      if (restartingFwAgent.has(RESTART_GUARD_KEY)) {
        res.status(409).json({
          success: false,
          error: "Egress fw-agent startup already in progress",
        });
        return;
      }

      const operationId = randomUUID();
      const stepNames = [...FW_AGENT_STARTUP_STEPS];
      const totalSteps = stepNames.length;

      restartingFwAgent.add(RESTART_GUARD_KEY);

      res.json({ success: true, data: { operationId } });

      (async () => {
        const steps: OperationStep[] = [];

        try {
          emitToChannel(
            Channel.EGRESS_FW_AGENT,
            ServerEvent.EGRESS_FW_AGENT_STARTUP_STARTED,
            { operationId, totalSteps, stepNames: [...stepNames] },
          );

          const result = await restartFwAgent({
            onProgress: (step, completedCount, total) => {
              steps.push(step);
              try {
                emitToChannel(
                  Channel.EGRESS_FW_AGENT,
                  ServerEvent.EGRESS_FW_AGENT_STARTUP_STEP,
                  { operationId, step, completedCount, totalSteps: total },
                );
              } catch {
                /* never break restart */
              }
            },
          });

          if (!result) {
            emitToChannel(
              Channel.EGRESS_FW_AGENT,
              ServerEvent.EGRESS_FW_AGENT_STARTUP_COMPLETED,
              {
                operationId,
                success: false,
                steps,
                errors: [
                  "Egress fw-agent could not be started. Check image setting and Docker availability.",
                ],
              },
            );
            return;
          }

          emitToChannel(
            Channel.EGRESS_FW_AGENT,
            ServerEvent.EGRESS_FW_AGENT_STARTUP_COMPLETED,
            { operationId, success: true, steps, errors: [] },
          );
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error({ err }, "Egress fw-agent restart failed");
          emitToChannel(
            Channel.EGRESS_FW_AGENT,
            ServerEvent.EGRESS_FW_AGENT_STARTUP_COMPLETED,
            { operationId, success: false, steps, errors: [message] },
          );
        } finally {
          restartingFwAgent.delete(RESTART_GUARD_KEY);
        }
      })();
    } catch (err) {
      restartingFwAgent.delete(RESTART_GUARD_KEY);
      logger.error({ err }, "Failed to initiate egress fw-agent restart");
      res.status(500).json({ success: false, error: "Internal server error" });
    }
  },
);

// ---------------------------------------------------------------------------
// POST /start — start the fw-agent if not already running. Same shape as
// /restart but only acts when the agent is currently absent or stopped.
// Useful for "Start" button when autoStart was disabled.
// ---------------------------------------------------------------------------

router.post(
  "/start",
  requirePermission("egress:write"),
  async (_req: express.Request, res: express.Response) => {
    try {
      if (restartingFwAgent.has(RESTART_GUARD_KEY)) {
        res.status(409).json({
          success: false,
          error: "Egress fw-agent startup already in progress",
        });
        return;
      }

      const operationId = randomUUID();
      const stepNames = [...FW_AGENT_STARTUP_STEPS];
      const totalSteps = stepNames.length;

      restartingFwAgent.add(RESTART_GUARD_KEY);

      res.json({ success: true, data: { operationId } });

      (async () => {
        const steps: OperationStep[] = [];

        try {
          emitToChannel(
            Channel.EGRESS_FW_AGENT,
            ServerEvent.EGRESS_FW_AGENT_STARTUP_STARTED,
            { operationId, totalSteps, stepNames: [...stepNames] },
          );

          const result = await ensureFwAgent({
            onProgress: (step, completedCount, total) => {
              steps.push(step);
              try {
                emitToChannel(
                  Channel.EGRESS_FW_AGENT,
                  ServerEvent.EGRESS_FW_AGENT_STARTUP_STEP,
                  { operationId, step, completedCount, totalSteps: total },
                );
              } catch {
                /* never break start */
              }
            },
          });

          emitToChannel(
            Channel.EGRESS_FW_AGENT,
            ServerEvent.EGRESS_FW_AGENT_STARTUP_COMPLETED,
            {
              operationId,
              success: !!result,
              steps,
              errors: result
                ? []
                : ["Egress fw-agent could not be started. Check image setting and Docker availability."],
            },
          );
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error({ err }, "Egress fw-agent start failed");
          emitToChannel(
            Channel.EGRESS_FW_AGENT,
            ServerEvent.EGRESS_FW_AGENT_STARTUP_COMPLETED,
            { operationId, success: false, steps, errors: [message] },
          );
        } finally {
          restartingFwAgent.delete(RESTART_GUARD_KEY);
        }
      })();
    } catch (err) {
      restartingFwAgent.delete(RESTART_GUARD_KEY);
      logger.error({ err }, "Failed to initiate egress fw-agent start");
      res.status(500).json({ success: false, error: "Internal server error" });
    }
  },
);

// ---------------------------------------------------------------------------
// GET /config — current image + autoStart
// ---------------------------------------------------------------------------

router.get(
  "/config",
  requirePermission("settings:read"),
  async (_req: express.Request, res: express.Response) => {
    try {
      const config = await getFwAgentConfig();
      res.json({ success: true, config });
    } catch (err) {
      logger.error({ err }, "Failed to get egress fw-agent config");
      res.status(500).json({ success: false, error: "Internal server error" });
    }
  },
);

// ---------------------------------------------------------------------------
// PATCH /config — update image / autoStart
// ---------------------------------------------------------------------------

router.patch(
  "/config",
  requirePermission("settings:write"),
  async (req: express.Request, res: express.Response) => {
    try {
      const parsed = configSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
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
      if (updates.image !== undefined)
        settingEntries.push({ key: "image", value: updates.image });
      if (updates.autoStart !== undefined)
        settingEntries.push({ key: "auto_start", value: String(updates.autoStart) });

      for (const { key, value } of settingEntries) {
        await prisma.systemSettings.upsert({
          where: { category_key: { category: SETTINGS_CATEGORY, key } },
          create: {
            category: SETTINGS_CATEGORY,
            key,
            value,
            createdBy: userId,
            updatedBy: userId,
          },
          update: { value, updatedBy: userId },
        });
      }

      const config = await getFwAgentConfig();
      res.json({ success: true, config });
    } catch (err) {
      logger.error({ err }, "Failed to update egress fw-agent config");
      res.status(500).json({ success: false, error: "Internal server error" });
    }
  },
);

export default router;
