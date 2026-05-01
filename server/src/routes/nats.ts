import { Router } from "express";
import { z } from "zod";
import crypto from "crypto";
import { asyncHandler } from "../lib/async-handler";
import { getUserId } from "../lib/get-user-id";
import { emitToChannel } from "../lib/socket";
import { requirePermission } from "../middleware/auth";
import { getNatsControlPlaneService } from "../services/nats/nats-control-plane-service";
import { NatsBus } from "../services/nats/nats-bus";
import { Channel, ServerEvent } from "@mini-infra/types";

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
  requirePermission("nats:read"),
  asyncHandler(async (_req, res) => {
    res.json({ success: true, data: await getNatsControlPlaneService().getStatus() });
  }),
);

router.post(
  "/apply",
  requirePermission("nats:admin"),
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

router.get("/accounts", requirePermission("nats:read"), asyncHandler(async (_req, res) => {
  res.json({ success: true, data: await getNatsControlPlaneService().listAccounts() });
}));

router.post("/accounts", requirePermission("nats:write"), asyncHandler(async (req, res) => {
  const input = parseBody(accountCreateSchema, req.body);
  res.status(201).json({ success: true, data: await getNatsControlPlaneService().createAccount(input, getUserId(req)) });
}));

router.patch("/accounts/:id", requirePermission("nats:write"), asyncHandler(async (req, res) => {
  const input = parseBody(accountUpdateSchema, req.body);
  res.json({ success: true, data: await getNatsControlPlaneService().updateAccount(String(req.params.id), input, getUserId(req)) });
}));

router.delete("/accounts/:id", requirePermission("nats:write"), asyncHandler(async (req, res) => {
  await getNatsControlPlaneService().deleteAccount(String(req.params.id));
  res.json({ success: true });
}));

router.get("/credentials", requirePermission("nats:read"), asyncHandler(async (_req, res) => {
  res.json({ success: true, data: await getNatsControlPlaneService().listCredentialProfiles() });
}));

router.post("/credentials", requirePermission("nats:write"), asyncHandler(async (req, res) => {
  const input = parseBody(credentialCreateSchema, req.body);
  res.status(201).json({ success: true, data: await getNatsControlPlaneService().createCredentialProfile(input, getUserId(req)) });
}));

router.patch("/credentials/:id", requirePermission("nats:write"), asyncHandler(async (req, res) => {
  const input = parseBody(credentialUpdateSchema, req.body);
  res.json({ success: true, data: await getNatsControlPlaneService().updateCredentialProfile(String(req.params.id), input, getUserId(req)) });
}));

router.delete("/credentials/:id", requirePermission("nats:write"), asyncHandler(async (req, res) => {
  await getNatsControlPlaneService().deleteCredentialProfile(String(req.params.id));
  res.json({ success: true });
}));

router.post("/credentials/:id/mint", requirePermission("nats:write"), asyncHandler(async (req, res) => {
  const input = parseBody(mintSchema, req.body ?? {});
  res.json({ success: true, data: await getNatsControlPlaneService().mintCredentialsForProfile(String(req.params.id), input.ttlSeconds) });
}));

router.get("/streams", requirePermission("nats:read"), asyncHandler(async (_req, res) => {
  res.json({ success: true, data: await getNatsControlPlaneService().listStreams() });
}));

router.post("/streams", requirePermission("nats:write"), asyncHandler(async (req, res) => {
  const input = parseBody(streamCreateSchema, req.body);
  res.status(201).json({ success: true, data: await getNatsControlPlaneService().createStream(input, getUserId(req)) });
}));

router.patch("/streams/:id", requirePermission("nats:write"), asyncHandler(async (req, res) => {
  const input = parseBody(streamUpdateSchema, req.body);
  res.json({ success: true, data: await getNatsControlPlaneService().updateStream(String(req.params.id), input, getUserId(req)) });
}));

router.delete("/streams/:id", requirePermission("nats:write"), asyncHandler(async (req, res) => {
  await getNatsControlPlaneService().deleteStream(String(req.params.id));
  res.json({ success: true });
}));

router.get("/consumers", requirePermission("nats:read"), asyncHandler(async (_req, res) => {
  res.json({ success: true, data: await getNatsControlPlaneService().listConsumers() });
}));

router.post("/consumers", requirePermission("nats:write"), asyncHandler(async (req, res) => {
  const input = parseBody(consumerCreateSchema, req.body);
  res.status(201).json({ success: true, data: await getNatsControlPlaneService().createConsumer(input, getUserId(req)) });
}));

router.patch("/consumers/:id", requirePermission("nats:write"), asyncHandler(async (req, res) => {
  const input = parseBody(consumerUpdateSchema, req.body);
  res.json({ success: true, data: await getNatsControlPlaneService().updateConsumer(String(req.params.id), input, getUserId(req)) });
}));

router.delete("/consumers/:id", requirePermission("nats:write"), asyncHandler(async (req, res) => {
  await getNatsControlPlaneService().deleteConsumer(String(req.params.id));
  res.json({ success: true });
}));

export default router;
