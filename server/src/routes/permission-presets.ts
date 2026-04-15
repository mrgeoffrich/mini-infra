import { Router, Request, Response, RequestHandler } from "express";
import { z } from "zod";
import { requirePermission } from "../middleware/auth";
import { getLogger } from "../lib/logger-factory";
import { ALL_PERMISSION_SCOPES } from "@mini-infra/types";
import {
  getAllPresets,
  createPreset,
  updatePreset,
  deletePreset,
} from "../services/permission-preset-service";

const logger = getLogger("auth", "permission-presets");
const router = Router();

const presetBodySchema = z.object({
  name: z.string().min(1, "Name is required").max(100, "Name must be less than 100 characters"),
  description: z.string().max(500, "Description must be less than 500 characters").default(""),
  permissions: z
    .array(z.string())
    .refine(
      (val) => val.every((scope) => scope === "*" || ALL_PERMISSION_SCOPES.includes(scope)),
      { message: "Invalid permission scope(s) provided" },
    ),
});

const updatePresetBodySchema = presetBodySchema.partial();

// GET /api/permission-presets
router.get(
  "/",
  requirePermission("api-keys:read") as RequestHandler,
  (async (_req: Request, res: Response) => {
    try {
      const presets = await getAllPresets();
      res.json({ success: true, data: presets });
    } catch (error) {
      logger.error({ error }, "Failed to fetch permission presets");
      res.status(500).json({ error: "Internal server error", message: "Failed to fetch permission presets" });
    }
  }) as RequestHandler,
);

// POST /api/permission-presets
router.post(
  "/",
  requirePermission("api-keys:write") as RequestHandler,
  (async (req: Request, res: Response) => {
    const result = presetBodySchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ error: "Validation error", details: result.error.issues });
    }
    try {
      const preset = await createPreset(result.data);
      res.status(201).json({ success: true, data: preset });
    } catch (error) {
      logger.error({ error }, "Failed to create permission preset");
      if (
        error instanceof Error &&
        (error.message.includes("Unique constraint") || error.message.includes("unique"))
      ) {
        return res.status(409).json({ error: "Conflict", message: "A preset with that name already exists" });
      }
      res.status(500).json({ error: "Internal server error", message: "Failed to create permission preset" });
    }
  }) as RequestHandler,
);

// PATCH /api/permission-presets/:id
router.patch(
  "/:id",
  requirePermission("api-keys:write") as RequestHandler,
  (async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const result = updatePresetBodySchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ error: "Validation error", details: result.error.issues });
    }
    try {
      const preset = await updatePreset(id, result.data);
      res.json({ success: true, data: preset });
    } catch (error) {
      logger.error({ error, id }, "Failed to update permission preset");
      if (error instanceof Error && error.message.includes("not found")) {
        return res.status(404).json({ error: "Not found", message: "Permission preset not found" });
      }
      res.status(500).json({ error: "Internal server error", message: "Failed to update permission preset" });
    }
  }) as RequestHandler,
);

// DELETE /api/permission-presets/:id
router.delete(
  "/:id",
  requirePermission("api-keys:write") as RequestHandler,
  (async (req: Request, res: Response) => {
    const id = String(req.params.id);
    try {
      await deletePreset(id);
      res.json({ success: true, message: "Permission preset deleted" });
    } catch (error) {
      logger.error({ error, id }, "Failed to delete permission preset");
      if (error instanceof Error && error.message.includes("not found")) {
        return res.status(404).json({ error: "Not found", message: "Permission preset not found" });
      }
      res.status(500).json({ error: "Internal server error", message: "Failed to delete permission preset" });
    }
  }) as RequestHandler,
);

export default router;
