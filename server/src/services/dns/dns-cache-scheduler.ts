import * as cron from "node-cron";
import { getLogger } from "../../lib/logger-factory";
import { DnsCacheService } from "./dns-cache-service";

const logger = getLogger("platform", "dns-cache-scheduler");

export class DnsCacheScheduler {
  private dnsCacheService: DnsCacheService;
  private cronJob: cron.ScheduledTask | null = null;

  constructor(dnsCacheService: DnsCacheService) {
    this.dnsCacheService = dnsCacheService;
  }

  /**
   * Start the DNS cache refresh scheduler
   * @param cronExpression - defaults to every 30 minutes
   */
  async start(cronExpression: string = "*/30 * * * *"): Promise<void> {
    if (!cron.validate(cronExpression)) {
      throw new Error(`Invalid cron expression: ${cronExpression}`);
    }

    if (this.cronJob) {
      logger.warn("DNS cache scheduler already running, stopping existing job");
      this.stop();
    }

    logger.info({ schedule: cronExpression }, "Starting DNS cache scheduler");

    this.cronJob = cron.schedule(cronExpression, async () => {
      logger.info("Running scheduled DNS cache refresh");
      try {
        const result = await this.dnsCacheService.refreshCache();
        logger.info(
          { zonesUpdated: result.zonesUpdated, recordsUpdated: result.recordsUpdated },
          "Scheduled DNS cache refresh completed"
        );
      } catch (error) {
        logger.error({ error }, "Scheduled DNS cache refresh failed");
      }
    });

    // Do an initial refresh
    try {
      await this.dnsCacheService.refreshCache();
    } catch (error) {
      logger.warn({ error }, "Initial DNS cache refresh failed (non-fatal)");
    }
  }

  stop(): void {
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
      logger.info("DNS cache scheduler stopped");
    }
  }
}
