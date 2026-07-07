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
import { ConflictError, NotFoundError, ValidationError } from "../lib/errors";
import { Channel, ServerEvent, ErrorCode, Permission } from "@mini-infra/types";

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

// `schema.parse()` throws the native `ZodError` on failure, which the central
// middleware (`server/src/lib/error-handler.ts`) already maps to the standard
// `VALIDATION_FAILED` 400 envelope with per-field `details` — no bespoke
// parsing/response code needed here.

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
    const input = restoreSeedsSchema.parse(req.body ?? {});

    let blob: Buffer;
    try {
      blob = await loadIdentitySeedBlobFromSelfBackup(input.selfBackupId);
    } catch (err) {
      if (err instanceof SelfBackupNotFoundError) {
        throw new NotFoundError(ErrorCode.NATS_SELF_BACKUP_NOT_FOUND, err.message, {
          resource: { type: "selfBackup", id: input.selfBackupId },
        });
      }
      if (err instanceof SelfBackupNoSeedEntryError) {
        throw new ValidationError(ErrorCode.NATS_SELF_BACKUP_NO_SEED_ENTRY, err.message, {
          resource: { type: "selfBackup", id: input.selfBackupId },
        });
      }
      // ProviderNoLongerConfiguredError comes from the storage domain, which
      // hasn't migrated onto the taxonomy yet (Phase 10) — keep this one
      // bespoke mapping until that phase lands.
      if (err instanceof ProviderNoLongerConfiguredError) {
        return res
          .status(409)
          .json({ success: false, error: err.code, message: err.message, providerId: err.providerId });
      }
      throw err;
    }

    let result: Awaited<ReturnType<typeof restoreEncryptedIdentitySeeds>>;
    try {
      result = await restoreEncryptedIdentitySeeds(blob, {
        force: input.force,
        userId: getUserId(req),
      });
    } catch (err) {
      if (err instanceof IdentitySeedBackupError) {
        throw new ValidationError(ErrorCode.NATS_SEED_BACKUP_DECRYPT_FAILED, err.message, {
          resource: { type: "selfBackup", id: input.selfBackupId },
        });
      }
      throw err;
    }

    if (!result.applied) {
      // A present-but-different seed would be clobbered; nothing was
      // written. Surface the classification so the operator can decide
      // whether to re-run with force.
      throw new ConflictError(
        ErrorCode.NATS_IDENTITY_SEED_RESTORE_CONFLICT,
        "One or more seeds already present in Vault differ from the backup; nothing was restored.",
        {
          resource: { type: "natsIdentity" },
          action: "Re-run the restore with force to overwrite the conflicting seed(s).",
          details: result,
        },
      );
    }
    res.json({ success: true, data: result });
  }),
);

router.get("/accounts", requirePermission(Permission.NatsRead), asyncHandler(async (_req, res) => {
  res.json({ success: true, data: await getNatsControlPlaneService().listAccounts() });
}));

router.post("/accounts", requirePermission(Permission.NatsWrite), asyncHandler(async (req, res) => {
  const input = accountCreateSchema.parse(req.body);
  res.status(201).json({ success: true, data: await getNatsControlPlaneService().createAccount(input, getUserId(req)) });
}));

router.patch("/accounts/:id", requirePermission(Permission.NatsWrite), asyncHandler(async (req, res) => {
  const input = accountUpdateSchema.parse(req.body);
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
  const input = credentialCreateSchema.parse(req.body);
  res.status(201).json({ success: true, data: await getNatsControlPlaneService().createCredentialProfile(input, getUserId(req)) });
}));

router.patch("/credentials/:id", requirePermission(Permission.NatsWrite), asyncHandler(async (req, res) => {
  const input = credentialUpdateSchema.parse(req.body);
  res.json({ success: true, data: await getNatsControlPlaneService().updateCredentialProfile(String(req.params.id), input, getUserId(req)) });
}));

router.delete("/credentials/:id", requirePermission(Permission.NatsWrite), asyncHandler(async (req, res) => {
  await getNatsControlPlaneService().deleteCredentialProfile(String(req.params.id));
  res.json({ success: true });
}));

router.post("/credentials/:id/mint", requirePermission(Permission.NatsWrite), asyncHandler(async (req, res) => {
  const input = mintSchema.parse(req.body ?? {});
  res.json({ success: true, data: await getNatsControlPlaneService().mintCredentialsForProfile(String(req.params.id), input.ttlSeconds) });
}));

router.get("/streams", requirePermission(Permission.NatsRead), asyncHandler(async (_req, res) => {
  res.json({ success: true, data: await getNatsControlPlaneService().listStreams() });
}));

router.post("/streams", requirePermission(Permission.NatsWrite), asyncHandler(async (req, res) => {
  const input = streamCreateSchema.parse(req.body);
  res.status(201).json({ success: true, data: await getNatsControlPlaneService().createStream(input, getUserId(req)) });
}));

router.patch("/streams/:id", requirePermission(Permission.NatsWrite), asyncHandler(async (req, res) => {
  const input = streamUpdateSchema.parse(req.body);
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
  const input = consumerCreateSchema.parse(req.body);
  res.status(201).json({ success: true, data: await getNatsControlPlaneService().createConsumer(input, getUserId(req)) });
}));

router.patch("/consumers/:id", requirePermission(Permission.NatsWrite), asyncHandler(async (req, res) => {
  const input = consumerUpdateSchema.parse(req.body);
  res.json({ success: true, data: await getNatsControlPlaneService().updateConsumer(String(req.params.id), input, getUserId(req)) });
}));

router.delete("/consumers/:id", requirePermission(Permission.NatsWrite), asyncHandler(async (req, res) => {
  await getNatsControlPlaneService().deleteConsumer(String(req.params.id));
  res.json({ success: true });
}));

export default router;
