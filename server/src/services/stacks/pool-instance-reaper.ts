import type { PrismaClient } from '../../generated/prisma/client';
import { DockerExecutorService } from '../docker-executor';
import { getLogger } from '../../lib/logger-factory';
import { withOperation } from '../../lib/logging-context';
import { POOL_ADDON_LABELS, type JobPoolConfig } from '@mini-infra/types';
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
    await this.reapKillAfterSeconds(executor);
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
        await this.reapAddonSidecars(executor, row.stackId, row.instanceId);
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

  /**
   * Enforce `JobPoolConfig.killAfterSeconds` on JobPool runs whose
   * containers have been alive longer than their declared cap. Marks the
   * row's errorMessage so the exit watcher (which gets the subsequent
   * `die` event) keeps the kill attribution — finalising the row to
   * `failed`. We don't transition status here ourselves so the watcher
   * stays the single writer of `completed`/`failed`.
   *
   * Behaviour intentionally narrow: only `running` JobPool rows are
   * candidates. `starting` rows are handled by `reapStuckStarting`; Pool
   * rows have no `killAfterSeconds` semantics (they idle-sweep instead).
   */
  private async reapKillAfterSeconds(executor: DockerExecutorService): Promise<void> {
    const running = await this.prisma.poolInstance.findMany({
      where: { status: 'running' },
    });
    if (running.length === 0) return;

    // Batch-load owning services so we don't issue one findFirst per row.
    // SQLite handles small `where in` payloads cheaply; for the few-tens
    // expected scale this is one query per tick.
    const services = await this.prisma.stackService.findMany({
      where: {
        OR: running.map((r) => ({ stackId: r.stackId, serviceName: r.serviceName })),
      },
    });
    const serviceByKey = new Map<string, (typeof services)[number]>();
    for (const s of services) {
      serviceByKey.set(`${s.stackId}|${s.serviceName}`, s);
    }

    const now = Date.now();
    for (const row of running) {
      const svc = serviceByKey.get(`${row.stackId}|${row.serviceName}`);
      if (!svc || svc.serviceType !== 'JobPool') continue;
      const cfg = svc.jobPoolConfig as unknown as JobPoolConfig | null;
      if (!cfg?.killAfterSeconds) continue;

      // Use `lastActive` as the run's start time — the JobPool spawner
      // sets it to spawn-time and never updates it on a JobPool row.
      const runtimeMs = now - row.lastActive.getTime();
      const limitMs = cfg.killAfterSeconds * 1000;
      if (runtimeMs < limitMs) continue;

      try {
        // Mark the row first so the upcoming `die` event from the kill is
        // attributed correctly when the exit watcher reads `errorMessage`.
        await this.prisma.poolInstance.update({
          where: { id: row.id },
          data: { errorMessage: 'killed: exceeded killAfterSeconds' },
        });
        await this.stopAndRemoveContainer(executor, row.containerId);
        log.warn(
          {
            stackId: row.stackId,
            serviceName: row.serviceName,
            instanceId: row.instanceId,
            killAfterSeconds: cfg.killAfterSeconds,
            runtimeMs,
          },
          'JobPool run exceeded killAfterSeconds — container killed',
        );
        // Don't emit Socket.IO here — the exit watcher's `failed` event
        // picks up the kill attribution from `errorMessage` and is the
        // single source of truth for run-finalisation fan-out.
      } catch (err) {
        log.warn(
          {
            stackId: row.stackId,
            serviceName: row.serviceName,
            instanceId: row.instanceId,
            err: err instanceof Error ? err.message : String(err),
          },
          'Kill-after-seconds reap failed for instance; will retry next tick',
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
        await this.reapAddonSidecars(executor, row.stackId, row.instanceId);
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
   * Find and remove per-instance addon sidecar containers belonging to a
   * just-reaped pool instance. Discovery is by label match — the spawner
   * stamps `mini-infra.stack-id` + `mini-infra.pool-instance-id` +
   * `mini-infra.synthetic=true` on every sidecar, so a Docker `list` with
   * those filters is the canonical lookup.
   *
   * Best-effort: an unreachable sidecar logs and moves on; the next reap
   * tick or `docker container prune` will pick it up. We never block the
   * worker cleanup on a sidecar failure.
   */
  private async reapAddonSidecars(
    executor: DockerExecutorService,
    stackId: string,
    instanceId: string,
  ): Promise<void> {
    try {
      const docker = executor.getDockerClient();
      const containers = await docker.listContainers({
        all: true,
        filters: {
          label: [
            `${POOL_ADDON_LABELS.STACK_ID}=${stackId}`,
            `${POOL_ADDON_LABELS.POOL_INSTANCE_ID}=${instanceId}`,
            `${POOL_ADDON_LABELS.SYNTHETIC}=true`,
          ],
        },
      });
      for (const c of containers) {
        try {
          await this.stopAndRemoveContainer(executor, c.Id);
          log.info(
            { stackId, instanceId, sidecarContainerId: c.Id },
            'Reaped per-instance addon sidecar',
          );
        } catch (err) {
          log.warn(
            {
              stackId,
              instanceId,
              sidecarContainerId: c.Id,
              err: err instanceof Error ? err.message : String(err),
            },
            'Failed to reap sidecar container; will retry next tick',
          );
        }
      }
    } catch (err) {
      log.warn(
        {
          stackId,
          instanceId,
          err: err instanceof Error ? err.message : String(err),
        },
        'Failed to enumerate per-instance addon sidecars; skipping addon reap',
      );
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
