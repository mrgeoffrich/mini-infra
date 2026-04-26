import express, {
  Request,
  Response,
  NextFunction,
  RequestHandler,
} from "express";
import { z } from "zod";
import { requirePermission, getAuthenticatedUser } from "../../middleware/auth";
import { getLogger } from "../../lib/logger-factory";
import { hasPermission, type UserEventType } from "@mini-infra/types";
import {
  getVaultKVService,
  VaultKVError,
  validateKvPath,
} from "../../services/vault/vault-kv-service";
import { UserEventService } from "../../services/user-events/user-event-service";

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
 * them back with `/` before handing to the validator.
 */
function parsePath(req: Request, res: Response): string | null {
  const splat = (req.params as Record<string, unknown>).splat;
  const raw = Array.isArray(splat)
    ? (splat as string[]).join("/")
    : typeof splat === "string"
      ? splat
      : "";
  try {
    return validateKvPath(raw);
  } catch (err) {
    if (err instanceof VaultKVError) {
      res.status(400).json({ success: false, message: err.message, code: err.code });
    } else {
      res.status(400).json({ success: false, message: "Invalid KV path" });
    }
    return null;
  }
}

/**
 * Translate a `VaultKVError` code into the HTTP status the broker should
 * surface. Transient/upstream issues become 5xx so clients retry; client
 * errors (bad path, bad data) stay 4xx so they don't.
 */
function statusForKvErrorCode(code: string, fallback: number | undefined): number {
  switch (code) {
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
    case "vault_error":
    default:
      return fallback ?? 500;
  }
}

function handleVaultKvError(res: Response, err: unknown, action: string): void {
  if (err instanceof VaultKVError) {
    const status = statusForKvErrorCode(err.code, err.status);
    log.warn({ err: err.message, code: err.code, action }, "Vault KV operation failed");
    res.status(status).json({ success: false, message: err.message, code: err.code });
    return;
  }
  const msg = err instanceof Error ? err.message : String(err);
  log.error({ err: msg, action }, "Vault KV operation failed unexpectedly");
  res.status(500).json({ success: false, message: msg });
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
  requirePermission("vault-kv:read") as RequestHandler,
  (async (req: Request, res: Response, _next: NextFunction) => {
    const path = parsePath(req, res);
    if (path === null) return;
    try {
      const data = await getVaultKVService().read(path);
      if (data === null) {
        return res.status(404).json({ success: false, message: `KV path '${path}' not found`, code: "path_not_found" });
      }
      // Broker-route reads are explicit operator/installer actions (not the
      // per-apply dynamicEnv resolver path), so log at info for an audit
      // trail of who pulled which secret. Resolver-path reads remain debug.
      log.info({ path, userId: getAuthenticatedUser(req)?.id ?? null }, "KV read via broker");
      res.json({ success: true, data: { path, data } });
    } catch (err) {
      handleVaultKvError(res, err, "read");
    }
  }) as RequestHandler,
);

/**
 * Write (create or replace) a KV path. The body shape matches Vault KV v2:
 * `{ data: { field1: value1, ... } }`. Returns 200 with the path written.
 */
router.post(
  "/*splat",
  requirePermission("vault-kv:write") as RequestHandler,
  (async (req: Request, res: Response, _next: NextFunction) => {
    const path = parsePath(req, res);
    if (path === null) return;
    const parsed = writeBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid body — expected { data: { ... } }",
        details: parsed.error.issues,
      });
    }
    const fields = Object.keys(parsed.data.data);
    try {
      await getVaultKVService().write(path, parsed.data.data);
      log.info(
        { path, userId: getAuthenticatedUser(req)?.id ?? null, fields },
        "KV write",
      );
      await recordKvAuditEvent(req, "vault_kv_write", path, "completed", { fields });
      res.json({ success: true, data: { path } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await recordKvAuditEvent(req, "vault_kv_write", path, "failed", { fields }, msg);
      handleVaultKvError(res, err, "write");
    }
  }) as RequestHandler,
);

/**
 * Patch (server-side merge) a KV path. Same body shape as POST. Useful for
 * rotating one field without replacing the whole document.
 */
router.patch(
  "/*splat",
  requirePermission("vault-kv:write") as RequestHandler,
  (async (req: Request, res: Response, _next: NextFunction) => {
    const path = parsePath(req, res);
    if (path === null) return;
    const parsed = writeBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid body — expected { data: { ... } }",
        details: parsed.error.issues,
      });
    }
    const fields = Object.keys(parsed.data.data);
    try {
      await getVaultKVService().patch(path, parsed.data.data);
      log.info(
        { path, userId: getAuthenticatedUser(req)?.id ?? null, fields },
        "KV patch",
      );
      await recordKvAuditEvent(req, "vault_kv_patch", path, "completed", { fields });
      res.json({ success: true, data: { path } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await recordKvAuditEvent(req, "vault_kv_patch", path, "failed", { fields }, msg);
      handleVaultKvError(res, err, "patch");
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
  requirePermission("vault-kv:write") as RequestHandler,
  (async (req: Request, res: Response, _next: NextFunction) => {
    const path = parsePath(req, res);
    if (path === null) return;
    const permanent = req.query.permanent === "true" || req.query.permanent === "1";
    if (permanent && req.apiKey && !hasPermission(req.apiKey.permissions, "vault-kv:destroy")) {
      log.warn(
        { keyId: req.apiKey.id, path },
        "API key permission denied for vault-kv:destroy",
      );
      return res.status(403).json({
        success: false,
        message: "?permanent=true requires the vault-kv:destroy scope",
        code: "vault_destroy_forbidden",
        requiredPermissions: ["vault-kv:destroy"],
      });
    }
    try {
      await getVaultKVService().delete(path, { permanent });
      log.info(
        { path, permanent, userId: getAuthenticatedUser(req)?.id ?? null },
        "KV delete",
      );
      await recordKvAuditEvent(req, "vault_kv_delete", path, "completed", { permanent });
      res.json({ success: true, data: { path, permanent } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await recordKvAuditEvent(req, "vault_kv_delete", path, "failed", { permanent }, msg);
      handleVaultKvError(res, err, "delete");
    }
  }) as RequestHandler,
);

export default router;
