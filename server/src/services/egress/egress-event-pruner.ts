/**
 * EgressEventPruner
 *
 * Daily cron job that deletes EgressEvent rows older than the configured
 * retention window. Matches the node-cron scheduling pattern used by
 * UserEventCleanupScheduler (see server/src/services/user-events/).
 *
 * Configuration:
 *   EGRESS_EVENT_RETENTION_DAYS  — override retention window (default 30).
 *
 * Schedule: daily at 3 AM UTC (offset from user-event cleanup at 2 AM).
 */

import * as cron from 'node-cron';
import type { PrismaClient } from '../../generated/prisma/client';
import { getLogger } from '../../lib/logger-factory';
import { withOperation } from '../../lib/logging-context';

const log = getLogger('stacks', 'egress-event-pruner');

const DEFAULT_SCHEDULE = '0 3 * * *'; // 3 AM UTC daily
const DEFAULT_RETENTION_DAYS = 30;

export class EgressEventPruner {
  private task: cron.ScheduledTask | null = null;

  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Start the daily prune schedule.
   */
  start(schedule: string = DEFAULT_SCHEDULE): void {
    if (this.task) {
      log.warn('EgressEventPruner already running — ignoring start()');
      return;
    }

    const resolved = cron.validate(schedule) ? schedule : DEFAULT_SCHEDULE;

    this.task = cron.schedule(
      resolved,
      async () => {
        await withOperation('egress-event-prune-tick', () => this._prune());
      },
      { timezone: 'UTC' },
    );

    log.info({ schedule: resolved }, 'EgressEventPruner scheduled');
  }

  /**
   * Stop the scheduled task.
   */
  stop(): void {
    if (this.task) {
      this.task.stop();
      this.task.destroy();
      this.task = null;
    }
    log.info('EgressEventPruner stopped');
  }

  /**
   * Manually run a prune cycle (useful for testing or one-off cleanup).
   */
  async runNow(): Promise<number> {
    return this._prune();
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private async _prune(): Promise<number> {
    const retentionDays = this._retentionDays();
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

    log.info({ retentionDays, cutoff: cutoff.toISOString() }, 'Starting EgressEvent prune');

    try {
      const result = await this.prisma.egressEvent.deleteMany({
        where: { occurredAt: { lt: cutoff } },
      });

      log.info(
        { deletedCount: result.count, retentionDays },
        'EgressEvent prune completed',
      );

      return result.count;
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err), retentionDays },
        'EgressEvent prune failed',
      );
      return 0;
    }
  }

  private _retentionDays(): number {
    const envVal = process.env.EGRESS_EVENT_RETENTION_DAYS;
    if (envVal) {
      const n = parseInt(envVal, 10);
      if (!isNaN(n) && n > 0) return n;
    }
    return DEFAULT_RETENTION_DAYS;
  }
}
