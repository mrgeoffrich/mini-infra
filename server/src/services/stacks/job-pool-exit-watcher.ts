import type { PrismaClient } from '../../generated/prisma/client';
import type { JobPoolConfig } from '@mini-infra/types';
import {
  type DockerContainerEvent,
} from '../../lib/docker-event-pattern-detector';
import { getLogger } from '../../lib/logger-factory';
import DockerService from '../docker';
import {
  publishJobPoolCompleted,
  publishJobPoolFailed,
} from './job-pool-history-publisher';
import { scheduleJobPoolRetry } from './job-pool-retry-scheduler';
import { RETRY_ATTEMPT_LABEL, TRIGGER_METADATA_LABEL } from './job-pool-spawner';
import type { DockerExecutorService } from '../docker-executor';

const log = getLogger('stacks', 'job-pool-exit-watcher');

/**
 * Sentinel label written by `pool-spawner.ts`. JobPool runs reuse the Pool
 * spawn machinery and therefore inherit the `mini-infra.pool-instance` and
 * `mini-infra.pool-instance-id` labels — the exit watcher filters Docker
 * events down to those two labels and then re-keys against the `PoolInstance`
 * DB row via `(stackId, instanceId)`.
 */
const POOL_INSTANCE_LABEL = 'mini-infra.pool-instance';
const POOL_INSTANCE_ID_LABEL = 'mini-infra.pool-instance-id';
const STACK_ID_LABEL = 'mini-infra.stack-id';

/** Marker we stamp on `errorMessage` for runs killed by `killAfterSeconds`. */
export const KILL_AFTER_SECONDS_ERROR = 'killed: exceeded killAfterSeconds';

/**
 * Watch the Docker event stream for container `die` events that belong to a
 * JobPool run, finalize the `PoolInstance` row, publish the corresponding
 * history event, and schedule a retry if the pool's `onFailure.retries`
 * policy says so.
 *
 * The pool-instance reaper (Phase 1) still owns idle-sweep and stuck-starting
 * cleanup for *Pool* services. This watcher is JobPool-specific — it only
 * touches rows whose owning `StackService.serviceType` is `'JobPool'`. Rows
 * for `Pool` services that exit on their own are still reaped by the
 * existing idle-sweep path (their lifecycle is "run until idle", not "run
 * until exit").
 */
export class JobPoolExitWatcher {
  private registered = false;
  private retryDockerExecutor: DockerExecutorService | null = null;

  constructor(
    private readonly prisma: PrismaClient,
    /**
     * Factory used to obtain a docker executor for scheduled retries.
     * Mirrors the lazy-init pattern in `pool-instance-reaper.ts`: the
     * watcher is wired up before docker is necessarily ready, so we defer
     * obtaining the executor until a retry actually needs to fire.
     */
    private readonly dockerExecutorFactory: () => Promise<DockerExecutorService>,
  ) {}

  start(): void {
    if (this.registered) {
      log.warn('JobPoolExitWatcher already registered');
      return;
    }
    const docker = DockerService.getInstance();
    docker.onContainerEvent((event) => {
      // Fire-and-forget — Docker event listeners must not block the
      // event stream. The watcher swallows its own errors so a bad row
      // can't poison the whole loop.
      void this.handleEvent(event).catch((err) => {
        log.error(
          {
            containerId: event.containerId,
            action: event.action,
            err: err instanceof Error ? err.message : String(err),
          },
          'JobPoolExitWatcher.handleEvent threw',
        );
      });
    });
    this.registered = true;
    log.info('JobPoolExitWatcher registered with Docker event stream');
  }

