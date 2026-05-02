/**
 * BackupNatsBridge
 *
 * Bridges backup NATS events to Socket.IO and performs durable replay on
 * cold boot. Two subscriptions:
 *
 *   1. Plain `subscribe` on `mini-infra.backup.progress.>` — emits
 *      POSTGRES_OPERATION on the POSTGRES channel per step. Short-lived
 *      events; no JetStream replay needed.
 *
 *   2. JetStream `consume` on `BackupHistory` (BackupHistory-server durable)
 *      — emits POSTGRES_OPERATION_COMPLETED on each completed/failed event
 *      from JetStream and repairs any DB records that were left in "running"
 *      state because the server restarted while a backup was in flight.
 *
 * Both subscriptions are durable across reconnects — they're registered once
 * at boot via NatsBus and re-attached automatically after each reconnect.
 */

import type { PrismaClient } from "../../generated/prisma/client";
import { getLogger } from "../../lib/logger-factory";
import { emitToChannel } from "../../lib/socket";
import {
  BackupSubject,
  Channel,
  NatsConsumer,
  NatsStream,
  NatsWildcard,
  ServerEvent,
} from "@mini-infra/types";
import { NatsBus } from "../nats/nats-bus";
import type { BackupCompleted, BackupFailed } from "../nats/payload-schemas";
import { backupProgressSchema, backupCompletedSchema, backupFailedSchema } from "../nats/payload-schemas";

const log = getLogger("backup", "backup-nats-bridge");

export function startBackupNatsBridge(prisma: PrismaClient): void {
  const bus = NatsBus.getInstance();

  // ── 1. Progress events (plain pub/sub, no replay) ──────────────────────
  // The executor publishes `mini-infra.backup.progress.<operationId>`. We
  // subscribe on the wildcard parent and fan-out to Socket.IO so the backup
  // detail panel in the UI shows live step updates.
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
    },
    { unchecked: true },
  );

  log.info({ subject: NatsWildcard.backupProgressAll }, "Subscribed to backup progress events");

  // ── 2. BackupHistory JetStream consumer ────────────────────────────────
  // Durable consumer on the `BackupHistory` stream. Captures both
  // `mini-infra.backup.completed` and `mini-infra.backup.failed` events.
  // On each message:
  //   - Emit POSTGRES_OPERATION_COMPLETED via Socket.IO.
  //   - Repair the DB record if it's still in "running" state (cold-boot
  //     replay case: backup finished while server was restarting).
  bus.jetstream.consume<unknown>(
    {
      stream: NatsStream.backupHistory,
      durable: NatsConsumer.backupHistoryServer,
    },
    async (msg, ctx) => {
      const isCompleted = ctx.subject === BackupSubject.completed;
      const schema = isCompleted ? backupCompletedSchema : backupFailedSchema;
      const parsed = schema.safeParse(msg);
      if (!parsed.success) {
        log.warn(
          { subject: ctx.subject, issues: parsed.error.issues.slice(0, 3) },
          "BackupHistory message failed validation — skipping",
        );
        return;
      }

      if (isCompleted) {
        const data = parsed.data as BackupCompleted;
        await repairCompletedRecord(prisma, data);
        try {
          emitToChannel(Channel.POSTGRES, ServerEvent.POSTGRES_OPERATION_COMPLETED, {
            operationId: data.operationId,
            type: "backup",
            success: true,
          });
        } catch (emitErr) {
          log.error(
            { operationId: data.operationId, err: emitErr instanceof Error ? emitErr.message : String(emitErr) },
            "Failed to emit backup completed to Socket.IO",
          );
        }
        log.debug({ operationId: data.operationId }, "BackupHistory: completed event processed");
      } else {
        const data = parsed.data as BackupFailed;
        await repairFailedRecord(prisma, data);
        try {
          emitToChannel(Channel.POSTGRES, ServerEvent.POSTGRES_OPERATION_COMPLETED, {
            operationId: data.operationId,
            type: "backup",
            success: false,
            error: data.errorMessage,
          });
        } catch (emitErr) {
          log.error(
            { operationId: data.operationId, err: emitErr instanceof Error ? emitErr.message : String(emitErr) },
            "Failed to emit backup failed to Socket.IO",
          );
        }
        log.debug({ operationId: data.operationId }, "BackupHistory: failed event processed");
      }
    },
    { ack: "auto" },
  );

  log.info(
    { stream: NatsStream.backupHistory, consumer: NatsConsumer.backupHistoryServer },
    "BackupHistory JetStream consumer registered",
  );
}

/**
 * If the DB record for this backup is still in "running" or "pending" state
 * (server restarted while execution was in flight), update it to "completed"
 * with the data from the JetStream event. No-op if the record is already
 * in a terminal state.
 */
async function repairCompletedRecord(prisma: PrismaClient, data: BackupCompleted): Promise<void> {
  try {
    const op = await prisma.backupOperation.findUnique({ where: { id: data.operationId } });
    if (!op || op.status === "completed" || op.status === "failed") return;

    await prisma.backupOperation.update({
      where: { id: data.operationId },
      data: {
        status: "completed",
        progress: 100,
        sizeBytes: data.sizeBytes !== undefined ? BigInt(data.sizeBytes) : undefined,
        storageObjectUrl: data.storageObjectUrl,
        storageProviderAtCreation: data.storageProvider,
        completedAt: new Date(data.completedAtMs),
      },
    });
    log.info(
      { operationId: data.operationId },
      "BackupHistory replay: repaired stale backup record to completed",
    );
  } catch (err) {
    log.error(
      { operationId: data.operationId, err: err instanceof Error ? err.message : String(err) },
      "BackupHistory replay: failed to repair completed record",
    );
  }
}

async function repairFailedRecord(prisma: PrismaClient, data: BackupFailed): Promise<void> {
  try {
    const op = await prisma.backupOperation.findUnique({ where: { id: data.operationId } });
    if (!op || op.status === "completed" || op.status === "failed") return;

    await prisma.backupOperation.update({
      where: { id: data.operationId },
      data: {
        status: "failed",
        progress: 0,
        errorMessage: data.errorMessage,
        completedAt: new Date(data.failedAtMs),
      },
    });
    log.info(
      { operationId: data.operationId },
      "BackupHistory replay: repaired stale backup record to failed",
    );
  } catch (err) {
    log.error(
      { operationId: data.operationId, err: err instanceof Error ? err.message : String(err) },
      "BackupHistory replay: failed to repair failed record",
    );
  }
}
