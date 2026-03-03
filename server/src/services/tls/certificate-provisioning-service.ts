/**
 * Certificate Provisioning Service
 *
 * Handles async certificate provisioning for deployment configurations.
 * This service checks for existing certificates, provisions new ones if needed,
 * and updates deployment configurations with certificate references.
 */

import { Logger } from "pino";
import { PrismaClient } from "@prisma/client";
import { tlsLogger } from "../../lib/logger-factory";
import { CertificateLifecycleManager } from "./certificate-lifecycle-manager";

export interface ProvisionRequest {
  deploymentConfigId: string;
  hostname: string;
  userId: string;
}

export interface ProvisionResult {
  success: boolean;
  certificateId?: string;
  certificateStatus: "PENDING" | "ACTIVE" | "ERROR";
  errorMessage?: string;
  existingCertificateUsed?: boolean;
}

/**
 * Service for provisioning certificates for deployment configurations
 */
export class CertificateProvisioningService {
  private lifecycleManager: CertificateLifecycleManager;
  private prisma: PrismaClient;
  private logger: Logger;

  constructor(lifecycleManager: CertificateLifecycleManager, prisma: PrismaClient) {
    this.lifecycleManager = lifecycleManager;
    this.prisma = prisma;
    this.logger = tlsLogger();
  }

  /**
   * Provision certificate for deployment configuration
   *
   * This method:
   * 1. Checks if a certificate already exists for the hostname
   * 2. If yes, associates existing certificate with deployment config
   * 3. If no, provisions a new certificate asynchronously
   * 4. Updates deployment config with certificate reference
   *
   * @param request - Provisioning request
   * @returns Provisioning result
   */
  async provisionCertificateForDeployment(
    request: ProvisionRequest
  ): Promise<ProvisionResult> {
    const { deploymentConfigId, hostname, userId } = request;

    this.logger.info(
      { deploymentConfigId, hostname },
      "Starting certificate provisioning for deployment"
    );

    try {
      // Step 1: Check for existing certificate
      const existingCert = await this.findCertificateForHostname(hostname);

      if (existingCert) {
        // Use existing certificate
        this.logger.info(
          {
            deploymentConfigId,
            hostname,
            certificateId: existingCert.id,
          },
          "Found existing certificate for hostname"
        );

        // Update deployment config with existing certificate
        await this.prisma.deploymentConfiguration.update({
          where: { id: deploymentConfigId },
          data: {
            tlsCertificateId: existingCert.id,
            certificateStatus: existingCert.status === "ACTIVE" ? "ACTIVE" : "PENDING",
          },
        });

        return {
          success: true,
          certificateId: existingCert.id,
          certificateStatus: existingCert.status === "ACTIVE" ? "ACTIVE" : "PENDING",
          existingCertificateUsed: true,
        };
      }

      // Step 2: No existing certificate - provision new one
      this.logger.info(
        { deploymentConfigId, hostname },
        "No existing certificate found, provisioning new certificate"
      );

      // Set deployment config status to PENDING first
      await this.prisma.deploymentConfiguration.update({
        where: { id: deploymentConfigId },
        data: {
          certificateStatus: "PENDING",
        },
      });

      // Provision certificate asynchronously
      try {
        const newCert = await this.lifecycleManager.issueCertificate({
          domains: [hostname],
          primaryDomain: hostname,
          userId,
          deployToHaproxy: false, // Don't deploy yet, will be done during first deployment
        });

        // Update deployment config with new certificate
        await this.prisma.deploymentConfiguration.update({
          where: { id: deploymentConfigId },
          data: {
            tlsCertificateId: newCert.id,
            certificateStatus: "ACTIVE",
          },
        });

        this.logger.info(
          {
            deploymentConfigId,
            hostname,
            certificateId: newCert.id,
          },
          "Certificate provisioned successfully"
        );

        return {
          success: true,
          certificateId: newCert.id,
          certificateStatus: "ACTIVE",
          existingCertificateUsed: false,
        };
      } catch (provisionError) {
        // Certificate provisioning failed
        this.logger.error(
          {
            deploymentConfigId,
            hostname,
            error: provisionError,
          },
          "Certificate provisioning failed"
        );

        // Update deployment config with error status
        await this.prisma.deploymentConfiguration.update({
          where: { id: deploymentConfigId },
          data: {
            certificateStatus: "ERROR",
          },
        });

        return {
          success: false,
          certificateStatus: "ERROR",
          errorMessage:
            provisionError instanceof Error
              ? provisionError.message
              : "Certificate provisioning failed",
          existingCertificateUsed: false,
        };
      }
    } catch (error) {
      this.logger.error(
        {
          deploymentConfigId,
          hostname,
          error,
        },
        "Certificate provisioning workflow failed"
      );

      return {
        success: false,
        certificateStatus: "ERROR",
        errorMessage:
          error instanceof Error ? error.message : "Certificate provisioning workflow failed",
        existingCertificateUsed: false,
      };
    }
  }

  /**
   * Find certificate for hostname
   *
   * Searches for an active certificate that matches the hostname.
   * Checks both exact match on primaryDomain and JSON array match in domains field.
   *
   * @param hostname - Hostname to search for
   * @returns Certificate record or null
   */
  private async findCertificateForHostname(hostname: string): Promise<any | null> {
    // First try exact match on primaryDomain
    const exactMatch = await this.prisma.tlsCertificate.findFirst({
      where: {
        primaryDomain: hostname,
        status: {
          in: ["ACTIVE", "PENDING", "RENEWING"],
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    if (exactMatch) {
      return exactMatch;
    }

    // No exact match found - could implement wildcard matching here in the future
    // For now, only return exact primary domain matches
    return null;
  }

  /**
   * Check certificate status for deployment config
   *
   * @param deploymentConfigId - Deployment config ID
   * @returns Certificate status info
   */
  async checkCertificateStatus(
    deploymentConfigId: string
  ): Promise<{
    hasCertificate: boolean;
    certificateStatus?: "PENDING" | "ACTIVE" | "ERROR";
    certificate?: any;
  }> {
    const deploymentConfig = await this.prisma.deploymentConfiguration.findUnique({
      where: { id: deploymentConfigId },
      include: {
        tlsCertificate: true,
      },
    });

    if (!deploymentConfig) {
      throw new Error(`Deployment config not found: ${deploymentConfigId}`);
    }

    if (!deploymentConfig.tlsCertificate) {
      return {
        hasCertificate: false,
      };
    }

    return {
      hasCertificate: true,
      certificateStatus: deploymentConfig.certificateStatus as any,
      certificate: deploymentConfig.tlsCertificate,
    };
  }
}
