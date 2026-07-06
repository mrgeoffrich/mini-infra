import { Router } from "express";
import { z } from "zod";
import crypto from "crypto";
import { asyncHandler } from "../lib/async-handler";
import { getUserId } from "../lib/get-user-id";
import { emitToChannel } from "../lib/socket";
import { requirePermission } from "../middleware/auth";
import { getNatsControlPlaneService } from "../services/nats/nats-control-plane-service";
import { NatsBus } from "../services/nats/nats-bus";
import {
  restoreEncryptedIdentitySeeds,
  IdentitySeedBackupError,
} from "../services/nats/nats-identity-seed-backup";
import {
  loadIdentitySeedBlobFromSelfBackup,
  SelfBackupNotFoundError,
  SelfBackupNoSeedEntryError,
} from "../services/backup/self-backup-seed-restore";
import { ProviderNoLongerConfiguredError } from "../services/storage/storage-service";
import { Channel, ServerEvent, Permission } from "@mini-infra/types";

const router = Router();

const nameSchema = z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9_-]*$/);
const subjectSchema = z.string().min(1).max(255).regex(/^[A-Za-z0-9_$*>\-.]+$/);
const subjectListSchema = z.array(subjectSchema).min(1);

const accountCreateSchema = z.object({
  name: nameSchema,
  displayName: z.string().min(1).max(200),
  description: z.string().max(500).optional(),
});

const accountUpdateSchema = z.object({
  displayName: z.string().min(1).max(200).optional(),
  description: z.string().max(500).nullable().optional(),
});

const credentialCreateSchema = z.object({
  name: nameSchema,
  displayName: z.string().min(1).max(200),
  description: z.string().max(500).optional(),
  accountId: z.string().min(1),
  publishAllow: subjectListSchema,
  subscribeAllow: subjectListSchema,
  ttlSeconds: z.number().int().min(0).max(365 * 24 * 60 * 60).optional(),
});

const credentialUpdateSchema = credentialCreateSchema.partial().omit({ name: true });

const streamCreateSchema = z.object({
  name: nameSchema,
  accountId: z.string().min(1),
  description: z.string().max(500).optional(),
  subjects: subjectListSchema,
  retention: z.enum(["limits", "interest", "workqueue"]).optional(),
  storage: z.enum(["file", "memory"]).optional(),
  maxMsgs: z.number().int().nullable().optional(),
  maxBytes: z.number().int().nullable().optional(),
  maxAgeSeconds: z.number().int().nullable().optional(),
});

const streamUpdateSchema = streamCreateSchema.partial().omit({ name: true });

const consumerCreateSchema = z.object({
  streamId: z.string().min(1),
  name: nameSchema,
  durableName: nameSchema.optional(),
  description: z.string().max(500).optional(),
  filterSubject: subjectSchema.optional(),
  deliverPolicy: z.enum(["all", "last", "new", "by_start_sequence", "by_start_time", "last_per_subject"]).optional(),
  ackPolicy: z.enum(["none", "all", "explicit"]).optional(),
  maxDeliver: z.number().int().nullable().optional(),
  ackWaitSeconds: z.number().int().nullable().optional(),
});

const consumerUpdateSchema = consumerCreateSchema.partial().omit({ name: true });

const mintSchema = z.object({
  ttlSeconds: z.number().int().min(0).max(365 * 24 * 60 * 60).optional(),
});

const restoreSeedsSchema = z.object({
  /** Id of the stored self-backup whose encrypted seed blob to restore from. */
  selfBackupId: z.string().min(1),
  /**
   * Overwrite a present-but-different seed. Off by default so a restore can
   * never silently swap a live identity — the normal target is an empty path.
   */
  force: z.boolean().optional(),
});

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const message = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw Object.assign(new Error(`Validation failed: ${message}`), { statusCode: 400 });
  }
  return parsed.data;
}

