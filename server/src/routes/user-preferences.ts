import { Router, Request, Response } from "express";
import { z } from "zod";
import { appLogger } from "../lib/logger-factory";
import { requireSessionOrApiKey } from "../middleware/auth";
import { UserPreferencesService } from "../services/user-preferences";
import type {
  JWTUser,
  UserPreferenceInfo,
  UpdateUserPreferencesRequest,
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

// Apply authentication middleware to all routes
router.use(requireSessionOrApiKey);

/**
 * @swagger
 * /api/user/preferences:
 *   get:
 *     summary: Get current user preferences
 *     description: Retrieve the authenticated user's preferences including timezone, container dashboard settings, and UI customizations
 *     tags:
 *       - User Preferences
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *       - ApiKeyAuthBearer: []
 *     responses:
 *       200:
 *         description: User preferences retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   $ref: '#/components/schemas/UserPreferenceInfo'
 *                 message:
 *                   type: string
 *                   example: 'User preferences retrieved successfully'
 *               required:
 *                 - success
 *                 - data
 *                 - message
 *             example:
 *               success: true
 *               data:
 *                 id: 'pref123'
 *                 containerSortField: 'name'
 *                 containerSortOrder: 'asc'
 *                 containerFilters:
 *                   status: 'running'
 *                   image: ''
 *                 containerColumns:
 *                   name: true
 *                   status: true
 *                   image: true
 *                   ports: false
 *                 timezone: 'America/New_York'
 *                 createdAt: '2025-09-20T15:00:00.000Z'
 *                 updatedAt: '2025-09-24T12:00:00.000Z'
 *               message: 'User preferences retrieved successfully'
 *       401:
 *         description: Authentication required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get("/preferences", async (req: Request, res: Response) => {
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

/**
 * @swagger
 * /api/user/preferences:
 *   put:
 *     summary: Update current user preferences
 *     description: Update the authenticated user's preferences. All fields are optional and will only update the provided values.
 *     tags:
 *       - User Preferences
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *       - ApiKeyAuthBearer: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/UpdateUserPreferencesRequest'
 *           example:
 *             timezone: 'America/New_York'
 *             containerSortField: 'status'
 *             containerSortOrder: 'desc'
 *             containerFilters:
 *               status: 'running'
 *               image: 'nginx'
 *             containerColumns:
 *               name: true
 *               status: true
 *               image: true
 *               ports: true
 *               createdAt: false
 *     responses:
 *       200:
 *         description: User preferences updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   $ref: '#/components/schemas/UserPreferenceInfo'
 *                 message:
 *                   type: string
 *                   example: 'User preferences updated successfully'
 *               required:
 *                 - success
 *                 - data
 *                 - message
 *             example:
 *               success: true
 *               data:
 *                 id: 'pref123'
 *                 containerSortField: 'status'
 *                 containerSortOrder: 'desc'
 *                 containerFilters:
 *                   status: 'running'
 *                   image: 'nginx'
 *                 containerColumns:
 *                   name: true
 *                   status: true
 *                   image: true
 *                   ports: true
 *                   createdAt: false
 *                 timezone: 'America/New_York'
 *                 createdAt: '2025-09-20T15:00:00.000Z'
 *                 updatedAt: '2025-09-24T12:00:00.000Z'
 *               message: 'User preferences updated successfully'
 *       400:
 *         description: Validation error or invalid timezone
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ValidationError'
 *             examples:
 *               validationError:
 *                 summary: Request validation failed
 *                 value:
 *                   success: false
 *                   message: 'Invalid request data'
 *                   error:
 *                     - code: 'invalid_enum_value'
 *                       options: ['asc', 'desc']
 *                       path: ['containerSortOrder']
 *                       message: 'Invalid enum value'
 *               timezoneError:
 *                 summary: Invalid timezone provided
 *                 value:
 *                   success: false
 *                   message: 'Invalid timezone: Invalid/Timezone'
 *       401:
 *         description: Authentication required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.put("/preferences", async (req: Request, res: Response) => {
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

/**
 * @swagger
 * /api/user/timezones:
 *   get:
 *     summary: Get list of common timezones
 *     description: Retrieve a list of commonly used timezones for user selection in preference forms. Each timezone includes the identifier, display label, and current UTC offset.
 *     tags:
 *       - User Preferences
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *       - ApiKeyAuthBearer: []
 *     responses:
 *       200:
 *         description: Timezones retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/TimezoneInfo'
 *                 message:
 *                   type: string
 *                   example: 'Timezones retrieved successfully'
 *               required:
 *                 - success
 *                 - data
 *                 - message
 *             example:
 *               success: true
 *               data:
 *                 - value: 'UTC'
 *                   label: 'UTC (Coordinated Universal Time)'
 *                   offset: '+00:00'
 *                 - value: 'America/New_York'
 *                   label: 'Eastern Time (US & Canada)'
 *                   offset: '-05:00'
 *                 - value: 'America/Los_Angeles'
 *                   label: 'Pacific Time (US & Canada)'
 *                   offset: '-08:00'
 *                 - value: 'Europe/London'
 *                   label: 'Greenwich Mean Time (London)'
 *                   offset: '+00:00'
 *                 - value: 'Asia/Tokyo'
 *                   label: 'Japan Standard Time (Tokyo)'
 *                   offset: '+09:00'
 *               message: 'Timezones retrieved successfully'
 *       401:
 *         description: Authentication required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get("/timezones", async (req: Request, res: Response) => {
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
