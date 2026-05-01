/**
 * NATS subject-prefix allowlist (Phase 2).
 *
 * Per the design doc (§2.6), this route uses **CRUD per entry** rather than
 * a single PUT-the-whole-blob API — a stale blob write would otherwise wipe
 * the whole allowlist atomically. Each prefix is its own row keyed in
 * `SystemSettings` under category `nats-prefix-allowlist`.
 *
 * Endpoints:
 *   GET    /                — list all allowlist entries
 *   GET    /:prefix         — get one entry
 *   POST   /                — create a new entry
 *   PUT    /:prefix         — update an existing entry's allowedTemplateIds
 *   DELETE /:prefix         — remove an entry
 *
 * Permissions: read = `nats:read`; write = `nats:admin` (admin-only — the
 * allowlist gates which templates can claim non-default subject prefixes).
 */

import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/async-handler";
import { getUserId } from "../lib/get-user-id";
import { requirePermission } from "../middleware/auth";
import prisma from "../lib/prisma";
import {
  NatsPrefixAllowlistService,
  NatsPrefixAllowlistError,
  toEntryInfo,
} from "../services/nats/nats-prefix-allowlist-service";

const router = Router();

const allowlistService = new NatsPrefixAllowlistService(prisma);

// `:prefix` route param accepts dotted segments — `events.platform`,
// `navi`, etc. Validation of the prefix itself happens inside the service.
const prefixParamSchema = z.string().min(1).max(120);

const upsertBodySchema = z.object({
  prefix: z.string().min(1).max(120),
  allowedTemplateIds: z.array(z.string().min(1)).min(1),
});

const updateBodySchema = z.object({
  allowedTemplateIds: z.array(z.string().min(1)).min(1),
});

function handleError(err: unknown, res: import("express").Response, next: import("express").NextFunction): void {
  if (err instanceof NatsPrefixAllowlistError) {
    res.status(err.statusCode).json({ success: false, error: err.message });
    return;
  }
  next(err);
}

// ─── GET / ────────────────────────────────────────────────────────────────

router.get(
  "/",
  requirePermission("nats:read"),
  asyncHandler(async (_req, res) => {
    const entries = await allowlistService.list();
    res.json({ success: true, data: entries.map(toEntryInfo) });
  }),
);

// ─── GET /:prefix ─────────────────────────────────────────────────────────

router.get(
  "/:prefix",
  requirePermission("nats:read"),
  asyncHandler(async (req, res, next) => {
    const parsed = prefixParamSchema.safeParse(req.params.prefix);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: "Invalid prefix parameter" });
      return;
    }
    try {
      const entry = await allowlistService.get(parsed.data);
      if (!entry) {
        res.status(404).json({ success: false, error: `Prefix '${parsed.data}' not found in allowlist` });
        return;
      }
      res.json({ success: true, data: toEntryInfo(entry) });
    } catch (err) {
      handleError(err, res, next);
    }
  }),
);

// ─── POST / ───────────────────────────────────────────────────────────────

router.post(
  "/",
  requirePermission("nats:admin"),
  asyncHandler(async (req, res, next) => {
    const parsed = upsertBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: "Validation error", issues: parsed.error.issues });
      return;
    }
    const userId = getUserId(req) ?? "unknown";
    try {
      const created = await allowlistService.create(parsed.data, userId);
      res.status(201).json({ success: true, data: toEntryInfo(created) });
    } catch (err) {
      handleError(err, res, next);
    }
  }),
);

// ─── PUT /:prefix ─────────────────────────────────────────────────────────

router.put(
  "/:prefix",
  requirePermission("nats:admin"),
  asyncHandler(async (req, res, next) => {
    const paramParsed = prefixParamSchema.safeParse(req.params.prefix);
    if (!paramParsed.success) {
      res.status(400).json({ success: false, error: "Invalid prefix parameter" });
      return;
    }
    const bodyParsed = updateBodySchema.safeParse(req.body);
    if (!bodyParsed.success) {
      res.status(400).json({ success: false, error: "Validation error", issues: bodyParsed.error.issues });
      return;
    }
    const userId = getUserId(req) ?? "unknown";
    try {
      const updated = await allowlistService.update(paramParsed.data, bodyParsed.data, userId);
      res.json({ success: true, data: toEntryInfo(updated) });
    } catch (err) {
      handleError(err, res, next);
    }
  }),
);

// ─── DELETE /:prefix ──────────────────────────────────────────────────────

router.delete(
  "/:prefix",
  requirePermission("nats:admin"),
  asyncHandler(async (req, res, next) => {
    const parsed = prefixParamSchema.safeParse(req.params.prefix);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: "Invalid prefix parameter" });
      return;
    }
    const userId = getUserId(req) ?? "unknown";
    try {
      await allowlistService.remove(parsed.data, userId);
      res.json({ success: true });
    } catch (err) {
      handleError(err, res, next);
    }
  }),
);

export default router;
