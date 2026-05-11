import { Router, type Request } from "express";
import { z } from "zod";
import prisma from "../../lib/prisma";
import { asyncHandler } from "../../lib/async-handler";
import { requirePermission, getAuthenticatedUser } from "../../middleware/auth";
import { getLogger } from "../../lib/logger-factory";
import {
  getVaultKVService,
  VaultKVError,
} from "../../services/vault/vault-kv-service";
import { UserEventService } from "../../services/user-events/user-event-service";
import type { UserEventStatus } from "@mini-infra/types";

const log = getLogger("stacks", "stacks-git-deploy-key-route");

/**
 * Audit-log a git-deploy-key write or delete via the same `UserEventService`
 * surface `routes/vault/kv.ts` uses for brokered KV writes. The key material
 * is NEVER part of the audit metadata — we record `{ stackId, serviceName,
 * action, apiKeyId }` only. Failures are non-fatal so a missing audit row
 * never breaks the underlying Vault operation.
 *
 * The event types reuse the existing `vault_kv_*` strings (single source of
 * truth in `lib/types/user-events.ts`) — the resource identifier on the
 * row carries the stack/service context.
 */
async function recordGitDeployKeyAuditEvent(
  req: Request,
  action: "put" | "delete",
  stackId: string,
  serviceName: string,
  status: UserEventStatus,
  errorMessage?: string,
): Promise<void> {
  try {
    const user = getAuthenticatedUser(req);
    const apiKeyId = req.apiKey?.id ?? null;
    const eventType = action === "put" ? "vault_kv_write" : "vault_kv_delete";
    await new UserEventService().createEvent({
      eventType,
      eventCategory: "security",
      eventName: `git-deploy-key ${action}: ${stackId}/${serviceName}`,
      userId: user?.id,
      triggeredBy: req.apiKey ? "api" : "manual",
      status,
      progress: status === "completed" ? 100 : 0,
      resourceId: stackId,
      resourceType: "stack",
      resourceName: `${stackId}/${serviceName}`,
      description:
        errorMessage ?? `git-deploy-key ${action} for stack service ${serviceName}`,
      metadata: {
        stackId,
        serviceName,
        action: `git-deploy-key:${action}`,
        apiKeyId,
      },
    });
  } catch (err) {
    log.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        action,
        stackId,
        serviceName,
      },
      "Failed to record git-deploy-key audit event (non-fatal)",
    );
  }
}

const router = Router();

/**
 * Vault KV path convention for the per-service git deploy key (Phase 5 of
 * the Claude Shell plan, §4.3). The path is derived from `(stackId,
 * serviceName)` rather than stored on the `StackService` row — the
 * `claude-shell` addon's `provision()` checks for existence at apply time.
 *
 * Single field `privateKey` (PEM-encoded). Keep this in one place so the
 * route handler and the addon resolver read the exact same path.
 */
export function buildGitDeployKeyPath(
  stackId: string,
  serviceName: string,
): string {
  return `stacks/${stackId}/services/${serviceName}/git-deploy-key`;
}

/**
 * Body schema for `PUT`. The field name is `privateKey` to mirror what the
 * Vault KV entry stores; the regex is a deliberately loose PEM-private-key
 * sanity check so we reject obviously-wrong input (e.g. a public key, an
 * empty string, a UUID) at the boundary. We do not parse / validate the key
 * material itself — Vault stores opaque bytes, and the running container's
 * SSH client is the final arbiter of whether the key is usable.
 */
const putBodySchema = z
  .object({
    privateKey: z
      .string()
      .min(1)
      .max(64 * 1024),
  })
  .strict();

const PEM_PRIVATE_KEY_PATTERN =
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]+-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/;

function looksLikePemPrivateKey(value: string): boolean {
  return PEM_PRIVATE_KEY_PATTERN.test(value);
}

/**
 * Helper: verify the target stack service actually exists before reading or
 * writing the Vault path. We return 404 on a missing service rather than
 * relying on Vault's response so operators get a clear "wrong stack/service"
 * signal even when no key has been written yet.
 */
async function ensureStackServiceExists(
  stackId: string,
  serviceName: string,
): Promise<boolean> {
  const service = await prisma.stackService.findFirst({
    where: { stackId, serviceName },
    select: { id: true },
  });
  return service !== null;
}

function vaultKvErrorStatus(err: VaultKVError): number {
  switch (err.code) {
    case "invalid_path":
    case "invalid_field":
    case "invalid_data":
      return 400;
    case "vault_permission_denied":
      return 403;
    case "path_not_found":
    case "field_not_found":
      return 404;
    case "vault_rate_limited":
      return 429;
    case "vault_not_ready":
    case "vault_unavailable":
    case "vault_sealed":
    case "vault_standby":
      return 503;
    default:
      return err.status ?? 500;
  }
}

/**
 * GET /:stackId/services/:serviceName/git-deploy-key
 *
 * Returns ONLY `{ hasKey: boolean }`. We never return the private key
 * material — once the operator has uploaded it they can only rotate or
 * delete it from outside the system. Vault is the authoritative store.
 */
