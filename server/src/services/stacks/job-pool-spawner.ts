import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '../../generated/prisma/client';
import type { JobPoolConfig, PoolInstance as PoolInstanceDb } from '@mini-infra/types';
import type { DockerExecutorService } from '../docker-executor';
import { getLogger } from '../../lib/logger-factory';
import { spawnPoolInstance } from './pool-spawner';
import { publishJobPoolRunSkipped } from './job-pool-history-publisher';

const log = getLogger('stacks', 'job-pool-spawner');

/**
 * Sentinel `idleTimeoutMinutes` value written to PoolInstance rows that back a
 * JobPool run. The Pool-instance reaper still uses `idleTimeoutMinutes` to
 * idle-sweep stuck rows; for JobPool, the exit watcher (Phase 2) and
 * `killAfterSeconds` (Phase 2 reaper extension) are the real lifecycle drivers,
 * but until they ship a generous default ensures the reaper doesn't false-kill
 * a long-running job. 24h matches the upper bound the pool schema allows.
 */
const JOB_POOL_DEFAULT_IDLE_MINUTES = 24 * 60;

export type JobPoolTriggerKind = 'cron' | 'nats-request' | 'manual';

export interface RunJobPoolContext {
  stackId: string;
  serviceName: string;
  trigger: { kind: JobPoolTriggerKind; name: string };
  /** Optional payload forwarded as `JOB_PAYLOAD` env var. */
  payload?: Record<string, unknown>;
}

export type RunJobPoolResult =
  | {
      ok: true;
      runId: string;
      instanceRowId: string;
      containerId: string;
    }
  | {
      ok: false;
      reason: 'concurrency_cap';
      maxConcurrent: number;
    }
  | {
      ok: false;
      reason: 'service_not_found' | 'stack_not_found' | 'stack_in_error';
      message: string;
    }
  | {
      ok: false;
      reason: 'spawn_failed';
      message: string;
      instanceRowId: string;
    };

/**
 * Direct internal entry point for running a JobPool service once. Reserves a
 * `PoolInstance` row (atomic cap-check + insert) and delegates the container
 * spawn to `spawnPoolInstance()`, which already does NATS+Vault injection,
 * network attachment, and image-pull-with-auth.
 *
 * Phase 1 — no trigger sources are wired up yet, so the only callers are
 * tests and (eventually) Phase 3's trigger registries. The Phase 3 manual
 * HTTP route in `stacks-job-pool-routes.ts` still returns 501 until then.
 */