router.get(
  "/status",
  requirePermission(Permission.NatsRead),
  asyncHandler(async (_req, res) => {
    res.json({ success: true, data: await getNatsControlPlaneService().getStatus() });
  }),
);

router.post(
  "/apply",
  requirePermission(Permission.NatsAdmin),
  asyncHandler(async (_req, res) => {
    const operationId = `nats-apply-${crypto.randomUUID()}`;
    try {
      await getNatsControlPlaneService().applyConfig();
      await getNatsControlPlaneService().applyJetStreamResources();
      // applyConfig() rotated the server-bus creds blob in Vault KV; tell
      // the live bus to reconnect and pick up the fresh creds. No-op if
      // the bus hasn't been started yet (cold-boot path is wired in
      // server.ts and short-circuits there). Same call site as the boot
      // path — keeps the mint-then-invalidate pair consistent.
      NatsBus.getInstance().invalidateCreds();
      emitToChannel(Channel.NATS, ServerEvent.NATS_APPLIED, { operationId, success: true });
      res.json({ success: true, data: { operationId } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emitToChannel(Channel.NATS, ServerEvent.NATS_APPLIED, { operationId, success: false, message });
      throw err;
    }
  }),
);

/**
 * Restore the NATS identity seeds (operator + accounts) from a stored
 * self-backup into Vault KV — the Phase 2 recovery path for the exact data
 * loss Phase 1's guard refuses to re-key through. Admin-gated. Idempotent:
 * writes only missing/empty seed paths; a present-but-different seed is a
 * conflict that is refused (409) unless `force` is set. Does NOT mint a new
 * identity, so a subsequent `applyConfig` reconciles the *restored* identity.
 */
router.post(
  "/identity-seeds/restore",
  requirePermission(Permission.NatsAdmin),
  asyncHandler(async (req, res) => {
    const input = parseBody(restoreSeedsSchema, req.body ?? {});
    try {
      const blob = await loadIdentitySeedBlobFromSelfBackup(input.selfBackupId);
      const result = await restoreEncryptedIdentitySeeds(blob, {
        force: input.force,
        userId: getUserId(req),
      });
      if (!result.applied) {
        // Conflict: a present-but-different seed would be clobbered. Nothing
        // was written. Surface the classification so the operator can decide
        // whether to re-run with force.
        return res.status(409).json({
          success: false,
          error: "SEED_RESTORE_CONFLICT",
          message:
            "One or more seeds already present in Vault differ from the backup; " +
            "nothing was restored. Re-run with force to overwrite.",
          data: result,
        });
      }
      return res.json({ success: true, data: result });
    } catch (err) {
      if (err instanceof SelfBackupNotFoundError) {
        return res.status(404).json({ success: false, error: err.code, message: err.message });
      }
      if (err instanceof SelfBackupNoSeedEntryError) {
        return res.status(400).json({ success: false, error: err.code, message: err.message });
      }
      if (err instanceof ProviderNoLongerConfiguredError) {
        return res.status(409).json({ success: false, error: err.code, message: err.message, providerId: err.providerId });
      }
      if (err instanceof IdentitySeedBackupError) {
        return res.status(400).json({ success: false, error: "SEED_BACKUP_DECRYPT_FAILED", message: err.message });
      }
      throw err;
    }
  }),
);

router.get("/accounts", requirePermission(Permission.NatsRead), asyncHandler(async (_req, res) => {
  res.json({ success: true, data: await getNatsControlPlaneService().listAccounts() });
}));

router.post("/accounts", requirePermission(Permission.NatsWrite), asyncHandler(async (req, res) => {
  const input = parseBody(accountCreateSchema, req.body);
  res.status(201).json({ success: true, data: await getNatsControlPlaneService().createAccount(input, getUserId(req)) });
}));

router.patch("/accounts/:id", requirePermission(Permission.NatsWrite), asyncHandler(async (req, res) => {
  const input = parseBody(accountUpdateSchema, req.body);
  res.json({ success: true, data: await getNatsControlPlaneService().updateAccount(String(req.params.id), input, getUserId(req)) });
}));

router.delete("/accounts/:id", requirePermission(Permission.NatsWrite), asyncHandler(async (req, res) => {
  await getNatsControlPlaneService().deleteAccount(String(req.params.id));
  res.json({ success: true });
}));

router.get("/credentials", requirePermission(Permission.NatsRead), asyncHandler(async (_req, res) => {
  res.json({ success: true, data: await getNatsControlPlaneService().listCredentialProfiles() });
}));

router.post("/credentials", requirePermission(Permission.NatsWrite), asyncHandler(async (req, res) => {
  const input = parseBody(credentialCreateSchema, req.body);
  res.status(201).json({ success: true, data: await getNatsControlPlaneService().createCredentialProfile(input, getUserId(req)) });
}));

router.patch("/credentials/:id", requirePermission(Permission.NatsWrite), asyncHandler(async (req, res) => {
  const input = parseBody(credentialUpdateSchema, req.body);
  res.json({ success: true, data: await getNatsControlPlaneService().updateCredentialProfile(String(req.params.id), input, getUserId(req)) });
}));

router.delete("/credentials/:id", requirePermission(Permission.NatsWrite), asyncHandler(async (req, res) => {
  await getNatsControlPlaneService().deleteCredentialProfile(String(req.params.id));
  res.json({ success: true });
}));

router.post("/credentials/:id/mint", requirePermission(Permission.NatsWrite), asyncHandler(async (req, res) => {
  const input = parseBody(mintSchema, req.body ?? {});
  res.json({ success: true, data: await getNatsControlPlaneService().mintCredentialsForProfile(String(req.params.id), input.ttlSeconds) });
}));

router.get("/streams", requirePermission(Permission.NatsRead), asyncHandler(async (_req, res) => {
  res.json({ success: true, data: await getNatsControlPlaneService().listStreams() });
}));

router.post("/streams", requirePermission(Permission.NatsWrite), asyncHandler(async (req, res) => {
  const input = parseBody(streamCreateSchema, req.body);
  res.status(201).json({ success: true, data: await getNatsControlPlaneService().createStream(input, getUserId(req)) });
}));

router.patch("/streams/:id", requirePermission(Permission.NatsWrite), asyncHandler(async (req, res) => {
  const input = parseBody(streamUpdateSchema, req.body);
  res.json({ success: true, data: await getNatsControlPlaneService().updateStream(String(req.params.id), input, getUserId(req)) });
}));

router.delete("/streams/:id", requirePermission(Permission.NatsWrite), asyncHandler(async (req, res) => {
  await getNatsControlPlaneService().deleteStream(String(req.params.id));
  res.json({ success: true });
}));

router.get("/consumers", requirePermission(Permission.NatsRead), asyncHandler(async (_req, res) => {
  res.json({ success: true, data: await getNatsControlPlaneService().listConsumers() });
}));

router.post("/consumers", requirePermission(Permission.NatsWrite), asyncHandler(async (req, res) => {
  const input = parseBody(consumerCreateSchema, req.body);
  res.status(201).json({ success: true, data: await getNatsControlPlaneService().createConsumer(input, getUserId(req)) });
}));

router.patch("/consumers/:id", requirePermission(Permission.NatsWrite), asyncHandler(async (req, res) => {
  const input = parseBody(consumerUpdateSchema, req.body);
  res.json({ success: true, data: await getNatsControlPlaneService().updateConsumer(String(req.params.id), input, getUserId(req)) });
}));

router.delete("/consumers/:id", requirePermission(Permission.NatsWrite), asyncHandler(async (req, res) => {
  await getNatsControlPlaneService().deleteConsumer(String(req.params.id));
  res.json({ success: true });
}));

export default router;