router.get(
  "/:stackId/services/:serviceName/git-deploy-key",
  requirePermission("stacks:write"),
  asyncHandler(async (req, res) => {
    const stackId = String(req.params.stackId);
    const serviceName = String(req.params.serviceName);

    const exists = await ensureStackServiceExists(stackId, serviceName);
    if (!exists) {
      return res
        .status(404)
        .json({ success: false, message: "Stack service not found" });
    }

    const path = buildGitDeployKeyPath(stackId, serviceName);
    try {
      const data = await getVaultKVService().read(path);
      const hasKey =
        data !== null &&
        typeof data === "object" &&
        typeof (data as Record<string, unknown>).privateKey === "string" &&
        ((data as Record<string, unknown>).privateKey as string).length > 0;
      return res.json({ success: true, data: { hasKey } });
    } catch (err) {
      if (err instanceof VaultKVError) {
        log.warn(
          { err: err.message, code: err.code, stackId, serviceName },
          "git-deploy-key read failed",
        );
        return res
          .status(vaultKvErrorStatus(err))
          .json({ success: false, message: err.message, code: err.code });
      }
      throw err;
    }
  }),
);

/**
 * PUT /:stackId/services/:serviceName/git-deploy-key
 *
 * Write or rotate the deploy key. Body shape: `{ privateKey: string }` (PEM).
 * Auth: `stacks:write` (same gate as editing the rest of the stack).
 *
 * The private key is never echoed back, never logged. Validation is a basic
 * PEM-shape regex — Vault stores it as opaque bytes and the in-container SSH
 * client is the final arbiter of usability.
 */
router.put(
  "/:stackId/services/:serviceName/git-deploy-key",
  requirePermission("stacks:write"),
  asyncHandler(async (req, res) => {
    const stackId = String(req.params.stackId);
    const serviceName = String(req.params.serviceName);

    const parsed = putBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        issues: parsed.error.issues,
      });
    }
    if (!looksLikePemPrivateKey(parsed.data.privateKey)) {
      return res.status(400).json({
        success: false,
        message:
          "privateKey does not look like a PEM-encoded private key (expected -----BEGIN ... PRIVATE KEY----- / -----END ... PRIVATE KEY----- markers)",
        code: "invalid_pem",
      });
    }

    const exists = await ensureStackServiceExists(stackId, serviceName);
    if (!exists) {
      return res
        .status(404)
        .json({ success: false, message: "Stack service not found" });
    }

    const path = buildGitDeployKeyPath(stackId, serviceName);
    const userId = getAuthenticatedUser(req)?.id ?? null;
    try {
      await getVaultKVService().write(path, {
        privateKey: parsed.data.privateKey,
      });
      // Intentionally NOT logging the key material — only the marker that a
      // key was written. The Vault KV service itself also logs at info on
      // write, but redacts the data.
      log.info({ stackId, serviceName, userId }, "git-deploy-key written");
      await recordGitDeployKeyAuditEvent(
        req,
        "put",
        stackId,
        serviceName,
        "completed",
      );
      return res.json({ success: true, data: { hasKey: true } });
    } catch (err) {
      if (err instanceof VaultKVError) {
        log.warn(
          { err: err.message, code: err.code, stackId, serviceName, userId },
          "git-deploy-key write failed",
        );
        await recordGitDeployKeyAuditEvent(
          req,
          "put",
          stackId,
          serviceName,
          "failed",
          err.message,
        );
        return res
          .status(vaultKvErrorStatus(err))
          .json({ success: false, message: err.message, code: err.code });
      }
      throw err;
    }
  }),
);

/**
 * DELETE /:stackId/services/:serviceName/git-deploy-key
 *
 * Soft-delete the Vault KV entry. On the next apply the addon will detect
 * the absence and stop injecting `GIT_SSH_KEY`. Returns 404 if the key is
 * already absent so operators can distinguish "removed by this call" from
 * "was never there".
 */
router.delete(
  "/:stackId/services/:serviceName/git-deploy-key",
  requirePermission("stacks:write"),
  asyncHandler(async (req, res) => {
    const stackId = String(req.params.stackId);
    const serviceName = String(req.params.serviceName);

    const exists = await ensureStackServiceExists(stackId, serviceName);
    if (!exists) {
      return res
        .status(404)
        .json({ success: false, message: "Stack service not found" });
    }

    const path = buildGitDeployKeyPath(stackId, serviceName);
    const userId = getAuthenticatedUser(req)?.id ?? null;
    try {
      const current = await getVaultKVService().read(path);
      if (current === null) {
        return res.status(404).json({
          success: false,
          message: "No git-deploy-key set for this service",
          code: "path_not_found",
        });
      }
      await getVaultKVService().delete(path);
      log.info({ stackId, serviceName, userId }, "git-deploy-key deleted");
      await recordGitDeployKeyAuditEvent(
        req,
        "delete",
        stackId,
        serviceName,
        "completed",
      );
      return res.json({ success: true, data: { hasKey: false } });
    } catch (err) {
      if (err instanceof VaultKVError) {
        log.warn(
          { err: err.message, code: err.code, stackId, serviceName, userId },
          "git-deploy-key delete failed",
        );
        await recordGitDeployKeyAuditEvent(
          req,
          "delete",
          stackId,
          serviceName,
          "failed",
          err.message,
        );
        return res
          .status(vaultKvErrorStatus(err))
          .json({ success: false, message: err.message, code: err.code });
      }
      throw err;
    }
  }),
);

export default router;
