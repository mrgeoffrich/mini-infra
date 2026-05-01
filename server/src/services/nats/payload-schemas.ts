/**
 * Zod schemas + inferred TypeScript types for every NATS subject in
 * `lib/types/nats-subjects.ts`.
 *
 * Subjects are the contract (and live in `lib` so the client can see them);
 * the runtime validators live here in the server because `@mini-infra/types`
 * is a runtime-dependency-free types-only package (see lib/CLAUDE.md).
 *
 * Every subject in `ALL_NATS_SUBJECTS` SHOULD have a request schema and (for
 * req/reply subjects) a reply schema registered in `payloadSchemas` below.
 * The `NatsBus` validates outgoing publish/request bodies and incoming
 * subscribe/reply bodies against this registry. A schema mismatch is a
 * thrown error — never a silently-truncated message.
 */

import { z } from "zod";
import {
  ALL_NATS_SUBJECTS,
  BackupSubject,
  EgressFwSubject,
  EgressGwSubject,
  SystemSubject,
  UpdateSubject,
} from "@mini-infra/types";

// ====================================================================
// System / smoke ping (Phase 1)
// ====================================================================

export const systemPingRequestSchema = z.object({
  /** Free-form correlation token echoed back in the reply. */
  nonce: z.string().min(1).max(128),
  /** Caller's wall-clock time, ms since epoch. */
  sentAtMs: z.number().int().nonnegative(),
});
export type SystemPingRequest = z.infer<typeof systemPingRequestSchema>;

export const systemPingReplySchema = z.object({
  /** Echoed `nonce` from the request. */
  nonce: z.string().min(1).max(128),
  /** Responder's wall-clock time, ms since epoch. */
  receivedAtMs: z.number().int().nonnegative(),
  /** Stable identifier of the responder (e.g. "server"). */
  responder: z.string().min(1).max(64),
});
export type SystemPingReply = z.infer<typeof systemPingReplySchema>;

// ====================================================================
// Egress fw-agent (Phase 2 — schemas declared early so Phase 1 lands the
// subject contract end-to-end; the agent is not yet wired)
// ====================================================================

export const egressFwRulesApplyRequestSchema = z.object({
  /** Opaque correlation id for the apply, propagated into events. */
  applyId: z.string().min(1).max(64),
  /** Serialised ruleset; opaque to the bus, agent parses. */
  ruleset: z.string(),
});
export type EgressFwRulesApplyRequest = z.infer<typeof egressFwRulesApplyRequestSchema>;

export const egressFwRulesApplyReplySchema = z.object({
  applyId: z.string(),
  status: z.enum(["applied", "rejected"]),
  /** Reason on rejection, free text. */
  reason: z.string().optional(),
});
export type EgressFwRulesApplyReply = z.infer<typeof egressFwRulesApplyReplySchema>;

// ====================================================================
// Schema registry — used by NatsBus for validation lookups.
// ====================================================================

export interface SubjectSchemaEntry {
  /** Schema for the published / request body on this subject. */
  request: z.ZodType<unknown>;
  /** Schema for the reply (only set for request/reply subjects). */
  reply?: z.ZodType<unknown>;
}

/**
 * The set of subjects this registry knows about. Tied to `ALL_NATS_SUBJECTS`
 * in `lib/types/nats-subjects.ts` so adding a new subject there forces an
 * entry here at compile time — a typo in a key fails to type-check, and a
 * forgotten schema surfaces as a missing-key compile error rather than a
 * silent runtime skip.
 */
export type KnownNatsSubject = (typeof ALL_NATS_SUBJECTS)[number];

/**
 * Concrete subjects only — wildcards and per-id subjects (e.g. `progress.<id>`)
 * are validated by the closest static parent subject's schema if present, or
 * skipped if the bus call is marked `unchecked: true`.
 */
export const payloadSchemas: Record<KnownNatsSubject, SubjectSchemaEntry> = {
  [SystemSubject.ping]: {
    request: systemPingRequestSchema,
    reply: systemPingReplySchema,
  },
  [EgressFwSubject.rulesApply]: {
    request: egressFwRulesApplyRequestSchema,
    reply: egressFwRulesApplyReplySchema,
  },
  // Phase 2+ subjects: schemas land alongside the migration that uses them.
  [EgressFwSubject.rulesApplied]: {
    // Stub: same shape as the apply reply for now; will be re-typed in Phase 2.
    request: egressFwRulesApplyReplySchema,
  },
  [EgressFwSubject.events]: {
    // Opaque blob in Phase 1 — Phase 2 will refine when fw-agent ships.
    request: z.unknown(),
  },
  [EgressFwSubject.health]: {
    request: z.object({
      ok: z.boolean(),
      reportedAtMs: z.number().int().nonnegative(),
    }),
  },
  [EgressGwSubject.rulesApply]: { request: z.unknown() },
  [EgressGwSubject.rulesApplied]: { request: z.unknown() },
  [EgressGwSubject.decisions]: { request: z.unknown() },
  [EgressGwSubject.health]: { request: z.unknown() },
  [BackupSubject.run]: { request: z.unknown() },
  [BackupSubject.progressPrefix]: { request: z.unknown() },
  [BackupSubject.completed]: { request: z.unknown() },
  [BackupSubject.failed]: { request: z.unknown() },
  [UpdateSubject.run]: { request: z.unknown() },
  [UpdateSubject.progressPrefix]: { request: z.unknown() },
  [UpdateSubject.completed]: { request: z.unknown() },
  [UpdateSubject.failed]: { request: z.unknown() },
  [UpdateSubject.healthCheckPassed]: { request: z.unknown() },
};
