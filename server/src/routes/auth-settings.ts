import { Router, Request, Response, RequestHandler } from "express";
import { appLogger } from "../lib/logger-factory";
import { requireAuth } from "../lib/auth-middleware";
import * as authSettingsService from "../lib/auth-settings-service";
import type { UpdateAuthSettingsRequest } from "@mini-infra/types";

const logger = appLogger();
const router = Router();

// All routes require authentication
router.use(requireAuth as RequestHandler);

// Get auth settings
router.get("/", (async (_req: Request, res: Response) => {
  try {
    const settings = await authSettingsService.getSettings();
    res.json({ success: true, data: settings });
  } catch (error) {
    logger.error({ error }, "Error fetching auth settings");
    res.status(500).json({ error: "Failed to fetch auth settings" });
  }
}) as RequestHandler);

// Update auth settings
router.put("/", (async (req: Request, res: Response) => {
  try {
    const data = req.body as UpdateAuthSettingsRequest;

    // Validate: if enabling Google OAuth, require both credentials
    if (data.googleOAuthEnabled === true) {
      const current = await authSettingsService.getSettingsInternal();
      const hasClientId = data.googleClientId || current.googleClientId;
      const hasClientSecret = data.googleClientSecret || current.googleClientSecret;

      if (!hasClientId || !hasClientSecret) {
        return res.status(400).json({
          error: "Google Client ID and Client Secret are required to enable Google OAuth",
        });
      }
    }

    await authSettingsService.updateSettings(data);

    const updated = await authSettingsService.getSettings();
    logger.info({ updatedBy: req.user!.id }, "Auth settings updated");
    res.json({ success: true, data: updated });
  } catch (error) {
    logger.error({ error }, "Error updating auth settings");
    res.status(500).json({ error: "Failed to update auth settings" });
  }
}) as RequestHandler);

export default router;
