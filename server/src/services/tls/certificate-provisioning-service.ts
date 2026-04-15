/**
 * Certificate Provisioning Service
 *
 * Handles certificate lookup and provisioning for hostnames.
 * This service checks for existing certificates and provisions new ones if needed.
 */

import { Logger } from "pino";
import { PrismaClient } from "../../generated/prisma/client";
import { getLogger } from "../../lib/logger-factory";
import { CertificateLifecycleManager } from "./certificate-lifecycle-manager";

export interface ProvisionRequest {
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
 * Service for provisioning certificates
 */
export class CertificateProvisioningService {
  private lifecycleManager: CertificateLifecycleManager;
  private prisma: PrismaClient;
  private logger: Logger;

  constructor(lifecycleManager: CertificateLifecycleManager, prisma: PrismaClient) {
    this.lifecycleManager = lifecycleManager;
    this.prisma = prisma;
    this.logger = getLogger("tls", "certificate-provisioning-service");
  }

  /**
   * Provision certificate for a hostname
   *
   * This method:
   * 1. Checks if a certificate already exists for the hostname
   * 2. If yes, returns the existing certificate
   * 3. If no, provisions a new certificate asynchronously
   *
   * @param request - Provisioning request
   * @returns Provisioning result
   */
  async provisionCertificate(
    request: ProvisionRequest
  ): Promise<ProvisionResult> {
    const { hostname, userId } = request;

    this.logger.info(
      { hostname },
      "Starting certificate provisioning"
    );

    try {
      // Step 1: Check for existing certificate
      const existingCert = await this.findCertificateForHostname(hostname);

      if (existingCert) {
        // Use existing certificate
        this.logger.info(
          {
            hostname,
            certificateId: existingCert.id,
          },
          "Found existing certificate for hostname"
        );

        return {
          success: true,
          certificateId: existingCert.id as string,
          certificateStatus: existingCert.status === "ACTIVE" ? "ACTIVE" : "PENDING",
          existingCertificateUsed: true,
        };
      }

      // Step 2: No existing certificate - provision new one
      this.logger.info(
        { hostname },
        "No existing certificate found, provisioning new certificate"
      );

      try {
        const newCert = await this.lifecycleManager.issueCertificate({
          domains: [hostname],
          primaryDomain: hostname,
          userId,
          deployToHaproxy: false, // Don't deploy yet, will be done during first deployment
        });

        this.logger.info(
          {
            hostname,
            certificateId: newCert.id,
          },
          "Certificate provisioned successfully"
        );

        return {
          success: true,
          certificateId: newCert.id as string,
          certificateStatus: "ACTIVE",
          existingCertificateUsed: false,
        };
      } catch (provisionError) {
        // Certificate provisioning failed
        this.logger.error(
          {
            hostname,
            error: provisionError,
          },
          "Certificate provisioning failed"
        );

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
  async findCertificateForHostname(hostname: string): Promise<Record<string, unknown> | null> {
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
}
