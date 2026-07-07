import { Router, Request, Response, RequestHandler } from "express";
import { z } from "zod";
import { requirePermission } from "../middleware/auth";
import { getLogger } from "../lib/logger-factory";
import { asyncHandler } from "../lib/async-handler";
import { ALL_PERMISSION_SCOPES, Permission } from "@mini-infra/types";
import {
  getAllPresets,
  createPreset,
  updatePreset,
  deletePreset,
} from "../services/permission-preset-service";

const logger = getLogger("auth", "permission-presets");
const router = Router();

const presetBodySchema = z.object({
  name: z
    .string()
    .min(1, "Name is required")
    .max(100, "Name must be less than 100 characters"),
  description: z
    .string()
    .max(500, "Description must be less than 500 characters")
    .default(""),
  permissions: z
    .array(z.string())
    .refine(
      (val) =>
        val.every(
          (scope) => scope === "*" || ALL_PERMISSION_SCOPES.includes(scope),
        ),
      { message: "Invalid permission scope(s) provided" },
    ),
});

const updatePresetBodySchema = presetBodySchema.partial();

// GET /api/permission-presets
router.get(
  "/",
  requirePermission(Permission.ApiKeysRead) as RequestHandler,
  asyncHandler(async (_req: Request, res: Response) => {
    const presets = await getAllPresets();
    res.json({ success: true, data: presets });
  }),
);

// POST /api/permission-presets
router.post(
  "/",
  requirePermission(Permission.ApiKeysWrite) as RequestHandler,
  asyncHandler(async (req: Request, res: Response) => {
    const result = presetBodySchema.safeParse(req.body);
    if (!result.success) {
      logger.warn(
        { errors: result.error.issues },
        "Invalid permission preset create request",
      );
      throw result.error;
    }
    const preset = await createPreset(result.data);
    res.status(201).json({ success: true, data: preset });
  }),
);

// PATCH /api/permission-presets/:id
router.patch(
  "/:id",
  requirePermission(Permission.ApiKeysWrite) as RequestHandler,
  asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const result = updatePresetBodySchema.safeParse(req.body);
    if (!result.success) {
      logger.warn(
        { id, errors: result.error.issues },
        "Invalid permission preset update request",
      );
      throw result.error;
    }
    const preset = await updatePreset(id, result.data);
    res.json({ success: true, data: preset });
  }),
);

// DELETE /api/permission-presets/:id
router.delete(
  "/:id",
  requirePermission(Permission.ApiKeysWrite) as RequestHandler,
  asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.params.id);
    await deletePreset(id);
    res.json({ success: true, message: "Permission preset deleted" });
  }),
);

export default router;
