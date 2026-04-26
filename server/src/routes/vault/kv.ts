import express, {
  Request,
  Response,
  NextFunction,
  RequestHandler,
} from "express";
import { z } from "zod";
import { requirePermission, getAuthenticatedUser } from "../../middleware/auth";
import { getLogger } from "../../lib/logger-factory";
import {
  getVaultKVService,
  VaultKVError,
  validateKvPath,
} from "../../services/vault/vault-kv-service";

const log = getLogger("platform", "vault-kv-routes");

const router = express.Router();

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

function handleVaultKvError(res: Response, err: unknown, action: string): void {
  if (err instanceof VaultKVError) {
    const status = err.status ?? (err.code === "vault_not_ready" || err.code === "vault_unavailable" ? 503 : 500);
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
    try {
      await getVaultKVService().write(path, parsed.data.data);
      log.info(
        { path, userId: getAuthenticatedUser(req)?.id ?? null, fields: Object.keys(parsed.data.data) },
        "KV write",
      );
      res.json({ success: true, data: { path } });
    } catch (err) {
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
    try {
      await getVaultKVService().patch(path, parsed.data.data);
      log.info(
        { path, userId: getAuthenticatedUser(req)?.id ?? null, fields: Object.keys(parsed.data.data) },
        "KV patch",
      );
      res.json({ success: true, data: { path } });
    } catch (err) {
      handleVaultKvError(res, err, "patch");
    }
  }) as RequestHandler,
);

/**
 * Delete a KV path. Soft-delete by default (KV v2 preserves history); pass
 * `?permanent=true` to wipe all versions and metadata.
 */
router.delete(
  "/*splat",
  requirePermission("vault-kv:write") as RequestHandler,
  (async (req: Request, res: Response, _next: NextFunction) => {
    const path = parsePath(req, res);
    if (path === null) return;
    const permanent = req.query.permanent === "true" || req.query.permanent === "1";
    try {
      await getVaultKVService().delete(path, { permanent });
      log.info(
        { path, permanent, userId: getAuthenticatedUser(req)?.id ?? null },
        "KV delete",
      );
      res.json({ success: true, data: { path, permanent } });
    } catch (err) {
      handleVaultKvError(res, err, "delete");
    }
  }) as RequestHandler,
);

export default router;
