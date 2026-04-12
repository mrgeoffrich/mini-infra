/**
 * TLS Certificates API Routes
 *
 * Endpoints for managing TLS certificates:
 * - POST /api/tls/certificates - Issue new certificate
 * - GET /api/tls/certificates - List all certificates
 * - GET /api/tls/certificates/:id - Get certificate details
 * - POST /api/tls/certificates/:id/renew - Manually renew certificate
 * - DELETE /api/tls/certificates/:id - Delete certificate
 */

import express from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { tlsLogger } from "../lib/logger-factory";
import { requirePermission, getAuthenticatedUser } from "../middleware/auth";
import prisma from "../lib/prisma";
import { emitToChannel } from "../lib/socket";
import { TlsConfigService } from "../services/tls/tls-config";
import { AzureStorageCertificateStore } from "../services/tls/azure-storage-certificate-store";
import { AcmeClientManager } from "../services/tls/acme-client-manager";
import { DnsChallenge01Provider } from "../services/tls/dns-challenge-provider";
import { CertificateLifecycleManager } from "../services/tls/certificate-lifecycle-manager";
import { CertificateDistributor } from "../services/tls/certificate-distributor";
import { CloudflareService } from "../services/cloudflare";
import { AzureStorageService } from "../services/azure-storage-service";
import { HAProxyService } from "../services/haproxy/haproxy-service";
import { DockerExecutorService } from "../services/docker-executor";
import { Channel, ServerEvent, type CertIssuanceStep } from "@mini-infra/types";

const logger = tlsLogger();
const router = express.Router();

// Validation schemas
const createCertificateSchema = z.object({
  domains: z.array(z.string()).min(1, "At least one domain is required"),
  primaryDomain: z.string().min(1, "Primary domain is required"),
  autoRenew: z.boolean().optional().default(true),
});

/**
 * Helper to parse certificate JSON fields from database
 */
function parseCertificateData(certificate: Record<string, unknown>) {
  return {
    ...certificate,
    domains: typeof certificate.domains === "string" ? JSON.parse(certificate.domains) : certificate.domains,
    haproxyFrontends: certificate.haproxyFrontends && typeof certificate.haproxyFrontends === "string"
      ? JSON.parse(certificate.haproxyFrontends)
      : certificate.haproxyFrontends || [],
  };
}

/**
 * Helper to initialize certificate lifecycle manager
 */
async function initializeLifecycleManager(): Promise<CertificateLifecycleManager> {
  // Initialize config services
  const tlsConfig = new TlsConfigService(prisma);
  const azureConfig = new AzureStorageService(prisma);

  // Get certificate container name
  const containerName = await tlsConfig.getCertificateContainerName();

  // Get Azure Storage connection string
  const connectionString = await azureConfig.getConnectionString();
  if (!connectionString) {
    throw new Error("Azure Storage not configured");
  }

  // Initialize services
  const certificateStore = new AzureStorageCertificateStore(connectionString, containerName);
  const acmeClient = new AcmeClientManager(tlsConfig, certificateStore);
  const cloudflareConfig = new CloudflareService(prisma);
  const dnsChallenge = new DnsChallenge01Provider(cloudflareConfig);

  // Initialize ACME client
  await acmeClient.initialize();

  // Create certificate distributor for HAProxy deployment
  const haproxyService = new HAProxyService();
  const dockerExecutor = new DockerExecutorService();
  await dockerExecutor.initialize();
  const distributor = new CertificateDistributor(certificateStore, haproxyService, dockerExecutor);

  return new CertificateLifecycleManager(
    acmeClient,
    certificateStore,
    dnsChallenge,
    prisma,
    containerName,
    distributor
  );
}

// Concurrency guard — one issuance per domain at a time
const issuingCertificates = new Set<string>();

/**
 * POST /api/tls/certificates
 * Issue a new TLS certificate (async with Socket.IO progress)
 */
