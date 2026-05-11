import * as cron from 'node-cron';
import type { PrismaClient } from '../../generated/prisma/client';
import type { JobPoolConfig } from '@mini-infra/types';
import type { DockerExecutorService } from '../docker-executor';
import { getLogger } from '../../lib/logger-factory';
import { withOperation } from '../../lib/logging-context';
import { runJobPool } from './job-pool-spawner';

const log = getLogger('stacks', 'job-pool-cron-registry');

/**
 * Registry key: one entry per (stackId, serviceName, triggerName). Trigger
 * names are unique within a pool (the JobPool schema enforces this), so the
 * three-tuple uniquely identifies a single cron schedule across all stacks.
 */
function registryKey(stackId: string, serviceName: string, triggerName: string): string {
  return `${stackId}::${serviceName}::${triggerName}`;
}

interface CronRegistryEntry {
  stackId: string;
  serviceName: string;
  triggerName: string;
  schedule: string;
  timezone: string | undefined;
  task: cron.ScheduledTask;
}

/**
 * Singleton registry that owns every active cron trigger across every applied
 * JobPool service. Drives `node-cron` registration from the persisted
 * `StackService.jobPoolConfig` rows; `refresh(stackId)` is called by the
 * stack apply handler to diff declared schedules against current
 * registrations and add / remove / restart as needed.
 *
 * Ordering invariant (plan §7): within a single `refresh()` cycle, all
 * removals run before all adds. A renamed or rescheduled trigger therefore
 * has a brief window where neither the old nor the new schedule is alive
 * — but never a window where both are. Misfires during the rename window
 * are acceptable for v1 (a per-stack apply mutex would close the seam if
 * it shows up in practice).
 *
 * The registry has no state outside the live `cron.ScheduledTask` handles
 * and the lookup map — `loadAll()` rebuilds the entire view from
 * `StackService` rows on server boot, so a process restart re-establishes
 * exactly the same set of schedules without manual intervention.
 */
export class JobPoolCronRegistry {
  private static instance: JobPoolCronRegistry | null = null;

