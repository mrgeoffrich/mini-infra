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
import { getLogger } from "../lib/logger-factory";
import { requirePermission, getAuthenticatedUser } from "../middleware/auth";
import prisma from "../lib/prisma";
import { emitToChannel } from "../lib/socket";
import { ConflictError, NotFoundError } from "../lib/errors";
import { TlsConfigService } from "../services/tls/tls-config";
import { StorageCertificateStore } from "../services/tls/storage-certificate-store";
import { AcmeClientManager } from "../services/tls/acme-client-manager";
import { DnsChallenge01Provider } from "../services/tls/dns-challenge-provider";
import { CertificateLifecycleManager } from "../services/tls/certificate-lifecycle-manager";
import { CertificateDistributor } from "../services/tls/certificate-distributor";
import { CloudflareService } from "../services/cloudflare";
import { StorageService } from "../services/storage/storage-service";
import { HAProxyService } from "../services/haproxy/haproxy-service";
import { DockerExecutorService } from "../services/docker-executor";
import { Channel, ServerEvent, type CertIssuanceStep, ErrorCode, Permission } from "@mini-infra/types";

const logger = getLogger("tls", "tls-certificates");
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

  // Get certificate storage location id
  const containerName = await tlsConfig.getCertificateContainerName();

  // Resolve the active StorageBackend (Azure today; Drive in Phase 3).
  const storageBackend = await StorageService.getInstance(prisma).getActiveBackend();

  // Initialize services
  const certificateStore = new StorageCertificateStore(storageBackend, containerName);
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
router.post("/", requirePermission(Permission.TlsWrite), async (req, res, next) => {
  let guardedDomain: string | null = null;
  try {
    const user = getAuthenticatedUser(req);
    const userId = user?.id || "unknown";

    // Validate request body — a ZodError thrown here is handled centrally
    // (server/src/lib/error-handler.ts maps it to VALIDATION_FAILED).
    const validatedData = createCertificateSchema.parse(req.body);
    const operationId = randomUUID();

    // Concurrency guard — set BEFORE any await to prevent race conditions
    if (issuingCertificates.has(validatedData.primaryDomain)) {
      throw new ConflictError(
        ErrorCode.TLS_CERTIFICATE_ISSUANCE_IN_PROGRESS,
        "Certificate issuance already in progress for this domain",
        {
          resource: { type: "tlsCertificate", name: validatedData.primaryDomain },
          action: "Wait for the in-progress issuance to finish before retrying.",
        },
      );
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
          certificateId: certificate.id as string,
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

    logger.error({ error }, "Failed to start certificate issuance");

    // Taxonomy errors (ConflictError above, ZodError from .parse(), or a
    // taxonomy error thrown deep inside initializeLifecycleManager — e.g.
    // TLS_STORAGE_NOT_CONFIGURED) carry their own status/code and are
    // handled by the central error middleware.
    next(error);
  }
});

/**
 * GET /api/tls/certificates
 * List all certificates
 */
router.get("/", requirePermission(Permission.TlsRead), async (req, res, next) => {
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
    next(error);
  }
});

/**
 * GET /api/tls/certificates/:id
 * Get certificate details
 */
router.get("/:id", requirePermission(Permission.TlsRead), async (req, res, next) => {
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
      throw new NotFoundError(
        ErrorCode.TLS_CERTIFICATE_NOT_FOUND,
        `Certificate not found: ${id}`,
        {
          resource: { type: "tlsCertificate", id },
          action: "Verify the certificate ID or check the certificates list.",
        },
      );
    }

    // Parse JSON fields
    const parsedCertificate = parseCertificateData(certificate);

    res.json({
      success: true,
      data: parsedCertificate,
    });
  } catch (error) {
    logger.error({ error, certificateId: req.params.id }, "Failed to get certificate");
    next(error);
  }
});

/**
 * POST /api/tls/certificates/:id/renew
 * Manually renew a certificate
 */
router.post("/:id/renew", requirePermission(Permission.TlsWrite), async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const user = getAuthenticatedUser(req);
    const userId = user?.id || "unknown";

    logger.info({ userId, certificateId: id }, "Manually triggering certificate renewal");

    // Initialize lifecycle manager
    const lifecycleManager = await initializeLifecycleManager();

    // Renew certificate — throws NotFoundError (TLS_CERTIFICATE_NOT_FOUND)
    // when `id` doesn't match a stored certificate; forwarded to the
    // central middleware below instead of being papered over as a 500.
    const certificate = await lifecycleManager.renewCertificate(id);

    res.json({
      success: true,
      data: certificate,
    });
  } catch (error) {
    logger.error({ error, certificateId: req.params.id }, "Failed to renew certificate");
    next(error);
  }
});

/**
 * DELETE /api/tls/certificates/:id
 * Delete a certificate
 */
router.delete("/:id", requirePermission(Permission.TlsWrite), async (req, res, next) => {
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
      throw new NotFoundError(
        ErrorCode.TLS_CERTIFICATE_NOT_FOUND,
        `Certificate not found: ${id}`,
        {
          resource: { type: "tlsCertificate", id },
          action: "Verify the certificate ID or check the certificates list.",
        },
      );
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
    next(error);
  }
});

export default router;
