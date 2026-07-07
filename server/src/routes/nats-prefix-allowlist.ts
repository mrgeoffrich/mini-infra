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
  toEntryInfo,
} from "../services/nats/nats-prefix-allowlist-service";
import { NotFoundError } from "../lib/errors";
import { ErrorCode, Permission } from "@mini-infra/types";

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

// `schema.parse()` throws the native `ZodError` on failure, which the central
// middleware (`server/src/lib/error-handler.ts`) already maps to the standard
// `VALIDATION_FAILED` 400 envelope with per-field `details` — no bespoke
// parsing/response code needed here.

// ─── GET / ────────────────────────────────────────────────────────────────

router.get(
  "/",
  requirePermission(Permission.NatsRead),
  asyncHandler(async (_req, res) => {
    const entries = await allowlistService.list();
    res.json({ success: true, data: entries.map(toEntryInfo) });
  }),
);

// ─── GET /:prefix ─────────────────────────────────────────────────────────

router.get(
  "/:prefix",
  requirePermission(Permission.NatsRead),
  asyncHandler(async (req, res) => {
    const prefix = prefixParamSchema.parse(req.params.prefix);
    const entry = await allowlistService.get(prefix);
    if (!entry) {
      throw new NotFoundError(
        ErrorCode.NATS_PREFIX_ALLOWLIST_NOT_FOUND,
        `Allowlist entry for prefix '${prefix}' not found`,
        { resource: { type: "natsPrefixAllowlistEntry", name: prefix } },
      );
    }
    res.json({ success: true, data: toEntryInfo(entry) });
  }),
);

// ─── POST / ───────────────────────────────────────────────────────────────

router.post(
  "/",
  requirePermission(Permission.NatsAdmin),
  asyncHandler(async (req, res) => {
    const input = upsertBodySchema.parse(req.body);
    const userId = getUserId(req) ?? "unknown";
    const created = await allowlistService.create(input, userId);
    res.status(201).json({ success: true, data: toEntryInfo(created) });
  }),
);

// ─── PUT /:prefix ─────────────────────────────────────────────────────────

router.put(
  "/:prefix",
  requirePermission(Permission.NatsAdmin),
  asyncHandler(async (req, res) => {
    const prefix = prefixParamSchema.parse(req.params.prefix);
    const input = updateBodySchema.parse(req.body);
    const userId = getUserId(req) ?? "unknown";
    const updated = await allowlistService.update(prefix, input, userId);
    res.json({ success: true, data: toEntryInfo(updated) });
  }),
);

// ─── DELETE /:prefix ──────────────────────────────────────────────────────

router.delete(
  "/:prefix",
  requirePermission(Permission.NatsAdmin),
  asyncHandler(async (req, res) => {
    const prefix = prefixParamSchema.parse(req.params.prefix);
    const userId = getUserId(req) ?? "unknown";
    await allowlistService.remove(prefix, userId);
    res.json({ success: true });
  }),
);

export default router;