  private readonly entries = new Map<string, CronRegistryEntry>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly resolveDockerExecutor: () => Promise<DockerExecutorService>,
  ) {}

  static setInstance(instance: JobPoolCronRegistry | null): void {
    JobPoolCronRegistry.instance = instance;
  }

  static getInstance(): JobPoolCronRegistry | null {
    return JobPoolCronRegistry.instance;
  }

  /** Number of live cron tasks across every JobPool. Test/observability hook. */
  size(): number {
    return this.entries.size;
  }

  /** Snapshot of the registered keys (test/observability hook). */
  registeredKeys(): string[] {
    return [...this.entries.keys()].sort();
  }

  /**
   * Load every JobPool's cron triggers from the DB and register them. Idempotent
   * — call from `server.ts` on boot. A no-op if any rows already match an
   * existing entry; new entries are scheduled in place.
   */
  async loadAll(): Promise<void> {
    const services = await this.prisma.stackService.findMany({
      where: { serviceType: 'JobPool' },
      select: { stackId: true },
      distinct: ['stackId'],
    });
    log.info({ stackCount: services.length }, 'JobPoolCronRegistry: loading cron triggers from DB');
    for (const { stackId } of services) {
      try {
        await this.refresh(stackId);
      } catch (err) {
        log.error(
          { stackId, err: err instanceof Error ? err.message : String(err) },
          'JobPoolCronRegistry: failed to load cron triggers for stack (continuing)',
        );
      }
    }
    log.info({ total: this.entries.size }, 'JobPoolCronRegistry: loaded');
  }

  /**
   * Re-reconcile the cron triggers for a single stack against the current DB
   * state. Removals run before adds (the ordering invariant above).
   *
   * Called by the stack apply handler after the stack's services have been
   * written. Tolerant of missing stacks — if the stack was deleted, every
   * registered entry for it is unregistered.
   */
  async refresh(stackId: string): Promise<void> {
    const services = await this.prisma.stackService.findMany({
      where: { stackId, serviceType: 'JobPool' },
    });

    // Build the desired set: every cron trigger declared on every JobPool
    // service for this stack.
    interface Desired {
      key: string;
      stackId: string;
      serviceName: string;
      triggerName: string;
      schedule: string;
      timezone: string | undefined;
    }
    const desired: Desired[] = [];
    for (const svc of services) {
      const cfg = svc.jobPoolConfig as unknown as JobPoolConfig | null;
      if (!cfg) continue;
      for (const trigger of cfg.triggers ?? []) {
        if (trigger.kind !== 'cron') continue;
        desired.push({
          key: registryKey(stackId, svc.serviceName, trigger.name),
          stackId,
          serviceName: svc.serviceName,
          triggerName: trigger.name,
          schedule: trigger.schedule,
          timezone: trigger.timezone,
        });
      }
    }
    const desiredByKey = new Map(desired.map((d) => [d.key, d]));

    // Phase 1: removals — anything currently registered for this stack that
    // isn't in the desired set, or whose schedule/timezone has changed
    // (changed entries get torn down and re-added so node-cron picks up
    // the new parameters cleanly).
    const stackPrefix = `${stackId}::`;
    const removalKeys: string[] = [];
    for (const [key, entry] of this.entries) {
      if (!key.startsWith(stackPrefix)) continue;
      const want = desiredByKey.get(key);
      if (!want) {
        removalKeys.push(key);
        continue;
      }
      if (want.schedule !== entry.schedule || (want.timezone ?? null) !== (entry.timezone ?? null)) {
        removalKeys.push(key);
      }
    }
    for (const key of removalKeys) {
      this.unregister(key);
    }

    // Phase 2: adds — anything in the desired set that isn't currently
    // registered (either because it was just declared or because the
    // removal phase tore down a stale variant).
    for (const want of desired) {
      if (this.entries.has(want.key)) continue;
      if (!cron.validate(want.schedule)) {
        log.warn(
          { stackId, serviceName: want.serviceName, triggerName: want.triggerName, schedule: want.schedule },
          'JobPoolCronRegistry: skipping unparseable cron schedule',
        );
        continue;
      }
      this.register(want);
    }

    log.info(
      {
        stackId,
        desired: desired.length,
        registered: this.entries.size,
        added: desired.filter((d) => !removalKeys.includes(d.key)).length - 0,
        removed: removalKeys.length,
      },
      'JobPoolCronRegistry.refresh completed',
    );
  }

  /**
   * Remove every cron trigger associated with `stackId`. Useful for explicit
   * stack-destroy paths that bypass the apply handler.
   */
  removeStack(stackId: string): void {
    const stackPrefix = `${stackId}::`;
    const keys: string[] = [];
    for (const key of this.entries.keys()) {
      if (key.startsWith(stackPrefix)) keys.push(key);
    }
    for (const key of keys) {
      this.unregister(key);
    }
    if (keys.length > 0) {
      log.info({ stackId, removed: keys.length }, 'JobPoolCronRegistry: removed all triggers for stack');
    }
  }

  /** Stop every scheduled task. Call on server shutdown. */
  stopAll(): void {
    for (const entry of this.entries.values()) {
      try {
        entry.task.stop();
      } catch {
        // best-effort
      }
    }
    this.entries.clear();
    log.info('JobPoolCronRegistry: stopped all tasks');
  }

  // ----- internals --------------------------------------------------------

  private register(want: {
    key: string;
    stackId: string;
    serviceName: string;
    triggerName: string;
    schedule: string;
    timezone: string | undefined;
  }): void {
    const fireHandler = async (): Promise<void> => {
      await withOperation(`job-pool-cron-tick-${want.stackId}-${want.serviceName}`, () =>
        this.fireOnce(want.stackId, want.serviceName, want.triggerName),
      );
    };

    let task: cron.ScheduledTask;
    try {
      task = cron.schedule(
        want.schedule,
        fireHandler,
        want.timezone ? { timezone: want.timezone } : undefined,
      );
    } catch (err) {
      log.error(
        {
          stackId: want.stackId,
          serviceName: want.serviceName,
          triggerName: want.triggerName,
          schedule: want.schedule,
          timezone: want.timezone,
          err: err instanceof Error ? err.message : String(err),
        },
        'JobPoolCronRegistry: cron.schedule threw — skipping trigger',
      );
      return;
    }

    this.entries.set(want.key, {
      stackId: want.stackId,
      serviceName: want.serviceName,
      triggerName: want.triggerName,
      schedule: want.schedule,
      timezone: want.timezone,
      task,
    });
    log.info(
      {
        stackId: want.stackId,
        serviceName: want.serviceName,
        triggerName: want.triggerName,
        schedule: want.schedule,
        timezone: want.timezone,
      },
      'JobPoolCronRegistry: registered cron trigger',
    );
  }

  private unregister(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    try {
      entry.task.stop();
    } catch (err) {
      log.warn(
        { key, err: err instanceof Error ? err.message : String(err) },
        'JobPoolCronRegistry: task.stop threw (continuing)',
      );
    }
    this.entries.delete(key);
    log.info(
      {
        stackId: entry.stackId,
        serviceName: entry.serviceName,
        triggerName: entry.triggerName,
      },
      'JobPoolCronRegistry: unregistered cron trigger',
    );
  }

  private async fireOnce(stackId: string, serviceName: string, triggerName: string): Promise<void> {
    try {
      const dockerExecutor = await this.resolveDockerExecutor();
      const result = await runJobPool(this.prisma, dockerExecutor, {
        stackId,
        serviceName,
        trigger: { kind: 'cron', name: triggerName },
      });
      if (!result.ok) {
        // Cap-hit / spawn-fail / stack-not-found etc. — `runJobPool` already
        // logged + (on cap) published a `run-skipped` event. Cron isn't an
        // interactive surface so there's nothing else to do; log at info
        // for cap-hit and warn for spawn failures.
        if (result.reason === 'concurrency_cap') {
          log.info(
            { stackId, serviceName, triggerName, maxConcurrent: result.maxConcurrent },
            'JobPoolCronRegistry: cron tick skipped — concurrency cap',
          );
        } else {
          log.warn(
            { stackId, serviceName, triggerName, reason: result.reason },
            'JobPoolCronRegistry: cron tick failed',
          );
        }
      } else {
        log.info(
          { stackId, serviceName, triggerName, runId: result.runId },
          'JobPoolCronRegistry: cron tick spawned run',
        );
      }
    } catch (err) {
      // Never let a thrown error tear down the scheduled task — node-cron
      // would log the unhandled rejection but the task would keep firing
      // anyway. Logging here means the operator gets one structured line
      // per failure.
      log.error(
        { stackId, serviceName, triggerName, err: err instanceof Error ? err.message : String(err) },
        'JobPoolCronRegistry: cron tick threw',
      );
    }
  }
}
