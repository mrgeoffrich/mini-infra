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
import { Channel, ServerEvent, Permission, ErrorCode } from "@mini-infra/types";
import { NotFoundError } from "../../lib/errors";

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
  requirePermission(Permission.VaultRead) as RequestHandler,
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
  requirePermission(Permission.VaultWrite) as RequestHandler,
  (async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = createSchema.parse(req.body);
      const user = getAuthenticatedUser(req);
      const approle = await getService().create(parsed, user?.id ?? "system");
      res.status(201).json({ success: true, data: approle });
    } catch (err) {
      next(err);
    }
  }) as RequestHandler,
);

router.get(
  "/:id",
  requirePermission(Permission.VaultRead) as RequestHandler,
  (async (req: Request, res: Response, next: NextFunction) => {
    try {
      const approle = await getService().get(String(req.params.id));
      if (!approle) {
        throw new NotFoundError(
          ErrorCode.VAULT_APPROLE_NOT_FOUND,
          `Vault AppRole ${req.params.id} not found`,
          { resource: { type: "vaultAppRole", id: String(req.params.id) } },
        );
      }
      res.json({ success: true, data: approle });
    } catch (err) {
      next(err);
    }
  }) as RequestHandler,
);

router.get(
  "/:id/stacks",
  requirePermission(Permission.VaultRead) as RequestHandler,
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
  requirePermission(Permission.VaultWrite) as RequestHandler,
  (async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = updateSchema.parse(req.body);
      const approle = await getService().update(String(req.params.id), parsed);
      res.json({ success: true, data: approle });
    } catch (err) {
      next(err);
    }
  }) as RequestHandler,
);

router.post(
  "/:id/apply",
  requirePermission(Permission.VaultWrite) as RequestHandler,
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
  requirePermission(Permission.VaultWrite) as RequestHandler,
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
