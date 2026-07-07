import express from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getLogger } from "../lib/logger-factory";
import { requirePermission, getCurrentUserId } from "../middleware/auth";
import { asyncHandler } from "../lib/async-handler";
import prisma from "../lib/prisma";
import { getOwnContainerId } from "../services/self-update";
import {
  restartFwAgent,
  findFwAgent,
  isFwAgentHealthy,
  getFwAgentConnState,
  composeFwAgentStatus,
  getFwAgentConfig,
  FW_AGENT_STARTUP_STEPS,
} from "../services/egress/fw-agent-sidecar";
import { emitToChannel } from "../lib/socket";
import { Channel, ServerEvent, type EgressFwAgentStatus, type OperationStep, Permission, ErrorCode } from "@mini-infra/types";
import { ConflictError, UnauthorizedError } from "../lib/errors";

const logger = getLogger("stacks", "egress-fw-agent-routes");
const router = express.Router();

const SETTINGS_CATEGORY = "egress-fw-agent";

const configSchema = z.object({
  image: z.string().min(1).max(500).optional(),
  autoStart: z.boolean().optional(),
  autoRemediation: z.boolean().optional(),
  liveCredRefresh: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// GET /status — fw-agent health/status
// ---------------------------------------------------------------------------

router.get(
  "/status",
  requirePermission(Permission.EgressRead),
  asyncHandler(async (_req, res) => {
    const ownContainerId = getOwnContainerId();
    if (!ownContainerId) {
      const status: EgressFwAgentStatus = composeFwAgentStatus({
        ownContainerId,
        found: null,
        healthy: false,
        connState: null,
      });
      res.json({ success: true, ...status });
      return;
    }

    const existing = await findFwAgent();

    // In-band KV heartbeat (functional health) + out-of-band /healthz scrape
    // (connection state — reports auth-failed even when the heartbeat can't).
    const status: EgressFwAgentStatus = composeFwAgentStatus({
      ownContainerId,
      found: existing,
      healthy: isFwAgentHealthy(),
      connState: getFwAgentConnState(),
    });
    res.json({ success: true, ...status });
  }),
);

// ---------------------------------------------------------------------------
// POST /restart — restart the fw-agent (long-running, tracked via Socket.IO)
// ---------------------------------------------------------------------------

const restartingFwAgent = new Set<string>();
const RESTART_GUARD_KEY = "egress-fw-agent";

router.post(
  "/restart",
  requirePermission(Permission.EgressWrite),
  asyncHandler(async (_req, res) => {
    if (restartingFwAgent.has(RESTART_GUARD_KEY)) {
      throw new ConflictError(
        ErrorCode.EGRESS_FW_AGENT_STARTUP_IN_PROGRESS,
        "Egress fw-agent startup already in progress",
        {
          resource: { type: "egressFwAgent" },
          action: "Wait for the current startup to finish, then retry.",
        },
      );
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
  }),
);

// ---------------------------------------------------------------------------
// POST /start — start the fw-agent if not already running. Same shape as
// /restart but only acts when the agent is currently absent or stopped.
// Useful for "Start" button when autoStart was disabled.
// ---------------------------------------------------------------------------

router.post(
  "/start",
  requirePermission(Permission.EgressWrite),
  asyncHandler(async (_req, res) => {
    if (restartingFwAgent.has(RESTART_GUARD_KEY)) {
      throw new ConflictError(
        ErrorCode.EGRESS_FW_AGENT_STARTUP_IN_PROGRESS,
        "Egress fw-agent startup already in progress",
        {
          resource: { type: "egressFwAgent" },
          action: "Wait for the current startup to finish, then retry.",
        },
      );
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

        // ALT-27: /start now triggers the same stack-bootstrap apply as
        // /restart. The legacy host-singleton had a meaningful "start vs
        // restart" distinction (recreate-vs-reattach); a stack apply is
        // idempotent and handles both. Keep the route for backward compat
        // with the settings card that has separate buttons.
        const result = await restartFwAgent({
          onProgress: (step: OperationStep, completedCount: number, total: number) => {
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
  }),
);

// ---------------------------------------------------------------------------
// GET /config — current image + autoStart
// ---------------------------------------------------------------------------

router.get(
  "/config",
  requirePermission(Permission.SettingsRead),
  asyncHandler(async (_req, res) => {
    const config = await getFwAgentConfig();
    res.json({ success: true, config });
  }),
);

// ---------------------------------------------------------------------------
// PATCH /config — update image / autoStart
// ---------------------------------------------------------------------------

router.patch(
  "/config",
  requirePermission(Permission.SettingsWrite),
  asyncHandler(async (req, res) => {
    const updates = configSchema.parse(req.body);

    const userId = getCurrentUserId(req);
    if (!userId) {
      throw new UnauthorizedError(
        ErrorCode.USER_NOT_AUTHENTICATED,
        "User not authenticated",
      );
    }

    const settingEntries: Array<{ key: string; value: string }> = [];
    if (updates.image !== undefined)
      settingEntries.push({ key: "image", value: updates.image });
    if (updates.autoStart !== undefined)
      settingEntries.push({ key: "auto_start", value: String(updates.autoStart) });
    if (updates.autoRemediation !== undefined)
      settingEntries.push({ key: "auto_remediation", value: String(updates.autoRemediation) });
    if (updates.liveCredRefresh !== undefined)
      settingEntries.push({ key: "live_cred_refresh", value: String(updates.liveCredRefresh) });

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
  }),
);

export default router;