router.post("/", requirePermission('tls:write'), async (req, res) => {
  let guardedDomain: string | null = null;
  try {
    const user = getAuthenticatedUser(req);
    const userId = user?.id || "unknown";

    // Validate request body
    const validatedData = createCertificateSchema.parse(req.body);
    const operationId = randomUUID();

    // Concurrency guard — set BEFORE any await to prevent race conditions
    if (issuingCertificates.has(validatedData.primaryDomain)) {
      return res.status(409).json({
        success: false,
        message: "Certificate issuance already in progress for this domain",
      });
    }
    guardedDomain = validatedData.primaryDomain;
    issuingCertificates.add(guardedDomain);

    logger.info({ userId, domains: validatedData.domains, operationId }, "Starting async certificate issuance");

    // Initialize synchronously before 200 to detect misconfig fast
    const lifecycleManager = await initializeLifecycleManager();

    const totalSteps = 4;
    const stepNames = [
      "Request certificate from Let's Encrypt",
      "Save certificate record",
      "Store certificate in Azure",
      "Activate certificate",
    ];

    // Respond immediately — progress comes via Socket.IO
    res.json({ success: true, data: { started: true, operationId } });

    // Run issuance in background
    (async () => {
      const steps: CertIssuanceStep[] = [];

      try {
        emitToChannel(Channel.TLS, ServerEvent.CERT_ISSUANCE_STARTED, {
          operationId,
          domains: validatedData.domains,
          primaryDomain: validatedData.primaryDomain,
          totalSteps,
          stepNames,
        });

        const certificate = await lifecycleManager.issueCertificate(
          { domains: validatedData.domains, primaryDomain: validatedData.primaryDomain, userId },
          (step, completedCount, totalSteps) => {
            steps.push(step);
            try {
              emitToChannel(Channel.TLS, ServerEvent.CERT_ISSUANCE_STEP, {
                operationId, step, completedCount, totalSteps,
              });
            } catch { /* never break issuance */ }
          },
        );

        logger.info({ operationId, certificateId: certificate.id }, "Async certificate issuance completed");

        emitToChannel(Channel.TLS, ServerEvent.CERT_ISSUANCE_COMPLETED, {
          operationId,
          success: true,
          certificateId: certificate.id,
          primaryDomain: validatedData.primaryDomain,
          steps,
          errors: [],
        });
      } catch (error) {
        logger.error({ error: (error instanceof Error ? error.message : String(error)), operationId }, "Background certificate issuance failed");
        emitToChannel(Channel.TLS, ServerEvent.CERT_ISSUANCE_COMPLETED, {
          operationId,
          success: false,
          primaryDomain: validatedData.primaryDomain,
          steps,
          errors: [(error instanceof Error ? error.message : String(error))],
        });
      } finally {
        issuingCertificates.delete(validatedData.primaryDomain);
      }
    })();
  } catch (error) {
    if (guardedDomain) issuingCertificates.delete(guardedDomain);
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        error: "Validation failed",
        details: error.issues,
      });
    }

    logger.error({ error }, "Failed to start certificate issuance");

    res.status(500).json({
      success: false,
      error: "Failed to start certificate issuance",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * GET /api/tls/certificates
 * List all certificates
 */
router.get("/", requirePermission('tls:read'), async (req, res) => {
  try {
    const certificates = await prisma.tlsCertificate.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        renewalHistory: {
          orderBy: { startedAt: "desc" },
          take: 1,
        },
      },
    });

    // Parse JSON fields for each certificate
    const parsedCertificates = certificates.map(parseCertificateData);

    res.json({
      success: true,
      data: parsedCertificates,
    });
  } catch (error) {
    logger.error({ error }, "Failed to list certificates");

    res.status(500).json({
      success: false,
      error: "Failed to list certificates",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * GET /api/tls/certificates/:id
 * Get certificate details
 */
router.get("/:id", requirePermission('tls:read'), async (req, res) => {
  try {
    const id = String(req.params.id);

    const certificate = await prisma.tlsCertificate.findUnique({
      where: { id },
      include: {
        renewalHistory: {
          orderBy: { startedAt: "desc" },
        },
      },
    });

    if (!certificate) {
      return res.status(404).json({
        success: false,
        error: "Certificate not found",
      });
    }

    // Parse JSON fields
    const parsedCertificate = parseCertificateData(certificate);

    res.json({
      success: true,
      data: parsedCertificate,
    });
  } catch (error) {
    logger.error({ error, certificateId: req.params.id }, "Failed to get certificate");

    res.status(500).json({
      success: false,
      error: "Failed to get certificate",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * POST /api/tls/certificates/:id/renew
 * Manually renew a certificate
 */
router.post("/:id/renew", requirePermission('tls:write'), async (req, res) => {
  try {
    const id = String(req.params.id);
    const user = getAuthenticatedUser(req);
    const userId = user?.id || "unknown";

    logger.info({ userId, certificateId: id }, "Manually triggering certificate renewal");

    // Initialize lifecycle manager
    const lifecycleManager = await initializeLifecycleManager();

    // Renew certificate
    const certificate = await lifecycleManager.renewCertificate(id);

    res.json({
      success: true,
      data: certificate,
    });
  } catch (error) {
    logger.error({ error, certificateId: req.params.id }, "Failed to renew certificate");

    res.status(500).json({
      success: false,
      error: "Failed to renew certificate",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * DELETE /api/tls/certificates/:id
 * Delete a certificate
 */
router.delete("/:id", requirePermission('tls:write'), async (req, res) => {
  try {
    const id = String(req.params.id);
    const user = getAuthenticatedUser(req);
    const userId = user?.id || "unknown";

    logger.info({ userId, certificateId: id }, "Deleting certificate");

    // Get certificate
    const certificate = await prisma.tlsCertificate.findUnique({
      where: { id },
    });

    if (!certificate) {
      return res.status(404).json({
        success: false,
        error: "Certificate not found",
      });
    }

    // Delete from database (cascade will delete renewal history)
    await prisma.tlsCertificate.delete({
      where: { id },
    });

    // Note: Certificate remains in Key Vault (soft deleted)
    // Manual purge from Key Vault can be done separately if needed

    res.json({
      success: true,
      message: "Certificate deleted successfully",
    });
  } catch (error) {
    logger.error({ error, certificateId: req.params.id }, "Failed to delete certificate");

    res.status(500).json({
      success: false,
      error: "Failed to delete certificate",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

export default router;
