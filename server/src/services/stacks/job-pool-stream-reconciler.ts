import {
  JOB_HISTORY_STREAM_PREFIX,
  JobPoolSubject,
  jobHistoryStreamName,
  type JobPoolConfig,
} from '@mini-infra/types';
import type { PrismaClient } from '../../generated/prisma/client';
import { getLogger } from '../../lib/logger-factory';
import { getNatsControlPlaneService } from '../nats/nats-control-plane-service';

const log = getLogger('stacks', 'job-pool-stream-reconciler');

const DEFAULT_ACCOUNT_NAME = 'mini-infra-account';
const DEFAULT_MAX_BYTES_PER_POOL = 1024 * 1024 * 1024; // 1 GiB

/**
 * Reconcile per-pool JetStream history streams for every JobPool service on
 * a stack. Mirrors the operator-path pattern from `system-nats-bootstrap.ts`
 * (upsert NatsStream rows, then let the next `applyJetStreamResources()`
 * pass reconcile against live NATS) — driven by stack apply rather than
 * server boot.
 *
 * The flow:
 *  1. Look up every `JobPool` service on the stack and read its
 *     `jobPoolConfig.history` knobs.
 *  2. Upsert one `NatsStream` row per pool, scoped to the stack so the row
 *     cascades on stack delete. Stream name comes from
 *     `jobHistoryStreamName(stackId, serviceName)` — same helper the
 *     `JobPoolBus`-side consumer uses, so the two never drift.
 *  3. Subjects captured: the wildcard parent for the pool's lifecycle
 *     events (`mini-infra.job-pool.<stackId>.<service>.>`) — which covers
 *     `completed`, `failed`, and any future per-pool event verbs without
 *     a re-apply.
 *
 * Stream creation against live NATS is NOT done here — the caller invokes
 * `applyJetStreamResources()` afterwards (the same call already used for
 * role-derived streams). This module only writes the DB rows.
 *
 * Idempotent: every operation is upsert. Orphan cleanup (streams whose
 * JobPool service was removed) is handled by `pruneOrphanJobPoolStreams`
 * below — call sites pair the two.
 */
export async function reconcileJobPoolStreams(
  prisma: PrismaClient,
  stackId: string,
): Promise<{ desiredStreamNames: Set<string> }> {
  const services = await prisma.stackService.findMany({
    where: { stackId, serviceType: 'JobPool' },
  });

  const desiredStreamNames = new Set<string>();
  if (services.length === 0) return { desiredStreamNames };

  const account = await prisma.natsAccount.findUnique({
    where: { name: DEFAULT_ACCOUNT_NAME },
  });
  if (!account) {
    // The default account is created by `ensureDefaultAccount()` during
    // `applyConfig()`. If we hit this on a fresh worktree where the NATS
    // stack hasn't booted yet, skip — the next stack apply will retry.
    log.info(
      { stackId, account: DEFAULT_ACCOUNT_NAME },
      'reconcileJobPoolStreams: default account not yet present; skipping (next apply retries)',
    );
    return { desiredStreamNames };
  }

  for (const svc of services) {
    const cfg = svc.jobPoolConfig as unknown as JobPoolConfig | null;
    if (!cfg) {
      log.warn(
        { stackId, serviceName: svc.serviceName },
        'JobPool service missing jobPoolConfig; skipping history-stream upsert',
      );
      continue;
    }
    const name = jobHistoryStreamName(stackId, svc.serviceName);
    desiredStreamNames.add(name);

    const subjects = [JobPoolSubject.wildcardForPool(stackId, svc.serviceName)];
    const description = `JobPool history for ${stackId}/${svc.serviceName}`;
    const maxAgeSeconds = Math.max(1, cfg.history.retainDays) * 24 * 60 * 60;
    const maxBytes = parseMaxBytes(cfg.history.maxBytes) ?? DEFAULT_MAX_BYTES_PER_POOL;

    const existing = await prisma.natsStream.findUnique({ where: { name } });
    if (existing) {
      await prisma.natsStream.update({
        where: { name },
        data: {
          accountId: account.id,
          stackId,
          description,
          subjects: subjects as unknown as object,
          retention: 'limits',
          storage: 'file',
          maxBytes,
          maxAgeSeconds,
        },
      });
    } else {
      await prisma.natsStream.create({
        data: {
          name,
          accountId: account.id,
          stackId,
          description,
          subjects: subjects as unknown as object,
          retention: 'limits',
          storage: 'file',
          maxBytes,
          maxAgeSeconds,
        },
      });
    }
    log.info(
      { stackId, serviceName: svc.serviceName, streamName: name, subjects, maxAgeSeconds, maxBytes },
      'JobPool history stream reconciled (DB row upserted)',
    );
  }

  return { desiredStreamNames };
}

