import express, {
  Request,
  Response,
  NextFunction,
  RequestHandler,
} from "express";
import crypto from "crypto";
import { z } from "zod";
import {
  requirePermission,
  getAuthenticatedUser,
} from "../../middleware/auth";
import { getLogger } from "../../lib/logger-factory";
import { getVaultServices } from "../../services/vault/vault-services";
import {
  BOOTSTRAP_STEP_NAMES,
  UNSEAL_STEP_NAMES,
} from "../../services/vault/vault-admin-service";
import { emitToChannel } from "../../lib/socket";
import { Channel, ServerEvent } from "@mini-infra/types";
import type {
  VaultStatus,
  VaultBootstrapResult,
  OperationStep,
} from "@mini-infra/types";

const logger = getLogger("platform", "vault-routes");

const router = express.Router();

// ── Status ──────────────────────────────────────────────

router.get(
  "/status",
  requirePermission("vault:read") as RequestHandler,
  (async (req: Request, res: Response, next: NextFunction) => {
    try {
      const services = getVaultServices();
      await services.passphrase.refresh();
      const status = await services.healthWatcher.currentStatus();
      res.json({ success: true, data: status satisfies VaultStatus });
    } catch (err) {
      next(err);
    }
  }) as RequestHandler,
);

// ── Passphrase ──────────────────────────────────────────

const passphraseSchema = z.object({
  passphrase: z.string().min(8, "Passphrase must be at least 8 characters"),
});

router.post(
  "/passphrase/unlock",
  requirePermission("vault:admin") as RequestHandler,
  (async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const parsed = passphraseSchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid passphrase payload" });
      }
      const services = getVaultServices();
      await services.passphrase.unlock(parsed.data.passphrase);
      try {
        emitToChannel(Channel.VAULT, ServerEvent.VAULT_PASSPHRASE_UNLOCKED, {
          state: "unlocked",
        });
      } catch (err) {
        logger.debug({ err }, "Failed to emit VAULT_PASSPHRASE_UNLOCKED");
      }

      // Best-effort: re-authenticate admin token against Vault so subsequent
      // ops work without an explicit reconnect step. Non-fatal on failure.
      try {
        await services.admin.authenticateAsAdmin();
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "Post-unlock admin re-authentication failed (non-fatal)",
        );
      }

      res.json({ success: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(401).json({ success: false, message: msg });
    }
  }) as RequestHandler,
);

router.post(
  "/passphrase/lock",
  requirePermission("vault:admin") as RequestHandler,
  (async (_req: Request, res: Response) => {
    const services = getVaultServices();
    services.passphrase.lock();
    try {
      emitToChannel(Channel.VAULT, ServerEvent.VAULT_PASSPHRASE_LOCKED, {
        state: "locked",
      });
    } catch (err) {
      logger.debug({ err }, "Failed to emit VAULT_PASSPHRASE_LOCKED");
    }
    res.json({ success: true });
  }) as RequestHandler,
);

// ── Admin re-authentication ─────────────────────────────

