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

const logger = getLogger("tls", "tls-renewals");
const router = express.Router();

/**
 * GET /api/tls/renewals
 * List all renewal attempts with optional filtering
 */
router.get("/", requirePermission('tls:read'), async (req, res) => {
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

    res.status(500).json({
      success: false,
      error: "Failed to list renewal attempts",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * GET /api/tls/renewals/:id
 * Get renewal attempt details
 */
router.get("/:id", requirePermission('tls:read'), async (req, res) => {
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
      return res.status(404).json({
        success: false,
        error: "Renewal attempt not found",
      });
    }

    res.json({
      success: true,
      data: renewal,
    });
  } catch (error) {
    logger.error({ error, renewalId: req.params.id }, "Failed to get renewal attempt");

    res.status(500).json({
      success: false,
      error: "Failed to get renewal attempt",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * GET /api/tls/renewals/certificate/:certificateId
 * Get all renewal attempts for a specific certificate
 */
router.get("/certificate/:certificateId", requirePermission('tls:read'), async (req, res) => {
  try {
    const certificateId = String(req.params.certificateId);

    // Verify certificate exists
    const certificate = await prisma.tlsCertificate.findUnique({
      where: { id: certificateId },
      select: { id: true, primaryDomain: true },
    });

    if (!certificate) {
      return res.status(404).json({
        success: false,
        error: "Certificate not found",
      });
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

    res.status(500).json({
      success: false,
      error: "Failed to get certificate renewal history",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

export default router;
