import { Router, Request, Response } from "express";
import { z } from "zod";
import { appLogger } from "../lib/logger-factory";
import { requirePermission } from "../middleware/auth";
import { UserPreferencesService } from "../services/user-preferences";
import type {
  JWTUser,
  UserPreferenceInfo,
} from "@mini-infra/types";

const logger = appLogger();
const router = Router();

// Validation schemas
const UpdateUserPreferencesSchema = z
  .object({
    timezone: z.string().optional(),
    containerSortField: z.string().optional(),
    containerSortOrder: z.enum(["asc", "desc"]).optional(),
    containerFilters: z.any().optional(),
    containerColumns: z.any().optional(),
  })
  .strict();

// Helper function to serialize UserPreference for API responses
function serializeUserPreferenceInfo(preference: any): UserPreferenceInfo {
  return {
    id: preference.id,
    containerSortField: preference.containerSortField,
    containerSortOrder: preference.containerSortOrder,
    containerFilters: preference.containerFilters,
    containerColumns: preference.containerColumns,
    timezone: preference.timezone,
    createdAt: preference.createdAt.toISOString(),
    updatedAt: preference.updatedAt.toISOString(),
  };
}

router.get("/preferences", requirePermission('user:read'), async (req: Request, res: Response) => {
  try {
    const user = req.user as JWTUser;
    const userId = user.id;

    logger.debug({ userId }, "Getting user preferences");

    const preferences = await UserPreferencesService.getUserPreferences(userId);
    const preferenceInfo = serializeUserPreferenceInfo(preferences);

    logger.debug(
      { userId, preferencesId: preferences.id },
      "User preferences retrieved successfully",
    );

    res.json({
      success: true,
      data: preferenceInfo,
      message: "User preferences retrieved successfully",
    });
  } catch (error: any) {
    logger.error({ error: error.message }, "Failed to get user preferences");

    res.status(500).json({
      success: false,
      message: "Failed to get user preferences",
      error: error.message,
    });
  }
});


router.put("/preferences", requirePermission('user:write'), async (req: Request, res: Response) => {
  try {
    const user = req.user as JWTUser;
    const userId = user.id;

    logger.debug({ userId, body: req.body }, "Updating user preferences");

    // Validate request body
    const validatedData = UpdateUserPreferencesSchema.parse(req.body);

    const preferences = await UserPreferencesService.updateUserPreferences(
      userId,
      validatedData,
    );
    const preferenceInfo = serializeUserPreferenceInfo(preferences);

    logger.debug(
      { userId, preferencesId: preferences.id },
      "User preferences updated successfully",
    );

    res.json({
      success: true,
      data: preferenceInfo,
      message: "User preferences updated successfully",
    });
  } catch (error: any) {
    if (error.name === "ZodError") {
      logger.warn(
        { error: error.errors },
        "Invalid request data for user preferences update",
      );
      return res.status(400).json({
        success: false,
        message: "Invalid request data",
        error: error.errors,
      });
    }

    if (error.message.includes("Invalid timezone")) {
      logger.warn({ error: error.message }, "Invalid timezone provided");
      return res.status(400).json({
        success: false,
        message: error.message,
      });
    }

    logger.error({ error: error.message }, "Failed to update user preferences");

    res.status(500).json({
      success: false,
      message: "Failed to update user preferences",
      error: error.message,
    });
  }
});


router.get("/timezones", requirePermission('user:read'), async (req: Request, res: Response) => {
  try {
    const user = req.user as JWTUser;
    const userId = user.id;

    logger.debug({ userId }, "Getting timezone list");

    const timezones = UserPreferencesService.getCommonTimezones();

    res.json({
      success: true,
      data: timezones,
      message: "Timezones retrieved successfully",
    });
  } catch (error: any) {
    logger.error({ error: error.message }, "Failed to get timezones");

    res.status(500).json({
      success: false,
      message: "Failed to get timezones",
      error: error.message,
    });
  }
});

export default router;
