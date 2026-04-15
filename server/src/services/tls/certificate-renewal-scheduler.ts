/**
 * Certificate Renewal Scheduler
 *
 * This service manages automated certificate renewal scheduling using cron.
 * It runs periodic checks to identify certificates that need renewal and triggers
 * the renewal process through the CertificateLifecycleManager.
 */

import * as cron from "node-cron";
import { Logger } from "pino";
import { PrismaClient, Prisma } from "../../generated/prisma/client";
import { getLogger } from "../../lib/logger-factory";
import { CertificateLifecycleManager } from "./certificate-lifecycle-manager";

interface RenewalCheckResult {
  total: number;
  renewed: number;
  failed: number;
  errors: Array<{
    certificateId: string;
    domains: string[];
    error: string;
  }>;
}

/**
 * Service for scheduling automated certificate renewals
 */
export class CertificateRenewalScheduler {
  private lifecycleManager: CertificateLifecycleManager;
  private prisma: PrismaClient;
  private logger: Logger;
  private cronJob: cron.ScheduledTask | null = null;
  private isRunning: boolean = false;

  constructor(lifecycleManager: CertificateLifecycleManager, prisma: PrismaClient) {
    this.lifecycleManager = lifecycleManager;
    this.prisma = prisma;
    this.logger = getLogger("tls", "certificate-renewal-scheduler");
  }

  /**
   * Start scheduled renewal checks
   *
   * @param cronExpression - Cron expression for scheduling (default: "0 2 * * *" - daily at 2 AM)
   */
  async start(cronExpression?: string): Promise<void> {
    // Get cron expression from settings (default: daily at 2 AM)
    const schedule = cronExpression || "0 2 * * *";

    if (!cron.validate(schedule)) {
      throw new Error(`Invalid cron expression: ${schedule}`);
    }

    if (this.cronJob) {
      this.logger.warn("TLS renewal scheduler already running, stopping existing job");
      this.stop();
    }

    this.logger.info({ schedule }, "Starting TLS renewal scheduler");

    this.cronJob = cron.schedule(schedule, async () => {
      this.logger.info("Running scheduled certificate renewal check");

      try {
        const result = await this.checkRenewals();

        this.logger.info(
          {
            total: result.total,
            renewed: result.renewed,
            failed: result.failed,
          },
          "Certificate renewal check completed"
        );

        // Log errors if any
        if (result.errors.length > 0) {
          this.logger.error(
            { errors: result.errors },
            `Certificate renewal check completed with ${result.failed} failures`
          );
        }
      } catch (error) {
        this.logger.error({ error }, "Certificate renewal check failed");
      }
    });

    this.isRunning = true;
    this.logger.info({ schedule }, "TLS renewal scheduler started");
  }

  /**
   * Stop scheduler
   */
  stop(): void {
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
      this.isRunning = false;
      this.logger.info("TLS renewal scheduler stopped");
    }
  }

  /**
   * Check if scheduler is running
   */
  isSchedulerRunning(): boolean {
    return this.isRunning;
  }

  /**
   * Run renewal check immediately (manual trigger)
   *
   * @returns Results of the renewal check
   */
  async checkRenewals(): Promise<RenewalCheckResult> {
    const now = new Date();

    // Find certificates needing renewal
    const certificates = await this.prisma.tlsCertificate.findMany({
      where: {
        autoRenew: true,
        status: "ACTIVE",
        renewAfter: {
          lte: now, // renewAfter date has passed
        },
      },
    });

    this.logger.info({ count: certificates.length }, "Found certificates needing renewal");

    const results: RenewalCheckResult = {
      total: certificates.length,
      renewed: 0,
      failed: 0,
      errors: [],
    };

    for (const cert of certificates) {
      try {
        await this.processCertificateRenewal(cert);
        results.renewed++;
      } catch (error) {
        results.failed++;
        results.errors.push({
          certificateId: cert.id,
          domains: JSON.parse(cert.domains),
          error: error instanceof Error ? error.message : String(error),
        });

        this.logger.error(
          {
            certificateId: cert.id,
            domains: cert.domains,
            error,
          },
          "Certificate renewal failed"
        );
      }
    }

    return results;
  }

  /**
   * Process single certificate renewal
   *
   * @param certificate - Certificate to renew
   */
  private async processCertificateRenewal(certificate: Prisma.TlsCertificateGetPayload<true>): Promise<void> {
    this.logger.info(
      {
        certificateId: certificate.id,
        domains: certificate.domains,
        notAfter: certificate.notAfter,
      },
      "Processing certificate renewal"
    );

    // Use lifecycle manager to renew
    await this.lifecycleManager.renewCertificate(certificate.id);

    this.logger.info({ certificateId: certificate.id }, "Certificate renewed successfully");
  }

  /**
   * Get certificates that will need renewal soon
   *
   * @param daysThreshold - Number of days ahead to check (default: 30)
   * @returns List of certificates that will need renewal
   */
  async getCertificatesNeedingRenewalSoon(daysThreshold: number = 30): Promise<Record<string, unknown>[]> {
    const thresholdDate = new Date();
    thresholdDate.setDate(thresholdDate.getDate() + daysThreshold);

    const certificates = await this.prisma.tlsCertificate.findMany({
      where: {
        autoRenew: true,
        status: "ACTIVE",
        renewAfter: {
          lte: thresholdDate,
        },
      },
      orderBy: {
        renewAfter: "asc",
      },
    });

    return certificates;
  }
}
