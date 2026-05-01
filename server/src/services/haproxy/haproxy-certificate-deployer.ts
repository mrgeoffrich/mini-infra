import { getLogger } from "../../lib/logger-factory";
import { PrismaClient } from "../../generated/prisma/client";
import { StorageCertificateStore } from "../tls/storage-certificate-store";
import { TlsConfigService } from "../tls/tls-config";
import { StorageService } from "../storage/storage-service";
import { HAProxyDataPlaneClient } from "./haproxy-dataplane-client";
import { generateCertFileName } from "./haproxy-naming";

const logger = getLogger("haproxy", "haproxy-certificate-deployer");

/**
 * Options for fetchAndPrepareCertificate
 */
export interface CertificatePrepareOptions {
  /** Validate that certificate status is ACTIVE (default: false) */
  requireActive?: boolean;
  /** Which certificate field to derive the filename from (default: "primaryDomain") */
  fileNameSource?: "primaryDomain" | "blobName";
  /** Return null instead of throwing when certificate is not found (default: false) */
  gracefulNotFound?: boolean;
}

/**
 * Result of preparing a certificate for HAProxy deployment
 */
export interface PreparedCertificate {
  combinedPem: string;
  certFileName: string;
}

/**
 * HaproxyCertificateDeployer centralizes the repeated pattern of:
 *   DB lookup → Azure fetch → PEM combine → HAProxy upload
 *
 * This pattern was previously duplicated across:
 * - HAProxyFrontendManager.configureSslBinding
 * - HAProxyFrontendManager.configureSharedFrontendSSL
 * - HAProxyFrontendManager.uploadCertificateForSNI
 * - The POST /:frontendName/ssl route handler
 */
export class HaproxyCertificateDeployer {
  /**
   * Fetch a certificate from the database and Azure Storage, then
   * combine the certificate and private key into a single PEM string.
   *
   * @param certId The TLS certificate ID from database
   * @param prisma Prisma client instance
   * @param options Configuration options
   * @returns The combined PEM and filename, or null if gracefulNotFound is set and cert not found
   */
  async fetchAndPrepareCertificate(
    certId: string,
    prisma: PrismaClient,
    options?: CertificatePrepareOptions
  ): Promise<PreparedCertificate | null> {
    const requireActive = options?.requireActive ?? false;
    const fileNameSource = options?.fileNameSource ?? "primaryDomain";
    const gracefulNotFound = options?.gracefulNotFound ?? false;

    logger.info(
      { certId, requireActive, fileNameSource },
      "Fetching and preparing certificate"
    );

    // Step 1: Get certificate from database
    const certificate = await prisma.tlsCertificate.findUnique({
      where: { id: certId },
    });

    if (!certificate) {
      if (gracefulNotFound) {
        logger.warn({ certId }, "Certificate not found, skipping");
        return null;
      }
      throw new Error(`Certificate not found: ${certId}`);
    }

    if (requireActive && certificate.status !== "ACTIVE") {
      throw new Error(
        `Certificate is not active: ${certificate.status}`
      );
    }

    if (!certificate.blobName) {
      if (gracefulNotFound) {
        logger.warn({ certId }, "Certificate blob name not found, skipping");
        return null;
      }
      throw new Error(
        `Certificate blob name not found for certificate: ${certId}`
      );
    }

    logger.info(
      { certId, blobName: certificate.blobName },
      "Retrieved certificate from database"
    );

    // Step 2: Initialize TLS config and active storage backend
    const tlsConfig = new TlsConfigService(prisma);
    const containerName = await tlsConfig.getCertificateContainerName();

    let storageBackend;
    try {
      storageBackend = await StorageService.getInstance(prisma).getActiveBackend();
    } catch (err) {
      throw new Error(
        `No storage provider configured (${err instanceof Error ? err.message : "unknown"}). Configure a provider before deploying certificates.`,
        { cause: err },
      );
    }

    const certificateStore = new StorageCertificateStore(
      storageBackend,
      containerName,
    );

    // Step 3: Get certificate from active storage provider
    logger.info(
      { blobName: certificate.blobName },
      "Retrieving certificate from storage backend",
    );

    const certData = await certificateStore.getCertificate(
      certificate.blobName
    );

    // Step 4: Combine certificate and private key for HAProxy
    const combinedPem = `${certData.certificate}\n${certData.privateKey}`;

    // Step 5: Generate filename
    const source =
      fileNameSource === "blobName"
        ? certificate.blobName
        : certificate.primaryDomain;
    const certFileName = generateCertFileName(source, fileNameSource);

    logger.info(
      { certId, certFileName },
      "Certificate prepared successfully"
    );

    return { combinedPem, certFileName };
  }