/**
 * Delete `NatsStream` rows for JobPool services that no longer exist on the
 * stack, and request a best-effort live-NATS delete of the orphan streams.
 * Mirrors `pruneOrphanRoleStreams` from `stack-nats-apply-orchestrator.ts`.
 *
 * Identification: rows on this stack whose name starts with the
 * `JobHistory-` prefix and isn't in the `desiredStreamNames` set.
 */
export async function pruneOrphanJobPoolStreams(
  prisma: PrismaClient,
  stackId: string,
  desiredStreamNames: Set<string>,
): Promise<{ accountId: string | null; orphanStreamNames: string[] }> {
  const existingStreams = await prisma.natsStream.findMany({
    where: { stackId, name: { startsWith: JOB_HISTORY_STREAM_PREFIX } },
  });
  const orphans = existingStreams.filter((s) => !desiredStreamNames.has(s.name));
  if (orphans.length === 0) return { accountId: null, orphanStreamNames: [] };

  const accountId = orphans[0].accountId;
  const names = orphans.map((s) => s.name);
  await prisma.natsStream.deleteMany({ where: { id: { in: orphans.map((s) => s.id) } } });
  log.info({ stackId, orphanStreamNames: names }, 'Deleted orphan JobPool history stream DB rows');
  return { accountId, orphanStreamNames: names };
}

/**
 * Apply both the DB-row reconcile and a best-effort live-NATS delete of any
 * orphan streams. Call after every JobPool stack apply.
 */
export async function applyJobPoolStreamsForStack(
  prisma: PrismaClient,
  stackId: string,
): Promise<void> {
  const { desiredStreamNames } = await reconcileJobPoolStreams(prisma, stackId);
  const { accountId, orphanStreamNames } = await pruneOrphanJobPoolStreams(
    prisma,
    stackId,
    desiredStreamNames,
  );
  // Push the surviving rows + create/update on live NATS in one go.
  const service = getNatsControlPlaneService(prisma);
  try {
    await service.applyJetStreamResources();
  } catch (err) {
    log.warn(
      { stackId, err: err instanceof Error ? err.message : String(err) },
      'applyJetStreamResources failed during JobPool stream reconcile (will retry on next apply)',
    );
  }
  if (accountId && orphanStreamNames.length > 0) {
    try {
      await service.deleteJetStreams(accountId, orphanStreamNames);
    } catch (err) {
      log.warn(
        { stackId, orphanStreamNames, err: err instanceof Error ? err.message : String(err) },
        'Best-effort orphan JobPool stream delete failed (will retry on next apply)',
      );
    }
  }
}

/** Parse a human-readable byte string ("256MB", "1GB", "512MiB") into bytes. */
function parseMaxBytes(input: string | undefined): number | null {
  if (!input) return null;
  const match = /^\s*(\d+(?:\.\d+)?)\s*(B|KB|KiB|MB|MiB|GB|GiB|TB|TiB)?\s*$/i.exec(input);
  if (!match) return null;
  const value = parseFloat(match[1]);
  if (!Number.isFinite(value) || value < 0) return null;
  const unit = (match[2] ?? 'B').toUpperCase();
  const multiplier: Record<string, number> = {
    B: 1,
    KB: 1000,
    KIB: 1024,
    MB: 1000 * 1000,
    MIB: 1024 * 1024,
    GB: 1000 * 1000 * 1000,
    GIB: 1024 * 1024 * 1024,
    TB: 1000 * 1000 * 1000 * 1000,
    TIB: 1024 * 1024 * 1024 * 1024,
  };
  const m = multiplier[unit];
  if (m === undefined) return null;
  return Math.floor(value * m);
}
