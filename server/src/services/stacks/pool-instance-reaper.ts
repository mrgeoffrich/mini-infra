import type { PrismaClient } from '../../generated/prisma/client';
import { DockerExecutorService } from '../docker-executor';
import { getLogger } from '../../lib/logger-factory';
import { withOperation } from '../../lib/logging-context';
import {
  emitPoolInstanceIdleStopped,
  emitPoolInstanceFailed,
} from './pool-socket-emitter';

const log = getLogger('stacks', 'pool-instance-reaper');

/** How long a spawn is allowed to remain in `starting` before being forced to error. */
const STARTING_TIMEOUT_MS = 5 * 60 * 1000;

/** Graceful stop timeout (seconds) sent to Docker. */
const STOP_TIMEOUT_SECONDS = 10;

export interface PoolInstanceReaperOptions {
  /** Interval between ticks, milliseconds. Default 60s. */
  intervalMs?: number;
}

/**
 * Periodic reaper for stale pool instances:
 *   1. `running` rows whose `lastActive` is older than their `idleTimeoutMinutes`
 *      are stopped + removed from Docker, then transitioned to `stopped`.
 *   2. `starting` rows older than 5 minutes are assumed crashed and
 *      transitioned to `error`.
 *
 * Failures on individual instances are caught so one bad row doesn't abort
 * the tick. Docker connectivity errors skip the whole tick — we'd rather
 * miss a reap than falsely mark rows as stopped.
 */
export class PoolInstanceReaper {
  private intervalId: NodeJS.Timeout | null = null;
  private readonly intervalMs: number;
  private running = false;

  constructor(
    private readonly prisma: PrismaClient,
    options: PoolInstanceReaperOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? 60_000;
  }

  start(): void {
    if (this.running) {
      log.warn('PoolInstanceReaper already running');
      return;
    }
    this.running = true;
    log.info({ intervalMs: this.intervalMs }, 'Starting PoolInstanceReaper');
    // Fire once immediately so operators get a quick first sweep on boot,
    // then settle into the fixed cadence. tick() is self-contained — errors
    // are caught so the loop can never wedge.
    void withOperation('pool-reaper-tick', () => this.tick());
    this.intervalId = setInterval(() => {
      void withOperation('pool-reaper-tick', () => this.tick());
    }, this.intervalMs);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.running = false;
    log.info('PoolInstanceReaper stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * Single reap pass. Exposed for tests. Swallows Docker connectivity
   * failures — logs and returns without touching DB state.
   */
  async tick(): Promise<void> {
    let executor: DockerExecutorService;
    try {
      executor = new DockerExecutorService();
      await executor.initialize();
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Docker unreachable — skipping pool reap tick',
      );
      return;
    }

    await this.reapIdle(executor);
    await this.reapStuckStarting(executor);
  }

  private async reapIdle(executor: DockerExecutorService): Promise<void> {
    // SQLite doesn't support per-row interval arithmetic in the WHERE clause
    // as ergonomically as Postgres does, so we fetch running rows and filter
    // in JS. The pool-instances table is expected to be small (tens to low
    // hundreds of rows); a full scan every 60s is fine.
    const running = await this.prisma.poolInstance.findMany({
      where: { status: 'running' },
    });
    const now = Date.now();

    for (const row of running) {
      const idleForMs = now - row.lastActive.getTime();
      const limitMs = row.idleTimeoutMinutes * 60 * 1000;
      if (idleForMs < limitMs) continue;

      const idleMinutes = Math.round(idleForMs / 60_000);
      try {
        await this.stopAndRemoveContainer(executor, row.containerId);
        await this.prisma.poolInstance.update({
          where: { id: row.id },
          data: { status: 'stopped', stoppedAt: new Date() },
        });
        log.info(
          {
            stackId: row.stackId,
            serviceName: row.serviceName,
            instanceId: row.instanceId,
            idleMinutes,
          },
          'Reaped idle pool instance',
        );
        emitPoolInstanceIdleStopped({
          stackId: row.stackId,
          serviceName: row.serviceName,
          instanceId: row.instanceId,
          idleMinutes,
        });
      } catch (err) {
        log.warn(
          {
            stackId: row.stackId,
            serviceName: row.serviceName,
            instanceId: row.instanceId,
            err: err instanceof Error ? err.message : String(err),
          },
          'Idle reap failed for instance; will retry next tick',
        );
      }
    }
  }

  private async reapStuckStarting(executor: DockerExecutorService): Promise<void> {
    const deadline = new Date(Date.now() - STARTING_TIMEOUT_MS);
    const stuck = await this.prisma.poolInstance.findMany({
      where: {
        status: 'starting',
        createdAt: { lt: deadline },
      },
    });

    for (const row of stuck) {
      try {
        await this.stopAndRemoveContainer(executor, row.containerId);
        await this.prisma.poolInstance.update({
          where: { id: row.id },
          data: {
            status: 'error',
            errorMessage: 'Spawn timed out after 5 minutes',
            stoppedAt: new Date(),
          },
        });
        log.warn(
          {
            stackId: row.stackId,
            serviceName: row.serviceName,
            instanceId: row.instanceId,
          },
          'Reaped stuck-starting pool instance',
        );
        emitPoolInstanceFailed({
          stackId: row.stackId,
          serviceName: row.serviceName,
          instanceId: row.instanceId,
          error: 'Spawn timed out after 5 minutes',
        });
      } catch (err) {
        log.warn(
          {
            stackId: row.stackId,
            serviceName: row.serviceName,
            instanceId: row.instanceId,
            err: err instanceof Error ? err.message : String(err),
          },
          'Stuck-starting reap failed for instance; will retry next tick',
        );
      }
    }
  }

  /**
   * Stop and remove a pool instance container. Missing containers are
   * treated as already-gone: the DB row transitions anyway.
   */
  private async stopAndRemoveContainer(
    executor: DockerExecutorService,
    containerId: string | null,
  ): Promise<void> {
    if (!containerId) return;
    const docker = executor.getDockerClient();
    const container = docker.getContainer(containerId);
    try {
      await container.stop({ t: STOP_TIMEOUT_SECONDS });
    } catch (err) {
      const code = (err as { statusCode?: number })?.statusCode;
      if (code !== 404 && code !== 304) throw err;
    }
    try {
      await container.remove({ force: true });
    } catch (err) {
      const code = (err as { statusCode?: number })?.statusCode;
      if (code !== 404) throw err;
    }
  }
}