  /**
   * Public for tests. Process a single Docker event end-to-end.
   *
   * Returns true if the event was handled (either acted upon, or
   * deliberately skipped because it isn't a JobPool exit), and false
   * if a downstream DB/publish error left the row in an inconsistent
   * state — currently only used by tests.
   */
  async handleEvent(event: DockerContainerEvent): Promise<boolean> {
    if (event.action !== 'die') return true;
    if (event.labels[POOL_INSTANCE_LABEL] !== 'true') return true;

    const instanceId = event.labels[POOL_INSTANCE_ID_LABEL];
    const stackId = event.labels[STACK_ID_LABEL];
    if (!instanceId || !stackId) {
      log.warn(
        { containerId: event.containerId, instanceId, stackId },
        'Pool-instance container die event missing required labels',
      );
      return true;
    }

    const row = await this.prisma.poolInstance.findFirst({
      where: { stackId, instanceId },
    });
    if (!row) {
      // Row pruned manually or by a prior reaper sweep — nothing to
      // finalise. The container is already gone; no follow-up needed.
      return true;
    }
    // The exit watcher only finalises JobPool rows. Pool rows continue
    // their existing idle-sweep / stop-on-API-call lifecycle.
    const service = await this.prisma.stackService.findFirst({
      where: { stackId, serviceName: row.serviceName },
    });
    if (!service || service.serviceType !== 'JobPool') return true;
    if (row.status === 'completed' || row.status === 'failed') {
      // Idempotent: a duplicate `die` event (Docker can re-deliver during
      // reconnect) hits a row that's already terminal — no-op.
      return true;
    }

    const jobPoolConfig = service.jobPoolConfig as unknown as JobPoolConfig | null;
    const startedAtMs = row.lastActive.getTime();
    const finishedAtMs = Date.now();

    // Carry trigger attribution forward. JobPool runs spawned via
    // `runJobPool` stamp `JOB_TRIGGER_KIND` / `JOB_TRIGGER_NAME` on the
    // container (Phase 2+) so the watcher can read them off the `die`
    // event labels. Older containers spawned before label-stamping
    // shipped fall back to `manual` / `unknown` for backwards-compat.
    const triggerKind = (event.labels['mini-infra.job-pool-trigger-kind'] as
      | 'cron'
      | 'nats-request'
      | 'manual') ?? 'manual';
    const triggerName = event.labels['mini-infra.job-pool-trigger-name'] ?? 'unknown';

    // Recover the retry-attempt counter from the spawner's label stamp
    // (MINI-50 review finding H1). Containers that pre-date the stamp
    // default to 0 — the watcher still honours the retry budget; the
    // first observed retry chain will start at 1 and bound from there.
    const retryAttemptLabel = event.labels[RETRY_ATTEMPT_LABEL];
    const attemptedRetries =
      retryAttemptLabel !== undefined && /^\d+$/.test(retryAttemptLabel)
        ? Math.min(Number.parseInt(retryAttemptLabel, 10), 1_000_000)
        : 0;

    // Recover the trigger metadata blob (M8). The resolver already consumed
    // it on the way in; we re-propagate it via the retry scheduler so a
    // chained retry sees the same metadata its predecessor did.
    const triggerMetadata = parseTriggerMetadata(event.labels[TRIGGER_METADATA_LABEL]);

    // Treat a missing/unparseable `exitCode` as failure. The Docker event
    // stream only forwards `exitCode` when the `Actor.Attributes` map both
    // contains a finite parseable integer (see `docker.ts:425-432`); a
    // daemon glitch or abnormal exit can produce a `die` event without
    // one. Pre-fix the watcher coerced `undefined` to 0 and marked the
    // run completed — a false-success operators saw as a successful
    // backup (MINI-50 review finding H2). We now route undefined through
    // the failure branch with a distinct error message + exit code -1
    // (the failed schema's `z.number().int()` permits the sentinel).
    let exitCode: number;
    let errorOverride: string | null = null;
    if (event.exitCode === undefined) {
      exitCode = -1;
      errorOverride = 'Container died without a reported exit code';
    } else {
      exitCode = event.exitCode;
    }

    const succeeded = exitCode === 0;
    try {
      await this.prisma.poolInstance.update({
        where: { id: row.id },
        data: {
          status: succeeded ? 'completed' : 'failed',
          exitCode,
          finishedAt: new Date(finishedAtMs),
          stoppedAt: new Date(finishedAtMs),
          // Preserve any prior errorMessage (e.g. the reaper's kill marker)
          // when transitioning a non-zero exit; succeed-overrides nothing.
          errorMessage: succeeded
            ? null
            : errorOverride ?? row.errorMessage ?? `Container exited with code ${exitCode}`,
        },
      });
    } catch (err) {
      log.error(
        {
          rowId: row.id,
          stackId,
          instanceId,
          exitCode,
          err: err instanceof Error ? err.message : String(err),
        },
        'Failed to finalise JobPool PoolInstance row',
      );
      return false;
    }

    if (succeeded) {
      await publishJobPoolCompleted({
        stackId,
        serviceName: row.serviceName,
        runId: instanceId,
        triggerKind,
        triggerName,
        exitCode: 0,
        startedAtMs,
        finishedAtMs,
      });
      log.info(
        { stackId, serviceName: row.serviceName, runId: instanceId, exitCode },
        'JobPool run completed',
      );
      return true;
    }

    const errorMessage =
      errorOverride ?? row.errorMessage ?? `Container exited with code ${exitCode}`;
    await publishJobPoolFailed({
      stackId,
      serviceName: row.serviceName,
      runId: instanceId,
      triggerKind,
      triggerName,
      exitCode,
      errorMessage,
      startedAtMs,
      finishedAtMs,
    });
    log.info(
      { stackId, serviceName: row.serviceName, runId: instanceId, exitCode, errorMessage, attemptedRetries },
      'JobPool run failed',
    );

    // Retry handling — non-zero exits only. Killed-by-reaper runs already
    // have a row.errorMessage of KILL_AFTER_SECONDS_ERROR; we still honor
    // the retry policy for them (the plan doc doesn't carve out an
    // exception). The scheduler's `attemptedRetries < retries` guard
    // bounds the chain; we pass `attemptedRetries + 1` so the next retry
    // is reflected as attempt N+1 in its container label, and the chain
    // terminates when `attemptedRetries >= retries` (H1).
    if (jobPoolConfig?.onFailure && jobPoolConfig.onFailure.retries > 0) {
      try {
        const docker = await this.lazyDockerExecutor();
        scheduleJobPoolRetry(this.prisma, docker, {
          stackId,
          serviceName: row.serviceName,
          attemptedRetries: attemptedRetries + 1,
          onFailure: jobPoolConfig.onFailure,
          trigger: { kind: triggerKind, name: triggerName, metadata: triggerMetadata },
        });
      } catch (err) {
        log.warn(
          {
            stackId,
            serviceName: row.serviceName,
            err: err instanceof Error ? err.message : String(err),
          },
          'Failed to schedule JobPool retry',
        );
      }
    }

    return true;
  }

  private async lazyDockerExecutor(): Promise<DockerExecutorService> {
    if (this.retryDockerExecutor) return this.retryDockerExecutor;
    this.retryDockerExecutor = await this.dockerExecutorFactory();
    return this.retryDockerExecutor;
  }
}

/**
 * Parse the `mini-infra.job-pool-trigger-metadata` Docker label back into a
 * plain `Record<string, string>`. The spawner stamps a JSON-encoded blob
 * (capped at 4096 chars by `slice()`); a missing or unparseable label
 * yields an empty object — the metadata field is optional and a broken
 * round trip should not break the retry chain.
 */
function parseTriggerMetadata(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') result[k] = v;
    }
    return result;
  } catch {
    return {};
  }
}
