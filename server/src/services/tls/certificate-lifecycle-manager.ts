/**
 * Certificate Lifecycle Manager
 *
 * This service orchestrates certificate issuance and renewal workflows.
 * It coordinates between ACME client, Key Vault storage, DNS challenge provider, and the database.
 */

import { Logger } from "pino";
import { PrismaClient } from "@prisma/client";
import { tlsLogger } from "../../lib/logger-factory";
import { AcmeClientManager } from "./acme-client-manager";
import { AzureKeyVaultCertificateStore } from "./azure-keyvault-certificate-store";
import { DnsChallenge01Provider } from "./dns-challenge-provider";
import { CertificateDistributor } from "./certificate-distributor";
import { parseCertificate } from "./certificate-format-helper";
import { CertificateRequest } from "./types";

/**
 * Service for managing certificate lifecycle
 */
export class CertificateLifecycleManager {
  private acmeClient: AcmeClientManager;
  private keyVaultStore: AzureKeyVaultCertificateStore;
  private dnsChallenge: DnsChallenge01Provider;
  private distributor?: CertificateDistributor;
  private prisma: PrismaClient;
  private logger: Logger;

  constructor(
    acmeClient: AcmeClientManager,
    keyVaultStore: AzureKeyVaultCertificateStore,
    dnsChallenge: DnsChallenge01Provider,
    prisma: PrismaClient,
    distributor?: CertificateDistributor
  ) {
    this.acmeClient = acmeClient;
    this.keyVaultStore = keyVaultStore;
    this.dnsChallenge = dnsChallenge;
    this.distributor = distributor;
    this.prisma = prisma;
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

      // Step 3: Store in Azure Key Vault
      this.logger.info("Storing certificate in Azure Key Vault");
      const keyVaultName = `cert-${primaryDomain.replace(/\./g, "-")}`;

      const { version, secretId } = await this.keyVaultStore.storeCertificate(
        keyVaultName,
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

      // Step 4: Create database record
      const renewAfter = new Date(certInfo.notAfter);
      renewAfter.setDate(renewAfter.getDate() - 30); // Renew 30 days before expiry

      const tlsCertificate = await this.prisma.tlsCertificate.create({
        data: {
          domains: JSON.stringify(domains),
          primaryDomain: primaryDomain,
          certificateType: "ACME",
          acmeProvider: "letsencrypt",
          keyVaultCertificateName: keyVaultName,
          keyVaultVersion: version,
          keyVaultSecretId: secretId,
          issuer: certInfo.issuer,
          serialNumber: certInfo.serialNumber || undefined,
          fingerprint: certInfo.fingerprint,
          issuedAt: new Date(),
          notBefore: certInfo.notBefore,
          notAfter: certInfo.notAfter,
          renewAfter,
          status: "ACTIVE",
          autoRenew: true,
          renewalDaysBeforeExpiry: 30,
          haproxyFrontends: JSON.stringify([]),
          createdBy: userId,
        },
      });

      // Step 5: Deploy to HAProxy (if requested and distributor is available)
      if (request.deployToHaproxy && this.distributor) {
        this.logger.info("Deploying certificate to HAProxy");
        try {
          const deployResult = await this.distributor.deployCertificate(
            keyVaultName,
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
      include: { renewalHistory: true },
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

      // Store new version in Key Vault
      const domains = Array.isArray(existingCert.domains) ? existingCert.domains : JSON.parse(existingCert.domains as any);
      const { version, secretId } = await this.keyVaultStore.storeCertificate(
        existingCert.keyVaultCertificateName,
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
          keyVaultVersion: version,
          keyVaultSecretId: secretId,
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

      // Deploy to HAProxy (zero-downtime update) if distributor is available
      if (this.distributor) {
        this.logger.info("Deploying renewed certificate to HAProxy");
        try {
          const deployResult = await this.distributor.deployCertificate(
            existingCert.keyVaultCertificateName
          );

          if (deployResult.success) {
            this.logger.info(
              { certificateId, method: deployResult.method },
              "Renewed certificate deployed to HAProxy successfully"
            );
          } else {
            this.logger.warn(
              { certificateId, error: deployResult.error },
              "Renewed certificate deployment to HAProxy failed (certificate renewed but not deployed)"
            );
          }
        } catch (deployError) {
          this.logger.warn(
            { certificateId, error: deployError },
            "Renewed certificate deployment to HAProxy failed (certificate renewed but not deployed)"
          );
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
}
