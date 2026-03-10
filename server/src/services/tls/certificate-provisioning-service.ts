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
   * Checks exact primaryDomain match, wildcard match (*.example.com),
   * and JSON domains array membership.
   *
   * @param hostname - Hostname to search for
   * @returns Certificate record or null
   */
  async findCertificateForHostname(hostname: string): Promise<any | null> {
    const statusFilter = { in: ["ACTIVE", "PENDING", "RENEWING"] as ("ACTIVE" | "PENDING" | "RENEWING")[] };

    // 1. Exact match on primaryDomain
    const exactMatch = await this.prisma.tlsCertificate.findFirst({
      where: { primaryDomain: hostname, status: statusFilter },
      orderBy: { createdAt: "desc" },
    });
    if (exactMatch) return exactMatch;

    // 2. Wildcard match: cert for "*.example.com" covers "api.example.com"
    const parts = hostname.split(".");
    if (parts.length >= 3) {
      const wildcardDomain = "*." + parts.slice(1).join(".");
      const wildcardMatch = await this.prisma.tlsCertificate.findFirst({
        where: { primaryDomain: wildcardDomain, status: statusFilter },
        orderBy: { createdAt: "desc" },
      });
      if (wildcardMatch) return wildcardMatch;
    }

    // 3. Domains array membership (JSON string stored in SQLite)
    const candidates = await this.prisma.tlsCertificate.findMany({
      where: {
        status: statusFilter,
        domains: { contains: hostname },
      },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    for (const cert of candidates) {
      const domainList: string[] = Array.isArray(cert.domains)
        ? cert.domains
        : JSON.parse(cert.domains as string);
      if (domainList.includes(hostname)) return cert;
      // Also check wildcard entries in the domains array
      for (const d of domainList) {
        if (d.startsWith("*.") && hostname.endsWith(d.slice(1)) && !hostname.slice(0, -d.length + 1).includes(".")) {
          return cert;
        }
      }
    }

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
