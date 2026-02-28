import { Request, Response, NextFunction } from "express";
import { hasPermission, hasAnyPermission } from "@mini-infra/types";
import type { PermissionScope } from "@mini-infra/types";
import { requireSessionOrApiKey } from "./api-key-middleware";
import { appLogger } from "./logger-factory";

const logger = appLogger();

/**
 * Creates middleware that requires authentication AND specific permission(s).
 *
 * Session-based users (web UI) always have full access.
 * API key users are checked against their stored permissions.
 *
 * Usage:
 *   router.get('/configs', requirePermission('deployments:read'), handler);
 *   router.post('/configs', requirePermission('deployments:write'), handler);
 *   router.get('/something', requirePermission(['containers:read', 'deployments:read']), handler);
 */
export function requirePermission(
  scope: PermissionScope | PermissionScope[],
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  const scopes = Array.isArray(scope) ? scope : [scope];

  return async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    // First, run standard session/API key auth
    await new Promise<void>((resolve) => {
      requireSessionOrApiKey(req, res, () => {
        resolve();
      });
    });

    // If response was already sent by requireSessionOrApiKey (401), stop
    if (res.headersSent) return;

    // Session users (web UI) always have full access
    if (req.user && !req.apiKey) {
      next();
      return;
    }

    // API key users: check permissions
    if (req.apiKey) {
      const permissions = req.apiKey.permissions;

      const allowed = hasAnyPermission(permissions, scopes);

      if (!allowed) {
        logger.warn(
          {
            keyId: req.apiKey.id,
            path: req.path,
            method: req.method,
            requiredScopes: scopes,
          },
          "API key permission denied",
        );

        res.status(403).json({
          error: "Insufficient permissions",
          message: `This API key does not have the required permission(s): ${scopes.join(", ")}`,
          requiredPermissions: scopes,
        });
        return;
      }
    }

    next();
  };
}
