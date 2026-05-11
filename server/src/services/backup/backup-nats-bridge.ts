/**
 * BackupNatsBridge — Phase 4 (MINI-53)
 *
 * Two subscriptions bridge backup-related NATS subjects to Socket.IO
 * (POSTGRES channel) so the existing events page keeps showing live progress
 * + terminal status for every backup run:
 *
 *   1. Plain `subscribe` on `mini-infra.backup.progress.>` — short-lived
 *      progress messages, now produced **inside the pg-az-backup container**
 *      via `nats-progress.sh` (Phase 4 replaces the server-mediated stdout
 *      bridge that fed this subject before). The bridge fans each message
 *      out as POSTGRES_OPERATION on the POSTGRES channel.
 *
 *   2. Plain `subscribe` on `mini-infra.job-pool.>` — the per-pool history
 *      stream is JetStream-durable for replay, but the bridge only needs
 *      the live fan-out for the UI; the stream's durable consumer is owned
 *      by `job-pool-stream-reconciler.ts` and the JobPool's Socket.IO
 *      emitter already publishes `JOB_POOL_RUN_*` events on the POOLS
 *      channel. We re-emit the `pg-az-backup` ones as
 *      POSTGRES_OPERATION_COMPLETED on POSTGRES so the existing UI tab
 *      keeps working without a client-side rewrite.
 *
 * Both subscriptions are durable across reconnects — they're registered
 * once at boot and re-attached automatically.
 *
 * The bridge previously consumed the retired `BackupHistory` JetStream
 * stream. That code path is gone — the per-pool stream replaces it.
 */

import type { PrismaClient } from "../../generated/prisma/client";
import { getLogger } from "../../lib/logger-factory";
import { emitToChannel } from "../../lib/socket";
import {
  Channel,
  JobPoolSubject,
  NatsWildcard,
  ServerEvent,
} from "@mini-infra/types";
import { NatsBus } from "../nats/nats-bus";
import {
  backupProgressSchema,
  jobPoolRunCompletedSchema,
  jobPoolRunFailedSchema,
  type JobPoolRunCompleted,
  type JobPoolRunFailed,
} from "../nats/payload-schemas";
import { PG_AZ_BACKUP_SERVICE_NAME } from "./backup-job-pool-materialiser";

const log = getLogger("backup", "backup-nats-bridge");

