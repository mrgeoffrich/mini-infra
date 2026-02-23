/**
 * Certificate Lifecycle Manager
 *
 * This service orchestrates certificate issuance and renewal workflows.
 * It coordinates between ACME client, Azure Storage, DNS challenge provider, and the database.
 */

import { Logger } from "pino";
import { PrismaClient } from "@prisma/client";
import { tlsLogger } from "../../lib/logger-factory";
import { AcmeClientManager } from "./acme-client-manager";
import { AzureStorageCertificateStore } from "./azure-storage-certificate-store";
import { DnsChallenge01Provider } from "./dns-challenge-provider";
import { CertificateDistributor } from "./certificate-distributor";
import { parseCertificate } from "./certificate-format-helper";
import { CertificateRequest } from "./types";

/**
 * Service for managing certificate lifecycle
 */
export class CertificateLifecycleManager {
  private acmeClient: AcmeClientManager;
  private certificateStore: AzureStorageCertificateStore;
  private dnsChallenge: DnsChallenge01Provider;
  private distributor?: CertificateDistributor;
  private prisma: PrismaClient;
  private logger: Logger;
  private containerName: string;

  constructor(
    acmeClient: AcmeClientManager,
    certificateStore: AzureStorageCertificateStore,
    dnsChallenge: DnsChallenge01Provider,
    prisma: PrismaClient,
    containerName: string,
    distributor?: CertificateDistributor
  ) {
    this.acmeClient = acmeClient;
    this.certificateStore = certificateStore;
    this.dnsChallenge = dnsChallenge;
    this.distributor = distributor;
    this.prisma = prisma;
    this.containerName = containerName;
    this.logger = tlsLogger();
  }

  /**
   * Issue new certificate
   *
   * @param request - Certificate request parameters
   * @returns Created certificate record
   */
  async issueCertificate(request: CertificateRequest): Promise<any> {
    const { domains, primaryDomain, userId } = request;

    this.logger.info({ domains, primaryDomain, userId }, "Starting certificate issuance");

    try {
      // Step 1: Request certificate from Let's Encrypt
      this.logger.info("Requesting certificate from ACME provider");

      const { certificate, privateKey, chain } = await this.acmeClient.requestCertificate(
        domains,
        this.dnsChallenge
      );

      // Step 2: Parse certificate metadata
      const certInfo = await parseCertificate(certificate);

      // Step 3: Create database record first to get certificate ID
      const renewAfter = new Date(certInfo.notAfter);
      renewAfter.setDate(renewAfter.getDate() - 30); // Renew 30 days before expiry

      const tlsCertificate = await this.prisma.tlsCertificate.create({
        data: {
          domains: JSON.stringify(domains),
          primaryDomain: primaryDomain,
          certificateType: "ACME",
          acmeProvider: "letsencrypt",
          blobContainerName: this.containerName,
          blobName: null, // Will be set after storage
          issuer: certInfo.issuer,
          serialNumber: certInfo.serialNumber || undefined,
          fingerprint: certInfo.fingerprint,
          issuedAt: new Date(),
          notBefore: certInfo.notBefore,
          notAfter: certInfo.notAfter,
          renewAfter,
          status: "PENDING",
          autoRenew: true,
          renewalDaysBeforeExpiry: 30,
          haproxyFrontendNames: JSON.stringify([]),
          createdBy: userId,
        },
      });

      // Step 4: Store in Azure Blob Storage using certificate ID
      this.logger.info("Storing certificate in Azure Storage");
      const blobName = `cert_${tlsCertificate.id}.pem`;

      const { version, secretId } = await this.certificateStore.storeCertificate(
        blobName,
        certificate,
        privateKey,
        {
          domains,
          issuer: certInfo.issuer,
          notBefore: certInfo.notBefore,
          notAfter: certInfo.notAfter,
          fingerprint: certInfo.fingerprint,
        }
      );

      // Step 5: Update certificate record with blob name and mark as ACTIVE
      await this.prisma.tlsCertificate.update({
        where: { id: tlsCertificate.id },
        data: {
          blobName,
          status: "ACTIVE",
        },
      });

      // Step 6: Deploy to HAProxy (if requested and distributor is available)
      if (request.deployToHaproxy && this.distributor) {
        this.logger.info("Deploying certificate to HAProxy");
        try {
          const deployResult = await this.distributor.deployCertificate(
            blobName,
            request.haproxyContainerId
          );

          if (deployResult.success) {
            this.logger.info(
              { certificateId: tlsCertificate.id, method: deployResult.method },
              "Certificate deployed to HAProxy successfully"
            );
          } else {
            this.logger.warn(
              { certificateId: tlsCertificate.id, error: deployResult.error },
              "Certificate deployment to HAProxy failed (certificate issued but not deployed)"
            );
          }
        } catch (deployError) {
          this.logger.warn(
            { certificateId: tlsCertificate.id, error: deployError },
            "Certificate deployment to HAProxy failed (certificate issued but not deployed)"
          );
        }
      }

      this.logger.info(
        { certificateId: tlsCertificate.id, domains },
        "Certificate issuance completed successfully"
      );

      return tlsCertificate;
    } catch (error) {
      this.logger.error({ error, domains }, "Certificate issuance failed");
      throw error;
    }
  }

