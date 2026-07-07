import express from "express";
import type { RequestHandler } from "express";
import { requirePermission } from "../middleware/auth";
import prisma from "../lib/prisma";
import { ImageInspectService } from "../services/image-inspect";
import { getLogger } from "../lib/logger-factory";
import {
  RegistryCredentialService,
} from "../services/registry-credential";
import { ValidationError } from "../lib/errors";
import { Permission, ErrorCode } from "@mini-infra/types";

type ImagesRouterOptions = {
  logger?: ReturnType<typeof getLogger>;
  registryCredentialService?: Pick<
    RegistryCredentialService,
    "getCredentialsForImage"
  >;
};

export default function createImagesRouter(
  options: ImagesRouterOptions = {},
) {
  const logger = options.logger ?? getLogger("docker", "images");
  const registryCredentialService =
    options.registryCredentialService ??
    new RegistryCredentialService(prisma);
  const router = express.Router();

  router.get(
    "/inspect-ports",
    requirePermission(Permission.ContainersRead) as RequestHandler,
    (async (req, res) => {
      const image = req.query.image as string | undefined;
      const tag = req.query.tag as string | undefined;

      if (!image || !tag) {
        throw new ValidationError(
          ErrorCode.VALIDATION_FAILED,
          "Both 'image' and 'tag' query parameters are required",
        );
      }

      // Errors thrown from here on (ImageInspectService's NotFoundError/
      // UnauthorizedError/ServiceError) carry their own status/code and
      // reach the central error middleware — Express 5 forwards a rejected
      // promise from an async handler to `next(error)` automatically, so no
      // local try/catch/status-mapping is needed (see
      // docs/planning/not-shipped/error-handling-overhaul-plan.md, Phase 7).
      const credentials =
        await registryCredentialService.getCredentialsForImage(image);
      const inspectService = new ImageInspectService(credentials);
      const ports = await inspectService.getExposedPorts(image, tag);

      logger.debug({ image, tag, ports }, "Inspected image ports");
      res.json({ success: true, ports });
    }) as RequestHandler,
  );

  return router;
}
