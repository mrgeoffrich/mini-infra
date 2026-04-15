import express from "express";
import type { RequestHandler } from "express";
import { requirePermission } from "../middleware/auth";
import prisma from "../lib/prisma";
import { ImageInspectService } from "../services/image-inspect";
import { getLogger } from "../lib/logger-factory";
import {
  RegistryCredentialService,
} from "../services/registry-credential";

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
    requirePermission("containers:read") as RequestHandler,
    async (req, res) => {
      const image = req.query.image as string | undefined;
      const tag = req.query.tag as string | undefined;

      if (!image || !tag) {
        return res.status(400).json({
          success: false,
          error: "Both 'image' and 'tag' query parameters are required",
        });
      }

      try {
        const credentials =
          await registryCredentialService.getCredentialsForImage(image);
        const inspectService = new ImageInspectService(credentials);
        const ports = await inspectService.getExposedPorts(image, tag);

        res.json({ success: true, ports });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error";

        logger.error({ error: message, image, tag }, "Failed to inspect image ports");

        if (message.includes("not found")) {
          return res.status(404).json({ success: false, error: message });
        }
        if (message.includes("Authentication")) {
          return res.status(502).json({ success: false, error: message });
        }
        res.status(502).json({ success: false, error: "Failed to inspect image" });
      }
    },
  );

  return router;
}
