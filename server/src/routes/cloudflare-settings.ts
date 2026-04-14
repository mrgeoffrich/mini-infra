import express from "express";
import prisma from "../lib/prisma";
import { CloudflareService } from "../services/cloudflare";
import { createCloudflareSettingsRouter } from "./cloudflare/settings-routes";
import { createCloudflareTunnelsRouter } from "./cloudflare/tunnels-routes";
import { createManagedTunnelsRouter } from "./cloudflare/managed-tunnels-routes";

/**
 * Mount point for every `/api/settings/cloudflare` route. The module is
 * split into three focused sub-routers (settings CRUD, tunnel API,
 * managed tunnels) that all share one {@link CloudflareService} instance
 * so circuit-breaker state is consistent across requests.
 */
const cloudflareConfigService = new CloudflareService(prisma);

const router = express.Router();

router.use("/", createCloudflareSettingsRouter(cloudflareConfigService));
router.use("/tunnels", createCloudflareTunnelsRouter(cloudflareConfigService));
router.use(
  "/managed-tunnels",
  createManagedTunnelsRouter(cloudflareConfigService),
);

export default router;
