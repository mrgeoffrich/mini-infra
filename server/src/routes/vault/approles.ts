import express, {
  Request,
  Response,
  NextFunction,
  RequestHandler,
} from "express";
import { z } from "zod";
import { requirePermission, getAuthenticatedUser } from "../../middleware/auth";
import { getLogger } from "../../lib/logger-factory";
import { VaultAppRoleService } from "../../services/vault/vault-approle-service";
import { getVaultServices } from "../../services/vault/vault-services";
import { emitToChannel } from "../../lib/socket";
import { Channel, ServerEvent } from "@mini-infra/types";

const log = getLogger("platform", "vault-approles-routes");

const router = express.Router();

function getService(): VaultAppRoleService {
  const s = getVaultServices();
  return new VaultAppRoleService(s.prisma, s.admin);
}

const createSchema = z.object({
  name: z.string().min(3).max(64),
  policyId: z.string().min(1),
  secretIdNumUses: z.number().int().min(0).optional(),
  secretIdTtl: z.string().optional(),
  tokenTtl: z.string().optional(),
  tokenMaxTtl: z.string().optional(),
  tokenPeriod: z.string().optional(),
});

const updateSchema = z.object({
  policyId: z.string().min(1).optional(),
  secretIdNumUses: z.number().int().min(0).optional(),
  secretIdTtl: z.string().optional(),
  tokenTtl: z.string().optional(),
  tokenMaxTtl: z.string().optional(),
  tokenPeriod: z.string().optional(),
});

router.get(
  "/",
  requirePermission("vault:read") as RequestHandler,
  (async (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({ success: true, data: await getService().list() });
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
      return res.status(400).json({
        success: false,
        message: "Invalid AppRole payload",
        details: parsed.error.issues,
      });
    }
    try {
      const user = getAuthenticatedUser(req);
      const approle = await getService().create(parsed.data, user?.id ?? "system");
      res.status(201).json({ success: true, data: approle });
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
      const approle = await getService().get(String(req.params.id));
      if (!approle) {
        return res.status(404).json({ success: false, message: "Not found" });
      }
      res.json({ success: true, data: approle });
    } catch (err) {
      next(err);
    }
  }) as RequestHandler,
);

router.get(
  "/:id/stacks",
  requirePermission("vault:read") as RequestHandler,
  (async (req: Request, res: Response, next: NextFunction) => {
    try {
      const stacks = await getService().listBoundStacks(String(req.params.id));
      res.json({ success: true, data: stacks });
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
      return res.status(400).json({
        success: false,
        message: "Invalid AppRole update",
        details: parsed.error.issues,
      });
    }
    try {
      const approle = await getService().update(String(req.params.id), parsed.data);
      res.json({ success: true, data: approle });
    } catch (err) {
      next(err);
    }
  }) as RequestHandler,
);

router.post(
  "/:id/apply",
  requirePermission("vault:write") as RequestHandler,
  (async (req: Request, res: Response, next: NextFunction) => {
    try {
      const approle = await getService().apply(String(req.params.id));
      try {
        emitToChannel(Channel.VAULT, ServerEvent.VAULT_APPROLE_APPLIED, {
          appRoleId: approle.id,
          appRoleName: approle.name,
          cachedRoleId: approle.cachedRoleId,
        });
      } catch (err) {
        log.debug({ err }, "Failed to emit VAULT_APPROLE_APPLIED");
      }
      res.json({ success: true, data: approle });
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
      next(err);
    }
  }) as RequestHandler,
);

export default router;