  /**
   * Renew existing certificate
   *
   * @param certificateId - Database certificate ID
   * @returns Updated certificate record
   */
  async renewCertificate(certificateId: string): Promise<any> {
    // Get existing certificate
    const existingCert = await this.prisma.tlsCertificate.findUnique({
      where: { id: certificateId },
      include: {
        renewalHistory: true,
        haproxyFrontends: { include: { environment: true } },
      },
    });

    if (!existingCert) {
      throw new Error(`Certificate not found: ${certificateId}`);
    }

    this.logger.info(
      { certificateId, domains: existingCert.domains },
      "Starting certificate renewal"
    );

    // Determine attempt number
    const attemptNumber =
      existingCert.renewalHistory.filter((r) => r.status === "FAILED").length + 1;

    // Create renewal record
    const renewal = await this.prisma.tlsCertificateRenewal.create({
      data: {
        certificateId,
        attemptNumber,
        status: "INITIATED",
        triggeredBy: "auto-renewal",
      },
    });

    // Update certificate status
    await this.prisma.tlsCertificate.update({
      where: { id: certificateId },
      data: { status: "RENEWING" },
    });

    try {
      // Follow same flow as issuance
      const { certificate, privateKey } = await this.acmeClient.renewCertificate(
        certificateId,
        this.dnsChallenge
      );

      // Parse new certificate
      const certInfo = await parseCertificate(certificate);

      // Store new version in Azure Blob Storage (overwrites existing blob)
      const domains = Array.isArray(existingCert.domains) ? existingCert.domains : JSON.parse(existingCert.domains as any);
      const blobName = existingCert.blobName || `cert_${certificateId}.pem`;

      const { version, secretId } = await this.certificateStore.storeCertificate(
        blobName,
        certificate,
        privateKey,
        {
          domains,
          issuer: certInfo.issuer,
          notBefore: certInfo.notBefore,
          notAfter: certInfo.notAfter,
          fingerprint: certInfo.fingerprint,
        }
      );

      // Calculate new renewAfter date
      const renewAfter = new Date(certInfo.notAfter);
      renewAfter.setDate(renewAfter.getDate() - existingCert.renewalDaysBeforeExpiry);

      // Update certificate record
      const updatedCert = await this.prisma.tlsCertificate.update({
        where: { id: certificateId },
        data: {
          blobName, // Ensure blob name is set
          notBefore: certInfo.notBefore,
          notAfter: certInfo.notAfter,
          renewAfter,
          lastRenewedAt: new Date(),
          status: "ACTIVE",
          lastError: null,
          lastErrorAt: null,
          updatedBy: "system",
        },
      });

      // Update renewal record with blob ETag
      await this.updateRenewalStatus(renewal.id, "STORED_IN_VAULT", {
        blobETag: version, // Store ETag as version
      });

      // Deploy to HAProxy environments that use this certificate
      if (this.distributor) {
        const environments = this.getUniqueEnvironments(existingCert.haproxyFrontends);

        if (environments.length === 0) {
          this.logger.warn(
            { certificateId },
            "No HAProxy frontends linked to this certificate - skipping HAProxy deployment"
          );
        }

        for (const env of environments) {
          try {
            this.logger.info(
              { certificateId, environmentName: env.name },
              "Deploying renewed certificate to HAProxy"
            );

            const deployResult = await this.distributor.deployCertificate(
              blobName,
              undefined,
              env.name
            );

            if (deployResult.success) {
              this.logger.info(
                { certificateId, environmentName: env.name, method: deployResult.method },
                "Renewed certificate deployed to HAProxy successfully"
              );
            } else {
              this.logger.warn(
                { certificateId, environmentName: env.name, error: deployResult.error },
                "Renewed certificate deployment to HAProxy failed"
              );
            }

            // Persist deploy result to renewal record
            await this.updateRenewalStatus(renewal.id, renewal.status, {
              haproxyReloadMethod: deployResult.method,
              haproxyReloadSuccess: deployResult.success,
            });
          } catch (deployError) {
            this.logger.warn(
              { certificateId, environmentName: env.name, error: deployError },
              "Renewed certificate deployment to HAProxy failed"
            );
          }
        }
      }

      // Mark renewal complete
      await this.updateRenewalStatus(renewal.id, "COMPLETED", {
        completedAt: new Date(),
        durationMs: Date.now() - renewal.startedAt.getTime(),
      });

      this.logger.info({ certificateId }, "Certificate renewal completed successfully");

      return updatedCert;
    } catch (error) {
      // Record failure
      await this.prisma.tlsCertificate.update({
        where: { id: certificateId },
        data: {
          status: "ERROR",
          lastError: error instanceof Error ? error.message : String(error),
          lastErrorAt: new Date(),
        },
      });

      await this.updateRenewalStatus(renewal.id, "FAILED", {
        errorMessage: error instanceof Error ? error.message : String(error),
        completedAt: new Date(),
      });

      this.logger.error({ certificateId, error }, "Certificate renewal failed");
      throw error;
    }
  }