// Allows external tooling (e.g. installers) to force a refresh of the cached
// admin token without going through the lock + unlock UI dance. Gated on
// passphrase being unlocked so it can't bypass operator-presence requirements.
router.post(
  "/admin/reauthenticate",
  requirePermission("vault:admin") as RequestHandler,
  (async (_req: Request, res: Response) => {
    const services = getVaultServices();
    if (!services.passphrase.isUnlocked()) {
      return res.status(400).json({
        success: false,
        message: "Operator passphrase must be unlocked",
      });
    }
    try {
      await services.admin.authenticateAsAdmin();
      res.json({ success: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, "Admin re-authentication failed");
      res.status(500).json({ success: false, message: msg });
    }
  }) as RequestHandler,
);

// ── Bootstrap ───────────────────────────────────────────

const bootstrapSchema = z.object({
  passphrase: z.string().min(8),
  address: z.string().url(),
  stackId: z.string().optional(),
});

router.post(
  "/bootstrap",
  requirePermission("vault:admin") as RequestHandler,
  (async (req: Request, res: Response) => {
    const parsed = bootstrapSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid bootstrap payload",
        details: parsed.error.issues,
      });
    }
    const services = getVaultServices();
    const user = getAuthenticatedUser(req);

    const operationId = `vault-bootstrap-${crypto.randomUUID()}`;
    const total = BOOTSTRAP_STEP_NAMES.length;
    const steps: OperationStep[] = [];

    try {
      emitToChannel(Channel.VAULT, ServerEvent.VAULT_BOOTSTRAP_STARTED, {
        operationId,
        totalSteps: total,
        stepNames: [...BOOTSTRAP_STEP_NAMES],
      });
    } catch (err) {
      logger.debug({ err }, "Failed to emit VAULT_BOOTSTRAP_STARTED");
    }

    // Bootstrap is run synchronously and returns the one-time-viewable
    // credentials only on this HTTP response. Progress events still broadcast
    // on Channel.VAULT (step + completed), but WITHOUT the credentials blob —
    // otherwise any authenticated socket subscriber could read them.
    let result: VaultBootstrapResult | null = null;
    let success = false;
    const errors: string[] = [];
    try {
      result = await services.admin.bootstrap({
        passphrase: parsed.data.passphrase,
        address: parsed.data.address,
        stackId: parsed.data.stackId,
        onStep: (step, completedCount, totalSteps) => {
          steps.push(step);
          try {
            emitToChannel(Channel.VAULT, ServerEvent.VAULT_BOOTSTRAP_STEP, {
              operationId,
              step,
              completedCount,
              totalSteps,
            });
          } catch (err) {
            logger.debug({ err }, "Failed to emit VAULT_BOOTSTRAP_STEP");
          }
        },
      });
      success = true;
    } catch (err) {
      const bootstrapError = err instanceof Error ? err : new Error(String(err));
      errors.push(bootstrapError.message);
      logger.error(
        { err: bootstrapError.message, operationId, userId: user?.id },
        "Vault bootstrap failed",
      );
    }

    try {
      emitToChannel(Channel.VAULT, ServerEvent.VAULT_BOOTSTRAP_COMPLETED, {
        operationId,
        success,
        steps,
        errors,
      });
    } catch (err) {
      logger.debug({ err }, "Failed to emit VAULT_BOOTSTRAP_COMPLETED");
    }

    if (!success || !result) {
      return res.status(500).json({
        success: false,
        message: "Bootstrap failed",
        data: { operationId, errors },
      });
    }
    return res.json({
      success: true,
      data: { operationId, result },
    });
  }) as RequestHandler,
);

// ── Unseal (operator-triggered) ─────────────────────────

router.post(
  "/unseal",
  requirePermission("vault:admin") as RequestHandler,
  (async (req: Request, res: Response) => {
    const services = getVaultServices();
    if (!services.passphrase.isUnlocked()) {
      return res.status(400).json({
        success: false,
        message: "Operator passphrase must be unlocked before unseal",
      });
    }
    const operationId = `vault-unseal-${crypto.randomUUID()}`;
    const total = UNSEAL_STEP_NAMES.length;
    const steps: OperationStep[] = [];

    try {
      emitToChannel(Channel.VAULT, ServerEvent.VAULT_UNSEAL_STARTED, {
        operationId,
        totalSteps: total,
        stepNames: [...UNSEAL_STEP_NAMES],
      });
    } catch (err) {
      logger.debug({ err }, "Failed to emit VAULT_UNSEAL_STARTED");
    }

    res.json({ success: true, data: { operationId } });

    void (async () => {
      let success = false;
      const errors: string[] = [];
      try {
        await services.admin.unseal((step, completedCount, totalSteps) => {
          steps.push(step);
          try {
            emitToChannel(Channel.VAULT, ServerEvent.VAULT_UNSEAL_STEP, {
              operationId,
              step,
              completedCount,
              totalSteps,
            });
          } catch (err) {
            logger.debug({ err }, "Failed to emit VAULT_UNSEAL_STEP");
          }
        });
        success = true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(msg);
      } finally {
        try {
          emitToChannel(Channel.VAULT, ServerEvent.VAULT_UNSEAL_COMPLETED, {
            operationId,
            success,
            steps,
            errors,
          });
        } catch (err) {
          logger.debug({ err }, "Failed to emit VAULT_UNSEAL_COMPLETED");
        }
      }
    })();
  }) as RequestHandler,
);

// ── Operator credentials read-back ──────────────────────

router.get(
  "/operator-credentials",
  requirePermission("vault:admin") as RequestHandler,
  (async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const services = getVaultServices();
      if (!services.passphrase.isUnlocked()) {
        return res.status(400).json({
          success: false,
          message: "Operator passphrase must be unlocked",
        });
      }
      const password = await services.stateService.readOperatorPassword();
      res.json({
        success: true,
        data: {
          username: "mini-infra-operator",
          password,
        },
      });
    } catch (err) {
      next(err);
    }
  }) as RequestHandler,
);

export default router;
