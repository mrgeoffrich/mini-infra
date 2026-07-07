import express, {
  Request,
  Response,
  NextFunction,
  RequestHandler,
} from "express";
import { z } from "zod";
import { requirePermission, getAuthenticatedUser } from "../../middleware/auth";
import { getLogger } from "../../lib/logger-factory";
import { hasPermission, type UserEventType, Permission, ErrorCode } from "@mini-infra/types";
import {
  getVaultKVService,
  validateKvPath,
} from "../../services/vault/vault-kv-service";
import { UserEventService } from "../../services/user-events/user-event-service";
import { ForbiddenError, NotFoundError } from "../../lib/errors";

const log = getLogger("platform", "vault-kv-routes");

const router = express.Router();

// Audit-trail writes (queryable in UI; survives log rotation). Keep failures
// non-fatal — losing the audit row should never break the operation itself.
async function recordKvAuditEvent(
  req: Request,
  eventType: UserEventType,
  path: string,
  status: 'completed' | 'failed',
  metadata: Record<string, unknown>,
  errorMessage?: string,
): Promise<void> {
  try {
    const user = getAuthenticatedUser(req);
    const apiKeyId = req.apiKey?.id ?? null;
    await new UserEventService().createEvent({
      eventType,
      eventCategory: 'security',
      eventName: `KV ${eventType.replace('vault_kv_', '')}: ${path}`,
      userId: user?.id,
      triggeredBy: req.apiKey ? 'api' : 'manual',
      status,
      progress: status === 'completed' ? 100 : 0,
      resourceType: 'system',
      resourceName: `vault-kv:${path}`,
      description: errorMessage ?? `Brokered Vault KV ${eventType.replace('vault_kv_', '')}`,
      metadata: { path, apiKeyId, ...metadata },
    });
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), eventType, path },
      "Failed to record KV audit event (non-fatal)",
    );
  }
}

// ── Helpers ─────────────────────────────────────────────

/**
 * Pull the KV path from the wildcard route parameter and validate it. The
 * router mounts on `/api/vault/kv` and uses `*splat` (path-to-regexp v8 named
 * splat) so any number of slash-separated segments are accepted —
 * `secret/data/shared/slack` is addressed as `GET /api/vault/kv/shared/slack`.
 *
 * `req.params.splat` is an array of segments under path-to-regexp v8; join
 * them back with `/` before handing to the validator. `validateKvPath`
 * throws a `VaultKVError` (a taxonomy error — see `vault-kv-paths.ts`) on an
 * invalid path; callers let it propagate to the central error middleware.
 */
function parsePath(req: Request): string {
  const splat = (req.params as Record<string, unknown>).splat;
  const raw = Array.isArray(splat)
    ? (splat as string[]).join("/")
    : typeof splat === "string"
      ? splat
      : "";
  return validateKvPath(raw);
}

const writeBodySchema = z.object({
  data: z.record(z.string(), z.unknown()),
});

// ── Routes ──────────────────────────────────────────────

/**
 * Read the latest version of a KV path. Returns the data envelope as Vault
 * returned it (object of field → value), or 404 if the path is missing.
 */
router.get(
  "/*splat",
  requirePermission(Permission.VaultKvRead) as RequestHandler,
  (async (req: Request, res: Response, next: NextFunction) => {
    try {
      const path = parsePath(req);
      const data = await getVaultKVService().read(path);
      if (data === null) {
        throw new NotFoundError(
          ErrorCode.VAULT_KV_PATH_NOT_FOUND,
          `KV path '${path}' not found`,
          { resource: { type: "vaultKv", name: path } },
        );
      }
      // Broker-route reads are explicit operator/installer actions (not the
      // per-apply dynamicEnv resolver path), so log at info for an audit
      // trail of who pulled which secret. Resolver-path reads remain debug.
      log.info({ path, userId: getAuthenticatedUser(req)?.id ?? null }, "KV read via broker");
      res.json({ success: true, data: { path, data } });
    } catch (err) {
      next(err);
    }
  }) as RequestHandler,
);

