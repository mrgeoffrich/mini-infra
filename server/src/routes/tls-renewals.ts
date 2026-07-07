/**
 * TLS Certificate Renewal History API Routes
 *
 * Endpoints for viewing certificate renewal history:
 * - GET /api/tls/renewals - List all renewal attempts
 * - GET /api/tls/renewals/:id - Get renewal attempt details
 */

import express from "express";
import { getLogger } from "../lib/logger-factory";
import { requirePermission } from "../middleware/auth";
import prisma from "../lib/prisma";
import { Prisma } from "../generated/prisma/client";
import { NotFoundError } from "../lib/errors";
import { ErrorCode, Permission } from "@mini-infra/types";

const logger = getLogger("tls", "tls-renewals");
const router = express.Router();

/**
 * GET /api/tls/renewals
 * List all renewal attempts with optional filtering
 */
router.get("/", requirePermission(Permission.TlsRead), async (req, res, next) => {
  try {
    const { certificateId, status, limit } = req.query;

    // Build where clause based on filters
    const where: Prisma.TlsCertificateRenewalWhereInput = {};
    if (certificateId) {
      where.certificateId = certificateId as string;
    }
    if (status) {
      where.status = status as Prisma.TlsCertificateRenewalWhereInput['status'];
    }

    // Parse limit (default to 100, max 500)
    const parsedLimit = limit
      ? Math.min(parseInt(limit as string, 10), 500)
      : 100;

    const renewals = await prisma.tlsCertificateRenewal.findMany({
      where,
      orderBy: { startedAt: "desc" },
      take: parsedLimit,
      include: {
        certificate: {
          select: {
            id: true,
            primaryDomain: true,
            domains: true,
            status: true,
          },
        },
      },
    });

    res.json({
      success: true,
      data: renewals,
    });
  } catch (error) {
    logger.error({ error }, "Failed to list renewal attempts");
    next(error);
  }
});

/**
 * GET /api/tls/renewals/:id
 * Get renewal attempt details
 */
router.get("/:id", requirePermission(Permission.TlsRead), async (req, res, next) => {
  try {
    const id = String(req.params.id);

    const renewal = await prisma.tlsCertificateRenewal.findUnique({
      where: { id },
      include: {
        certificate: {
          select: {
            id: true,
            primaryDomain: true,
            domains: true,
            status: true,
            notAfter: true,
            blobName: true,
          },
        },
      },
    });

    if (!renewal) {
      throw new NotFoundError(
        ErrorCode.TLS_RENEWAL_NOT_FOUND,
        `Renewal attempt not found: ${id}`,
        {
          resource: { type: "tlsCertificateRenewal", id },
          action: "Check the renewal history list for a valid renewal ID.",
        },
      );
    }

    res.json({
      success: true,
      data: renewal,
    });
  } catch (error) {
    logger.error({ error, renewalId: req.params.id }, "Failed to get renewal attempt");
    next(error);
  }
});

/**
 * GET /api/tls/renewals/certificate/:certificateId
 * Get all renewal attempts for a specific certificate
 */
router.get("/certificate/:certificateId", requirePermission(Permission.TlsRead), async (req, res, next) => {
  try {
    const certificateId = String(req.params.certificateId);

    // Verify certificate exists
    const certificate = await prisma.tlsCertificate.findUnique({
      where: { id: certificateId },
      select: { id: true, primaryDomain: true },
    });

    if (!certificate) {
      throw new NotFoundError(
        ErrorCode.TLS_CERTIFICATE_NOT_FOUND,
        `Certificate not found: ${certificateId}`,
        {
          resource: { type: "tlsCertificate", id: certificateId },
          action: "Verify the certificate ID or check the certificates list.",
        },
      );
    }

    const renewals = await prisma.tlsCertificateRenewal.findMany({
      where: { certificateId },
      orderBy: { startedAt: "desc" },
    });

    res.json({
      success: true,
      data: {
        certificate,
        renewals,
      },
    });
  } catch (error) {
    logger.error(
      { error, certificateId: req.params.certificateId },
      "Failed to get certificate renewal history"
    );
    next(error);
  }
});

export default router;
