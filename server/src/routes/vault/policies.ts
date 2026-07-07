import express, {
  Request,
  Response,
  NextFunction,
  RequestHandler,
} from "express";
import { z } from "zod";
import { requirePermission, getAuthenticatedUser } from "../../middleware/auth";
import { getLogger } from "../../lib/logger-factory";
import { VaultPolicyService } from "../../services/vault/vault-policy-service";
import { getVaultServices } from "../../services/vault/vault-services";
import { emitToChannel } from "../../lib/socket";
import { Channel, ServerEvent, Permission, ErrorCode } from "@mini-infra/types";
import { NotFoundError } from "../../lib/errors";

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
  requirePermission(Permission.VaultRead) as RequestHandler,
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
  requirePermission(Permission.VaultWrite) as RequestHandler,
  (async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = createSchema.parse(req.body);
      const user = getAuthenticatedUser(req);
      const policy = await getService().create(parsed, user?.id ?? "system");
      res.status(201).json({ success: true, data: policy });
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
      const policy = await getService().get(String(req.params.id));
      if (!policy) {
        throw new NotFoundError(
          ErrorCode.VAULT_POLICY_NOT_FOUND,
          `Vault policy ${req.params.id} not found`,
          { resource: { type: "vaultPolicy", id: String(req.params.id) } },
        );
      }
      res.json({ success: true, data: policy });
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
      const user = getAuthenticatedUser(req);
      const policy = await getService().update(
        String(req.params.id),
        parsed,
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
  requirePermission(Permission.VaultWrite) as RequestHandler,
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