export function startBackupNatsBridge(prisma: PrismaClient): void {
  const bus = NatsBus.getInstance();

  // ── 1. Progress events (plain pub/sub, no replay) ──────────────────────
  // pg-az-backup container publishes `mini-infra.backup.progress.<runId>`
  // via `nats-progress.sh`. The runId is the `BackupOperation.id` so the
  // payload's `operationId` matches the existing UI's expected shape.
  bus.subscribe<unknown>(
    NatsWildcard.backupProgressAll,
    (msg, ctx) => {
      const parsed = backupProgressSchema.safeParse(msg);
      if (!parsed.success) {
        log.warn(
          { subject: ctx.subject, issues: parsed.error.issues.slice(0, 3) },
          "backup progress message failed validation — skipping",
        );
        return;
      }
      const { operationId, status, progress, message } = parsed.data;
      try {
        emitToChannel(Channel.POSTGRES, ServerEvent.POSTGRES_OPERATION, {
          operationId,
          type: "backup",
          status,
          progress,
          message,
        });
      } catch (emitErr) {
        log.error(
          { operationId, err: emitErr instanceof Error ? emitErr.message : String(emitErr) },
          "Failed to emit backup progress to Socket.IO",
        );
      }
      // Best-effort DB mirror: keep the legacy `BackupOperation.progress`
      // column in sync so existing list views (which still query the table
      // directly) show live progress.
      void prisma.backupOperation
        .update({
          where: { id: operationId },
          data: { status, progress },
        })
        .catch((err) => {
          log.debug(
            { operationId, err: err instanceof Error ? err.message : String(err) },
            "Failed to mirror progress to BackupOperation (non-fatal — operation may not exist yet)",
          );
        });
    },
    { unchecked: true },
  );

  log.info({ subject: NatsWildcard.backupProgressAll }, "Subscribed to backup progress events");

  // ── 2. Per-pool JobPool history events (live fan-out only) ─────────────
  // Subscribe to the wildcard parent covering every JobPool's
  // completed/failed/run-skipped subjects (one per applied pool). We filter
  // to the `pg-az-backup` service name inside the handler — the wildcard
  // keeps the registration count fixed at 1 regardless of how many pools
  // are applied.
  bus.subscribe<unknown>(
    `${JobPoolSubject.base}.>`,
    async (msg, ctx) => {
      const subject = ctx.subject;
      // Subject layout: `mini-infra.job-pool.<stackId>.<serviceName>.<verb>`.
      const tokens = subject.split(".");
      if (tokens.length < 5) return;
      const serviceName = tokens[3];
      const verb = tokens[4];
      if (serviceName !== PG_AZ_BACKUP_SERVICE_NAME) return;
      if (verb !== "completed" && verb !== "failed") return;

      const schema = verb === "completed" ? jobPoolRunCompletedSchema : jobPoolRunFailedSchema;
      const parsed = schema.safeParse(msg);
      if (!parsed.success) {
        log.warn(
          { subject, issues: parsed.error.issues.slice(0, 3) },
          "pg-az-backup history message failed validation — skipping",
        );
        return;
      }

      if (verb === "completed") {
        const data = parsed.data as JobPoolRunCompleted;
        await repairCompletedRecord(prisma, data);
        try {
          emitToChannel(Channel.POSTGRES, ServerEvent.POSTGRES_OPERATION_COMPLETED, {
            operationId: data.runId,
            type: "backup",
            success: true,
          });
        } catch (emitErr) {
          log.error(
            { runId: data.runId, err: emitErr instanceof Error ? emitErr.message : String(emitErr) },
            "Failed to emit backup completed to Socket.IO",
          );
        }
      } else {
        const data = parsed.data as JobPoolRunFailed;
        await repairFailedRecord(prisma, data);
        try {
          emitToChannel(Channel.POSTGRES, ServerEvent.POSTGRES_OPERATION_COMPLETED, {
            operationId: data.runId,
            type: "backup",
            success: false,
            error: data.errorMessage,
          });
        } catch (emitErr) {
          log.error(
            { runId: data.runId, err: emitErr instanceof Error ? emitErr.message : String(emitErr) },
            "Failed to emit backup failed to Socket.IO",
          );
        }
      }
    },
    { unchecked: true },
  );

  log.info(
    { subject: `${JobPoolSubject.base}.>` },
    "Subscribed to per-pool JobPool history events (filtered to pg-az-backup)",
  );
}

/**
 * If the DB record for this backup is still in "running" or "pending" state,
 * promote it to "completed" so list views surface terminal status correctly.
 * No-op if the record is already terminal.
 *
 * The Phase 4 path no longer carries `sizeBytes` / `storageObjectUrl` in the
 * JobPool history payload (the JobPool runner is provider-agnostic). For
 * backups that need those fields the in-container script could publish a
 * richer terminal event in a follow-up; for now the operator-facing
 * completed/failed status flips correctly and the size/URL columns stay
 * whatever the executor set during its `BackupOperation.update` mid-run.
 */
async function repairCompletedRecord(
  prisma: PrismaClient,
  data: JobPoolRunCompleted,
): Promise<void> {
  try {
    const op = await prisma.backupOperation.findUnique({ where: { id: data.runId } });
    if (!op || op.status === "completed" || op.status === "failed") return;

    await prisma.backupOperation.update({
      where: { id: data.runId },
      data: {
        status: "completed",
        progress: 100,
        completedAt: new Date(data.finishedAtMs),
      },
    });
    log.info({ runId: data.runId }, "pg-az-backup JobPool history: repaired BackupOperation to completed");
  } catch (err) {
    log.error(
      { runId: data.runId, err: err instanceof Error ? err.message : String(err) },
      "pg-az-backup JobPool history: failed to repair completed record",
    );
  }
}

async function repairFailedRecord(
  prisma: PrismaClient,
  data: JobPoolRunFailed,
): Promise<void> {
  try {
    const op = await prisma.backupOperation.findUnique({ where: { id: data.runId } });
    if (!op || op.status === "completed" || op.status === "failed") return;

    await prisma.backupOperation.update({
      where: { id: data.runId },
      data: {
        status: "failed",
        progress: 0,
        errorMessage: data.errorMessage,
        completedAt: new Date(data.finishedAtMs),
      },
    });
    log.info({ runId: data.runId }, "pg-az-backup JobPool history: repaired BackupOperation to failed");
  } catch (err) {
    log.error(
      { runId: data.runId, err: err instanceof Error ? err.message : String(err) },
      "pg-az-backup JobPool history: failed to repair failed record",
    );
  }
}
