import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '../../generated/prisma/client';
import type { JobPoolConfig, JobPoolTrigger, PoolInstance as PoolInstanceDb } from '@mini-infra/types';
import type { DockerExecutorService } from '../docker-executor';
import { getLogger } from '../../lib/logger-factory';
import { spawnPoolInstance } from './pool-spawner';
import { publishJobPoolRunSkipped } from './job-pool-history-publisher';
import { jobPoolRuntimeEnvResolvers } from './job-pool-runtime-env-resolver';

const log = getLogger('stacks', 'job-pool-spawner');

/**
 * Sentinel `idleTimeoutMinutes` value written to PoolInstance rows that back a
 * JobPool run. The Pool-instance reaper still uses `idleTimeoutMinutes` to
 * idle-sweep stuck rows for *Pool* services; JobPool rows are excluded from
 * that sweep at the reaper layer (MINI-50 review finding M3), and the exit
 * watcher + `killAfterSeconds` are the real JobPool lifecycle drivers. We
 * still set a generous default here so the column stays non-null. 24h matches
 * the upper bound the pool schema allows.
 */
const JOB_POOL_DEFAULT_IDLE_MINUTES = 24 * 60;

/**
 * Docker label that carries the retry-attempt counter through the spawn →
 * Docker → die-event round trip. The exit watcher reads it off the `die`
 * event labels so each scheduled retry receives the **correct** running
 * count — without this label, every retry would believe it was attempt 1
 * and `onFailure.retries >= 1` would loop forever (MINI-50 review finding H1).
 *
 * Exported so the watcher and unit tests can reference the same string.
 */
export const RETRY_ATTEMPT_LABEL = 'mini-infra.job-pool-retry-attempt';

/** Docker label that carries the trigger metadata JSON (M8). */
export const TRIGGER_METADATA_LABEL = 'mini-infra.job-pool-trigger-metadata';

export type JobPoolTriggerKind = 'cron' | 'nats-request' | 'manual';

