import { Router, Request, Response, RequestHandler } from "express";
import { getLogger } from "../lib/logger-factory";
import { requireAuth } from "../lib/auth-middleware";
import { asyncHandler } from "../lib/async-handler";
import { ValidationError } from "../lib/errors";
import { ErrorCode } from "@mini-infra/types";
import type { UpdateAuthSettingsRequest } from "@mini-infra/types";
import * as authSettingsService from "../lib/auth-settings-service";

const logger = getLogger("auth", "auth-settings");
const router = Router();

// All routes require authentication
router.use(requireAuth as RequestHandler);

// Get auth settings
router.get(
  "/",
  asyncHandler(async (_req: Request, res: Response) => {
    const settings = await authSettingsService.getSettings();
    res.json({ success: true, data: settings });
  }),
);

// Update auth settings
router.put(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const data = req.body as UpdateAuthSettingsRequest;

    // Validate: if enabling Google OAuth, require both credentials
    if (data.googleOAuthEnabled === true) {
      const current = await authSettingsService.getSettingsInternal();
      const hasClientId = data.googleClientId || current.googleClientId;
      const hasClientSecret =
        data.googleClientSecret || current.googleClientSecret;

      if (!hasClientId || !hasClientSecret) {
        throw new ValidationError(
          ErrorCode.AUTH_GOOGLE_OAUTH_CREDENTIALS_REQUIRED,
          "Google Client ID and Client Secret are required to enable Google OAuth.",
        );
      }
    }

    await authSettingsService.updateSettings(data);

    const updated = await authSettingsService.getSettings();
    logger.info({ updatedBy: req.user!.id }, "Auth settings updated");
    res.json({ success: true, data: updated });
  }),
);

export default router;
