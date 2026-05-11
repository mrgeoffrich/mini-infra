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
    const exitCode = event.exitCode ?? 0;

    // Carry trigger attribution forward. JobPool runs spawned via
    // `runJobPool` stamp `JOB_TRIGGER_KIND` / `JOB_TRIGGER_NAME` on the
    // container, but Docker's `die` event only carries labels, not env
    // vars. We pulled the labels through `pool-spawner.ts:labels` so the
    // attribution survives — but the spawner doesn't currently expose
    // trigger labels, so until Phase 3 stamps them we default to `manual`
    // / 'unknown'. The history payload still parses cleanly.
    const triggerKind = (event.labels['mini-infra.job-pool-trigger-kind'] as
      | 'cron'
      | 'nats-request'
      | 'manual') ?? 'manual';
    const triggerName = event.labels['mini-infra.job-pool-trigger-name'] ?? 'unknown';

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
          errorMessage: succeeded ? null : row.errorMessage ?? `Container exited with code ${exitCode}`,
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

    const errorMessage = row.errorMessage ?? `Container exited with code ${exitCode}`;
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
      { stackId, serviceName: row.serviceName, runId: instanceId, exitCode, errorMessage },
      'JobPool run failed',
    );

    // Retry handling — non-zero exits only. Killed-by-reaper runs already
    // have a row.errorMessage of KILL_AFTER_SECONDS_ERROR; we still honor
    // the retry policy for them (the plan doc doesn't carve out an
    // exception). Retries are not chained across themselves: the
    // scheduler caps at `onFailure.retries`.
    if (jobPoolConfig?.onFailure && jobPoolConfig.onFailure.retries > 0) {
      try {
        const docker = await this.lazyDockerExecutor();
        scheduleJobPoolRetry(this.prisma, docker, {
          stackId,
          serviceName: row.serviceName,
          attemptedRetries: 0,
          onFailure: jobPoolConfig.onFailure,
          trigger: { kind: triggerKind, name: triggerName },
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
