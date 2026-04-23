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
  VaultPolicyService,
  PolicyInUseError,
} from "../../services/vault/vault-policy-service";
import { getVaultServices } from "../../services/vault/vault-services";
import { emitToChannel } from "../../lib/socket";
import { Channel, ServerEvent } from "@mini-infra/types";

const log = getLogger("platform", "vault-policies-routes");

const router = express.Router();

function getService(): VaultPolicyService {
  const s = getVaultServices();
  return new VaultPolicyService(s.prisma, s.admin);
}

const createSchema = z.object({
  name: z.string().min(3).max(64),
  displayName: z.string().min(1).max(128),
  description: z.string().optional(),
  draftHclBody: z.string().min(1),
});

const updateSchema = z.object({
  displayName: z.string().min(1).max(128).optional(),
  description: z.string().optional(),
  draftHclBody: z.string().optional(),
});

router.get(
  "/",
  requirePermission("vault:read") as RequestHandler,
  (async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const list = await getService().list();
      res.json({ success: true, data: list });
    } catch (err) {
      next(err);
    }
  }) as RequestHandler,
);

router.post(
  "/",
  requirePermission("vault:write") as RequestHandler,
  (async (req: Request, res: Response, next: NextFunction) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid policy payload", details: parsed.error.issues });
    }
    try {
      const user = getAuthenticatedUser(req);
      const policy = await getService().create(parsed.data, user?.id ?? "system");
      res.status(201).json({ success: true, data: policy });
    } catch (err) {
      next(err);
    }
  }) as RequestHandler,
);

router.get(
  "/:id",
  requirePermission("vault:read") as RequestHandler,
  (async (req: Request, res: Response, next: NextFunction) => {
    try {
      const policy = await getService().get(String(req.params.id));
      if (!policy) {
        return res.status(404).json({ success: false, message: "Not found" });
      }
      res.json({ success: true, data: policy });
    } catch (err) {
      next(err);
    }
  }) as RequestHandler,
);

router.put(
  "/:id",
  requirePermission("vault:write") as RequestHandler,
  (async (req: Request, res: Response, next: NextFunction) => {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid policy update", details: parsed.error.issues });
    }
    try {
      const user = getAuthenticatedUser(req);
      const policy = await getService().update(
        String(req.params.id),
        parsed.data,
        user?.id ?? "system",
      );
      res.json({ success: true, data: policy });
    } catch (err) {
      next(err);
    }
  }) as RequestHandler,
);

router.post(
  "/:id/publish",
  requirePermission("vault:write") as RequestHandler,
  (async (req: Request, res: Response, next: NextFunction) => {
    try {
      const policy = await getService().publish(String(req.params.id));
      try {
        emitToChannel(Channel.VAULT, ServerEvent.VAULT_POLICY_APPLIED, {
          policyId: policy.id,
          policyName: policy.name,
          publishedVersion: policy.publishedVersion,
        });
      } catch (err) {
        log.debug({ err }, "Failed to emit VAULT_POLICY_APPLIED");
      }
      res.json({ success: true, data: policy });
    } catch (err) {
      next(err);
    }
  }) as RequestHandler,
);

router.delete(
  "/:id",
  requirePermission("vault:write") as RequestHandler,
  (async (req: Request, res: Response, next: NextFunction) => {
    try {
      await getService().delete(String(req.params.id));
      res.json({ success: true });
    } catch (err) {
      if (err instanceof PolicyInUseError) {
        return res.status(409).json({
          success: false,
          message: err.message,
          details: { appRoles: err.appRoleNames },
        });
      }
      next(err);
    }
  }) as RequestHandler,
);

export default router;