/**
 * Write (create or replace) a KV path. The body shape matches Vault KV v2:
 * `{ data: { field1: value1, ... } }`. Returns 200 with the path written.
 */
router.post(
  "/*splat",
  requirePermission(Permission.VaultKvWrite) as RequestHandler,
  (async (req: Request, res: Response, next: NextFunction) => {
    let path: string | undefined;
    let fields: string[] = [];
    try {
      path = parsePath(req);
      const parsed = writeBodySchema.parse(req.body);
      fields = Object.keys(parsed.data);
      await getVaultKVService().write(path, parsed.data);
      log.info(
        { path, userId: getAuthenticatedUser(req)?.id ?? null, fields },
        "KV write",
      );
      await recordKvAuditEvent(req, "vault_kv_write", path, "completed", { fields });
      res.json({ success: true, data: { path } });
    } catch (err) {
      if (path !== undefined) {
        const msg = err instanceof Error ? err.message : String(err);
        await recordKvAuditEvent(req, "vault_kv_write", path, "failed", { fields }, msg);
      }
      next(err);
    }
  }) as RequestHandler,
);

/**
 * Patch (server-side merge) a KV path. Same body shape as POST. Useful for
 * rotating one field without replacing the whole document.
 */
router.patch(
  "/*splat",
  requirePermission(Permission.VaultKvWrite) as RequestHandler,
  (async (req: Request, res: Response, next: NextFunction) => {
    let path: string | undefined;
    let fields: string[] = [];
    try {
      path = parsePath(req);
      const parsed = writeBodySchema.parse(req.body);
      fields = Object.keys(parsed.data);
      await getVaultKVService().patch(path, parsed.data);
      log.info(
        { path, userId: getAuthenticatedUser(req)?.id ?? null, fields },
        "KV patch",
      );
      await recordKvAuditEvent(req, "vault_kv_patch", path, "completed", { fields });
      res.json({ success: true, data: { path } });
    } catch (err) {
      if (path !== undefined) {
        const msg = err instanceof Error ? err.message : String(err);
        await recordKvAuditEvent(req, "vault_kv_patch", path, "failed", { fields }, msg);
      }
      next(err);
    }
  }) as RequestHandler,
);

/**
 * Delete a KV path. Soft-delete by default (KV v2 preserves history); pass
 * `?permanent=true` to wipe all versions and metadata.
 *
 * Permission gate is two-stage: the route requires `vault-kv:write` for any
 * delete; if `?permanent=true`, the handler additionally checks
 * `vault-kv:destroy`. Session (UI) users bypass the destroy check because
 * they always have full access (see `requirePermission` middleware).
 */
router.delete(
  "/*splat",
  requirePermission(Permission.VaultKvWrite) as RequestHandler,
  (async (req: Request, res: Response, next: NextFunction) => {
    let path: string | undefined;
    const permanent = req.query.permanent === "true" || req.query.permanent === "1";
    try {
      path = parsePath(req);
      if (permanent && req.apiKey && !hasPermission(req.apiKey.permissions, Permission.VaultKvDestroy)) {
        log.warn(
          { keyId: req.apiKey.id, path },
          "API key permission denied for vault-kv:destroy",
        );
        throw new ForbiddenError(
          ErrorCode.VAULT_KV_DESTROY_FORBIDDEN,
          "?permanent=true requires the vault-kv:destroy scope",
          {
            resource: { type: "vaultKv", name: path },
            action: "Request the vault-kv:destroy scope for this API key.",
            details: { requiredPermissions: [Permission.VaultKvDestroy] },
          },
        );
      }
      await getVaultKVService().delete(path, { permanent });
      log.info(
        { path, permanent, userId: getAuthenticatedUser(req)?.id ?? null },
        "KV delete",
      );
      await recordKvAuditEvent(req, "vault_kv_delete", path, "completed", { permanent });
      res.json({ success: true, data: { path, permanent } });
    } catch (err) {
      if (path !== undefined) {
        const msg = err instanceof Error ? err.message : String(err);
        await recordKvAuditEvent(req, "vault_kv_delete", path, "failed", { permanent }, msg);
      }
      next(err);
    }
  }) as RequestHandler,
);

export default router;