export interface RunJobPoolContext {
  stackId: string;
  serviceName: string;
  trigger: {
    kind: JobPoolTriggerKind;
    name: string;
    /**
     * Optional structured authoring metadata for the trigger. Mirrors the
     * `JobPoolTrigger.metadata` shape — when a trigger registry (cron /
     * nats / manual route) fires `runJobPool`, it copies the matched
     * trigger's metadata in here so the resolver can read structured keys
     * without parsing the trigger name.
     */
    metadata?: Record<string, string>;
  };
  /** Optional payload forwarded as `JOB_PAYLOAD` env var. */
  payload?: Record<string, unknown>;
  /**
   * Number of retries already attempted for this run lineage. Defaults to 0.
   * The exit-watcher → retry-scheduler → runJobPool chain propagates this
   * forward so a non-zero exit on attempt N spawns attempt N+1 with the
   * counter advanced, and the scheduler's `attemptedRetries < retries`
   * guard bounds the chain (MINI-50 review finding H1).
   */
  attemptedRetries?: number;
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
 * Resolve the trigger-declared `runId` strategy for this run. Most resolvers
 * want the framework's UUID, but the pg-az-backup / restore-executor
 * materialisers seed a runId from a domain row id (BackupOperation /
 * RestoreOperation) so the in-container progress subject lines up with the
 * UI's existing listing query. The resolver still uses `ctx.runId` to write
 * its row's primary key — this helper just chooses which `runId` the
 * framework reserves the `PoolInstance` row under.
 *
 * Today the only signal is `payload.runId` (for the manual-route flow that
 * explicitly forwards a pre-generated id from an external pre-flight pass).
 * Cron / nats-request always get a fresh UUID — by the time the resolver
 * runs, the row is already committed so the resolver has no opportunity to
 * influence the framework's PK choice. This matches the H3 fix's intent:
 * cap-check + reservation **before** any expensive resolver work.
 */
function pickRunId(payload: Record<string, unknown> | undefined): string {
  const fromPayload = payload?.runId;
  if (typeof fromPayload === 'string' && fromPayload.length > 0) {
    return fromPayload;
  }
  return randomUUID();
}

/**
 * Direct internal entry point for running a JobPool service once.
 *
 * Sequencing (load-bearing — see MINI-50 review finding H3):
 *  1. Load the service + stack and validate cheaply.
 *  2. Fast pre-check of the concurrency cap as a cheap optimisation.
 *  3. **Atomic transaction**: re-check cap and create the `PoolInstance`
 *     row with `id: runId` in a single SQLite transaction so two
 *     concurrent runs can't over-commit. Losers return `concurrency_cap`
 *     **before** any expensive per-run resource minting happens.
 *  4. Only **after** the row is reserved, invoke the runtime env resolver
 *     (which may mint an Azure SAS URL, write a BackupOperation row, etc.).
 *  5. Spawn the container.
 *
 * Pre-fix, the resolver ran between step (2) and (3), so two concurrent
 * triggers under a `maxConcurrent: 1` cap would both create
 * BackupOperation rows + mint SAS handles before one of them lost the
 * atomic check — orphan rows + leaked credential windows in production.
 */
export async function runJobPool(
  prisma: PrismaClient,
  dockerExecutor: DockerExecutorService,
  ctx: RunJobPoolContext,
): Promise<RunJobPoolResult> {
  const { stackId, serviceName, trigger } = ctx;
  const attemptedRetries = ctx.attemptedRetries ?? 0;

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

  // Fast pre-check of the cap. The atomic transaction below is the
  // authoritative check; this just avoids generating a runId and hitting the
  // transaction for an already-over-cap pool.
  if (jobPoolConfig.maxConcurrent !== null) {
    const activeCount = await prisma.poolInstance.count({
      where: {
        stackId,
        serviceName,
        status: { in: ['starting', 'running'] },
      },
    });
    if (activeCount >= jobPoolConfig.maxConcurrent) {
      void publishJobPoolRunSkipped({
        stackId,
        serviceName,
        reason: 'concurrency_cap',
        triggerKind: trigger.kind,
        triggerName: trigger.name,
        scheduledAtMs: Date.now(),
        maxConcurrent: jobPoolConfig.maxConcurrent,
      }).catch(() => {
        /* logged inside publisher */
      });
      return {
        ok: false,
        reason: 'concurrency_cap',
        maxConcurrent: jobPoolConfig.maxConcurrent,
      };
    }
  }

  // Generate the runId now — the atomic transaction reserves the row under
  // this id, so the resolver (which runs strictly after) can write any
  // external rows keyed against the same value.
  const runId = pickRunId(ctx.payload);

  // Atomic cap-check + reservation. SQLite serialises writes so the count +
  // create transaction can't deliver two over-the-cap rows on concurrent
  // calls. Mirrors the pattern in `stacks-pool-routes.ts`. The resolver
  // runs strictly AFTER this transaction commits, so cap-hit losers never
  // create a BackupOperation row or mint a SAS handle (H3 fix).
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

  // Resolver phase — runs *after* the atomic reservation. Pull the trigger
  // metadata from the live JobPool config so the resolver sees the same
  // declared metadata the template author wrote (M8). Triggers that didn't
  // declare metadata get an empty object, not undefined, so the resolver
  // can read keys without optional-chaining everywhere.
  const declaredTrigger = (jobPoolConfig.triggers as JobPoolTrigger[]).find(
    (t) => t.name === trigger.name,
  );
  const triggerMetadata: Record<string, string> = {
    ...(declaredTrigger?.metadata ?? {}),
    ...(trigger.metadata ?? {}),
  };

  const resolver = jobPoolRuntimeEnvResolvers.getResolver(stackId, serviceName);
  let resolverEnv: Record<string, string> = {};
  if (resolver) {
    try {
      const resolved = await resolver(prisma, dockerExecutor, {
        stackId,
        serviceName,
        trigger: { kind: trigger.kind, name: trigger.name, metadata: triggerMetadata },
        payload: ctx.payload,
        runId,
      });
      if (resolved.error) {
        log.warn(
          { stackId, serviceName, trigger: trigger.name, reason: resolved.error, runId },
          'JobPool runtime env resolver aborted spawn',
        );
        // Transition the reserved row to `error` so the lifecycle stays
        // observable — the resolver had a chance to write its own
        // domain-specific failure record (BackupOperation.failed, etc.)
        // before we got here.
        await prisma.poolInstance.update({
          where: { id: row.id },
          data: {
            status: 'error',
            errorMessage: resolved.error,
            stoppedAt: new Date(),
          },
        }).catch(() => { /* already logged downstream */ });
        return {
          ok: false,
          reason: 'spawn_failed',
          message: resolved.error,
          instanceRowId: row.id,
        };
      }
      resolverEnv = resolved.env ?? {};
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { stackId, serviceName, trigger: trigger.name, runId, err: msg },
        'JobPool runtime env resolver threw',
      );
      await prisma.poolInstance.update({
        where: { id: row.id },
        data: { status: 'error', errorMessage: msg, stoppedAt: new Date() },
      }).catch(() => { /* already logged downstream */ });
      return { ok: false, reason: 'spawn_failed', message: msg, instanceRowId: row.id };
    }
  }

  const callerEnv: Record<string, string> = {};
  // Resolver-supplied env goes in first so the standard JOB_* keys below
  // always win on conflict — the resolver shouldn't be naming variables
  // that collide with the framework contract, but if it does the framework
  // is the source of truth.
  Object.assign(callerEnv, resolverEnv);
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
      //
      // RETRY_ATTEMPT_LABEL carries the retry-counter so the watcher
      // schedules the *next* retry with the correct attempt count (H1).
      // Stamped on every spawn — attempt 0 (first run), attempt N (after
      // the watcher chained N-1 retries before this one).
      extraLabels: {
        'mini-infra.job-pool-trigger-kind': trigger.kind,
        'mini-infra.job-pool-trigger-name': trigger.name.replace(/[^A-Za-z0-9._#-]/g, '_'),
        [RETRY_ATTEMPT_LABEL]: String(attemptedRetries),
        // Trigger metadata as a JSON blob — the watcher doesn't need it
        // (the resolver consumed it on the way in), but it's useful for
        // post-hoc debugging via `docker inspect` and keeps the
        // attribution round trip self-describing.
        ...(Object.keys(triggerMetadata).length > 0
          ? {
              [TRIGGER_METADATA_LABEL]: JSON.stringify(triggerMetadata).slice(0, 4096),
            }
          : {}),
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