  /**
   * Deploy a certificate to HAProxy via DataPlane API.
   *
   * Tries to update the certificate first; if it doesn't exist (404),
   * uploads it as a new certificate. Always uses force_reload=true.
   *
   * @param certFileName The certificate filename
   * @param combinedPem The combined PEM content (cert + key)
   * @param haproxyClient HAProxy DataPlane client instance
   */
  async deployCertificateToHAProxy(
    certFileName: string,
    combinedPem: string,
    haproxyClient: HAProxyDataPlaneClient
  ): Promise<void> {
    logger.info({ certFileName }, "Deploying certificate to HAProxy");

    try {
      await haproxyClient.updateSSLCertificate(
        certFileName,
        combinedPem,
        true
      );
      logger.info({ certFileName }, "Updated existing SSL certificate");
    } catch (updateError: unknown) {
      const errMsg = updateError instanceof Error ? updateError.message : String(updateError);
      if (
        errMsg.includes("not found") ||
        errMsg.includes("404")
      ) {
        await haproxyClient.uploadSSLCertificate(
          certFileName,
          combinedPem,
          true
        );
        logger.info({ certFileName }, "Uploaded new SSL certificate");
      } else {
        throw updateError;
      }
    }
  }

  /**
   * Convenience method: fetch, prepare, and deploy a certificate to HAProxy.
   *
   * @param certId The TLS certificate ID from database
   * @param prisma Prisma client instance
   * @param haproxyClient HAProxy DataPlane client instance
   * @param options Configuration options
   * @returns The certificate filename, or null if certificate was not found (gracefulNotFound)
   */
  async fetchAndDeployCertificate(
    certId: string,
    prisma: PrismaClient,
    haproxyClient: HAProxyDataPlaneClient,
    options?: CertificatePrepareOptions
  ): Promise<string | null> {
    const prepared = await this.fetchAndPrepareCertificate(
      certId,
      prisma,
      options
    );

    if (!prepared) {
      return null;
    }

    await this.deployCertificateToHAProxy(
      prepared.certFileName,
      prepared.combinedPem,
      haproxyClient
    );

    return prepared.certFileName;
  }

  /**
   * Remove a certificate from HAProxy storage if no routes or frontends still use it.
   *
   * Checks both HAProxyRoute and HAProxyFrontend tables before deleting.
   *
   * @param certId The TLS certificate ID from database
   * @param prisma Prisma client instance
   * @param haproxyClient HAProxy DataPlane client instance
   */
  async removeCertificateIfUnused(
    certId: string,
    prisma: PrismaClient,
    haproxyClient: HAProxyDataPlaneClient
  ): Promise<void> {
    logger.info({ certId }, "Checking if certificate can be removed");

    // Get certificate from database to find the filename
    const certificate = await prisma.tlsCertificate.findUnique({
      where: { id: certId },
    });

    if (!certificate) {
      logger.warn(
        { certId },
        "Certificate not found in database, skipping removal"
      );
      return;
    }

    // Generate the same filename used during upload
    const certFileName = generateCertFileName(certificate.primaryDomain);

    // Check if any other routes still use this certificate
    const otherRoutesUsingCert = await prisma.hAProxyRoute.count({
      where: {
        tlsCertificateId: certId,
        status: "active",
      },
    });

    if (otherRoutesUsingCert > 0) {
      logger.info(
        { certId, certFileName, otherRoutesUsingCert },
        "Certificate still in use by other routes, skipping removal"
      );
      return;
    }

    // Also check manual frontends using this certificate
    const manualFrontendsUsingCert = await prisma.hAProxyFrontend.count({
      where: {
        tlsCertificateId: certId,
        status: { not: "removed" },
      },
    });

    if (manualFrontendsUsingCert > 0) {
      logger.info(
        { certId, certFileName, manualFrontendsUsingCert },
        "Certificate still in use by manual frontends, skipping removal"
      );
      return;
    }

    // Delete the certificate from HAProxy
    await haproxyClient.deleteSSLCertificate(certFileName, false);

    logger.info(
      { certFileName, certId, primaryDomain: certificate.primaryDomain },
      "Certificate removed from HAProxy storage"
    );
  }
}

// Export singleton instance
export const haproxyCertificateDeployer = new HaproxyCertificateDeployer();