  /**
   * Check if certificate needs renewal
   *
   * @param certificateId - Database certificate ID
   * @returns true if renewal is needed
   */
  async needsRenewal(certificateId: string): Promise<boolean> {
    const cert = await this.prisma.tlsCertificate.findUnique({
      where: { id: certificateId },
    });

    if (!cert || !cert.autoRenew) {
      return false;
    }

    const now = new Date();
    return now >= cert.renewAfter;
  }

  /**
   * Get certificates expiring soon
   *
   * @param daysThreshold - Number of days threshold (default: 30)
   * @returns Array of certificates needing renewal
   */
  async getCertificatesNeedingRenewal(daysThreshold: number = 30): Promise<any[]> {
    const now = new Date();
    const thresholdDate = new Date(now);
    thresholdDate.setDate(thresholdDate.getDate() + daysThreshold);

    return await this.prisma.tlsCertificate.findMany({
      where: {
        autoRenew: true,
        status: "ACTIVE",
        notAfter: {
          lte: thresholdDate,
        },
      },
    });
  }

  /**
   * Update renewal status
   *
   * @param renewalId - Renewal record ID
   * @param status - New status
   * @param additionalData - Additional data to update
   * @private
   */
  private async updateRenewalStatus(
    renewalId: string,
    status: string,
    additionalData?: any
  ): Promise<void> {
    await this.prisma.tlsCertificateRenewal.update({
      where: { id: renewalId },
      data: {
        status,
        ...additionalData,
      },
    });

    this.logger.debug({ renewalId, status }, "Updated renewal status");
  }

  /**
   * Extract unique environments from HAProxy frontends
   *
   * @param frontends - Array of frontends with optional environment relation
   * @returns Deduplicated array of environments
   * @private
   */
  private getUniqueEnvironments(
    frontends: Array<{ environment?: { id: string; name: string } | null }>
  ): Array<{ id: string; name: string }> {
    const envMap = new Map<string, { id: string; name: string }>();
    for (const frontend of frontends) {
      if (frontend.environment) {
        envMap.set(frontend.environment.id, frontend.environment);
      }
    }
    return Array.from(envMap.values());
  }
}
