import express, { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { requirePermission } from "../middleware/auth";
import {
  getSettings,
  updateSettings,
  validateApiKey,
  deleteApiKey,
} from "../services/agent-settings-service";

const router = express.Router();

// ---------------------------------------------------------------------------
// GET / — get current agent settings
// ---------------------------------------------------------------------------

router.get(
  "/",
  requirePermission("settings:read"),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const settings = await getSettings();
      res.json(settings);
    } catch (error) {
      next(error);
    }
  },
);

// ---------------------------------------------------------------------------
// POST / — update agent settings (API key and/or model)
// ---------------------------------------------------------------------------

const updateSchema = z.object({
  apiKey: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
});

router.post(
  "/",
  requirePermission("settings:write"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = updateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "Validation error",
          details: parsed.error.issues,
        });
        return;
      }

      const settings = await updateSettings(parsed.data);
      res.json(settings);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Invalid model")) {
        res.status(400).json({ error: error.message });
        return;
      }
      next(error);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /validate — validate an API key without saving
// ---------------------------------------------------------------------------

const validateSchema = z.object({
  apiKey: z.string().min(1),
});

router.post(
  "/validate",
  requirePermission("settings:write"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = validateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "Validation error",
          details: parsed.error.issues,
        });
        return;
      }

      const result = await validateApiKey(parsed.data.apiKey);
      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);

// ---------------------------------------------------------------------------
// DELETE /api-key — remove stored API key
// ---------------------------------------------------------------------------

router.delete(
  "/api-key",
  requirePermission("settings:write"),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      await deleteApiKey();
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  },
);

export default router;