export async function runJobPool(
  prisma: PrismaClient,
  dockerExecutor: DockerExecutorService,
  ctx: RunJobPoolContext,
): Promise<RunJobPoolResult> {
  const { stackId, serviceName, trigger } = ctx;

  const service = await prisma.stackService.findFirst({
    where: { stackId, serviceName, serviceType: 'JobPool' },
  });
  if (!service) {
    return { ok: false, reason: 'service_not_found', message: `JobPool service "${serviceName}" not found on stack ${stackId}` };
  }
  const jobPoolConfig = service.jobPoolConfig as unknown as JobPoolConfig | null;
  if (!jobPoolConfig) {
    return { ok: false, reason: 'service_not_found', message: 'JobPool service missing jobPoolConfig' };
  }

  const stack = await prisma.stack.findUnique({
    where: { id: stackId },
    include: { environment: true },
  });
  if (!stack) {
    return { ok: false, reason: 'stack_not_found', message: `Stack ${stackId} not found` };
  }
  if (stack.status === 'error') {
    return {
      ok: false,
      reason: 'stack_in_error',
      message: 'Cannot run JobPool — stack is in error state',
    };
  }

  // The `runId` doubles as the `PoolInstance.instanceId` so the reaper's
  // partial unique index `(stackId, serviceName, instanceId)` doesn't conflict
  // between concurrent runs of the same JobPool. Containers spawned by
  // `spawnPoolInstance` derive their Docker name from it.
  const runId = randomUUID();

  // Atomic cap-check + reservation. SQLite serialises writes so the count +
  // create transaction can't deliver two over-the-cap rows on concurrent
  // calls. Mirrors the pattern in `stacks-pool-routes.ts`.
  const MAX_REACHED = Symbol('jobpool-max-reached');
  type TxResult = { row: PoolInstanceDb };

  let txResult: TxResult;
  try {
    txResult = await prisma.$transaction(async (tx) => {
      if (jobPoolConfig.maxConcurrent !== null) {
        const activeCount = await tx.poolInstance.count({
          where: {
            stackId,
            serviceName,
            status: { in: ['starting', 'running'] },
          },
        });
        if (activeCount >= jobPoolConfig.maxConcurrent) {
          throw MAX_REACHED;
        }
      }
      const created = await tx.poolInstance.create({
        data: {
          stackId,
          serviceName,
          instanceId: runId,
          status: 'starting',
          idleTimeoutMinutes: JOB_POOL_DEFAULT_IDLE_MINUTES,
        },
      });
      return { row: created as unknown as PoolInstanceDb };
    });
  } catch (err) {
    if (err === MAX_REACHED) {
      // Fire-and-forget — publishing the skipped event must never block
      // the trigger's reply path; failures inside the publisher are
      // logged there. Cast `maxConcurrent` because the MAX_REACHED branch
      // is unreachable when `maxConcurrent === null`.
      void publishJobPoolRunSkipped({
        stackId,
        serviceName,
        reason: 'concurrency_cap',
        triggerKind: trigger.kind,
        triggerName: trigger.name,
        scheduledAtMs: Date.now(),
        maxConcurrent: jobPoolConfig.maxConcurrent!,
      }).catch(() => {
        /* logged inside publisher */
      });
      return {
        ok: false,
        reason: 'concurrency_cap',
        maxConcurrent: jobPoolConfig.maxConcurrent!,
      };
    }
    log.error(
      { stackId, serviceName, runId, err: err instanceof Error ? err.message : String(err) },
      'Failed to reserve JobPool run row',
    );
    return {
      ok: false,
      reason: 'spawn_failed',
      message: err instanceof Error ? err.message : String(err),
      instanceRowId: '',
    };
  }

  const row = txResult.row;
  const callerEnv: Record<string, string> = {};
  if (ctx.payload && Object.keys(ctx.payload).length > 0) {
    callerEnv.JOB_PAYLOAD = JSON.stringify(ctx.payload);
  }
  callerEnv.JOB_TRIGGER_KIND = trigger.kind;
  callerEnv.JOB_TRIGGER_NAME = trigger.name;
  callerEnv.JOB_RUN_ID = runId;

  try {
    const spawn = await spawnPoolInstance(prisma, dockerExecutor, {
      stackId,
      stackName: stack.name,
      environmentName: stack.environment?.name ?? null,
      environmentId: stack.environmentId,
      serviceName,
      instanceId: runId,
      instanceRowId: row.id,
      callerEnv,
      idleTimeoutMinutes: JOB_POOL_DEFAULT_IDLE_MINUTES,
      // Trigger attribution survives the spawn → Docker → die-event
      // round trip via these labels; the exit watcher reads them when
      // it builds the history payload. Trigger name is sanitised to
      // satisfy Docker's label-value constraints (no control chars).
      extraLabels: {
        'mini-infra.job-pool-trigger-kind': trigger.kind,
        'mini-infra.job-pool-trigger-name': trigger.name.replace(/[^A-Za-z0-9._#-]/g, '_'),
      },
    });

    if (!spawn.success) {
      await prisma.poolInstance.update({
        where: { id: row.id },
        data: {
          status: 'error',
          errorMessage: spawn.error ?? 'Unknown spawn error',
          stoppedAt: new Date(),
          containerId: spawn.containerId ?? null,
        },
      }).catch((err) => {
        log.error({ rowId: row.id, err }, 'Failed to update JobPool run row to error');
      });
      return {
        ok: false,
        reason: 'spawn_failed',
        message: spawn.error ?? 'Unknown spawn error',
        instanceRowId: row.id,
      };
    }

    // Conditional flip from `starting` to `running` — for fast-exiting jobs,
    // the exit watcher (subscribed to Docker `die` events) may have already
    // finalised this row to `completed`/`failed` before the spawn poll loop
    // returns. `updateMany` with the `starting` filter makes that race a
    // no-op rather than overwriting the watcher's terminal state. The
    // common case (long-running job, watcher hasn't fired yet) flips
    // through `starting → running → completed/failed` as expected.
    const updateCount = await prisma.poolInstance.updateMany({
      where: { id: row.id, status: 'starting' },
      data: {
        status: 'running',
        containerId: spawn.containerId,
        lastActive: new Date(),
      },
    });
    if (updateCount.count === 0) {
      // Watcher beat us — record the containerId for traceability but leave
      // the terminal status field alone.
      await prisma.poolInstance.update({
        where: { id: row.id },
        data: { containerId: spawn.containerId },
      }).catch(() => { /* race-tolerant */ });
    }
    return {
      ok: true,
      runId,
      instanceRowId: row.id,
      containerId: spawn.containerId!,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ stackId, serviceName, runId, err: msg }, 'JobPool spawn threw unexpectedly');
    await prisma.poolInstance.update({
      where: { id: row.id },
      data: { status: 'error', errorMessage: msg, stoppedAt: new Date() },
    }).catch(() => { /* already logged */ });
    return { ok: false, reason: 'spawn_failed', message: msg, instanceRowId: row.id };
  }
}
