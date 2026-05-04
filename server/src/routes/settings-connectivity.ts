import express, {
  Request,
  Response,
  NextFunction,
  RequestHandler,
} from "express";
import { z } from "zod";
import { getLogger } from "../lib/logger-factory";

const logger = getLogger("http", "settings-connectivity");
import { requirePermission, getAuthenticatedUser } from "../middleware/auth";
import prisma from "../lib/prisma";
import { Prisma } from "../generated/prisma/client";
import {
  ConnectivityStatus,
  ConnectivityStatusInfo,
  ConnectivityStatusListResponse,
  SORT_ORDERS,
} from "@mini-infra/types";

const router = express.Router();

// Helper function to convert ConnectivityStatus to ConnectivityStatusInfo for API responses
function serializeConnectivityStatus(
  status: ConnectivityStatus,
): ConnectivityStatusInfo {
  return {
    ...status,
    responseTimeMs: status.responseTimeMs
      ? Number(status.responseTimeMs)
      : null,
    lastSuccessfulAt: status.lastSuccessfulAt?.toISOString() || null,
    checkedAt: status.checkedAt.toISOString(),
  };
}

// Connectivity query parameter validation schema
const connectivityQuerySchema = z.object({
  service: z
    .enum([
      "docker",
      "cloudflare",
      "storage",
      "system",
      "deployments",
      "haproxy",
      "tls",
      "github-app",
      "tailscale",
    ])
    .optional(),
  status: z
    .enum(["connected", "failed", "timeout", "unreachable", "error"])
    .optional(),
  checkInitiatedBy: z.string().optional(),
  startDate: z
    .string()
    .optional()
    .transform((val, ctx) => {
      if (!val) return undefined;
      const parsed = new Date(val);
      if (isNaN(parsed.getTime())) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Start date must be a valid ISO date string",
        });
        return z.NEVER;
      }
      return parsed;
    }),
  endDate: z
    .string()
    .optional()
    .transform((val, ctx) => {
      if (!val) return undefined;
      const parsed = new Date(val);
      if (isNaN(parsed.getTime())) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "End date must be a valid ISO date string",
        });
        return z.NEVER;
      }
      return parsed;
    }),
  sortBy: z.string().optional().default("checkedAt"),
  sortOrder: z.enum(SORT_ORDERS).optional().default("desc"),
  page: z
    .string()
    .optional()
    .transform((val, ctx) => {
      if (!val) return 1;
      const parsed = parseInt(val);
      if (isNaN(parsed) || parsed < 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Page must be a positive integer",
        });
        return z.NEVER;
      }
      return parsed;
    }),
  limit: z
    .string()
    .optional()
    .transform((val, ctx) => {
      if (!val) return 20;
      const parsed = parseInt(val);
      if (isNaN(parsed) || parsed < 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Limit must be a positive integer",
        });
        return z.NEVER;
      }
      return Math.min(parsed, 100); // Maximum 100 connectivity entries per page
    }),
});

/**
 * GET /api/settings/connectivity - List connectivity status logs with filtering and pagination
 */
router.get("/", requirePermission('settings:read') as RequestHandler, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const user = getAuthenticatedUser(req);
  const userId = user?.id;

  logger.debug(
    {
      requestId,
      userId,
      query: req.query,
    },
    "Connectivity status requested",
  );

  try {
    // Validate query parameters
    const queryValidation = connectivityQuerySchema.safeParse(req.query);
    if (!queryValidation.success) {
      logger.warn(
        {
          requestId,
          userId,
          validationErrors: queryValidation.error.issues,
        },
        "Invalid query parameters for connectivity status",
      );

      return res.status(400).json({
        error: "Bad Request",
        message: "Invalid query parameters",
        details: queryValidation.error.issues,
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    const {
      service,
      status,
      checkInitiatedBy,
      startDate,
      endDate,
      sortBy,
      sortOrder,
      page,
      limit,
    } = queryValidation.data;

    // Build filter conditions
    const where: Prisma.ConnectivityStatusWhereInput = {};
    if (service) where.service = service;
    if (status) where.status = status;
    if (checkInitiatedBy) where.checkInitiatedBy = checkInitiatedBy;
    if (startDate || endDate) {
      where.checkedAt = {};
      if (startDate) where.checkedAt.gte = startDate;
      if (endDate) where.checkedAt.lte = endDate;
    }

    // Build sort conditions
    const orderBy: Prisma.ConnectivityStatusOrderByWithRelationInput = {};
    (orderBy as Record<string, unknown>)[sortBy] = sortOrder;

    // Calculate pagination
    const skip = (page - 1) * limit;

    // Fetch connectivity status entries with filtering and pagination
    const [connectivityEntries, totalCount] = await Promise.all([
      prisma.connectivityStatus.findMany({
        where,
        orderBy,
        skip,
        take: limit,
      }),
      prisma.connectivityStatus.count({ where }),
    ]);

    // Serialize connectivity entries for API response
    const serializedConnectivityEntries = connectivityEntries.map(
      serializeConnectivityStatus,
    );

    logger.debug(
      {
        requestId,
        userId,
        totalConnectivityEntries: totalCount,
        returnedConnectivityEntries: serializedConnectivityEntries.length,
        filters: {
          service,
          status,
          checkInitiatedBy,
          startDate: startDate?.toISOString(),
          endDate: endDate?.toISOString(),
        },
        sortBy,
        sortOrder,
        page,
        limit,
      },
      "Connectivity status returned successfully",
    );

    const totalPages = Math.ceil(totalCount / limit);
    const hasNextPage = page < totalPages;
    const hasPreviousPage = page > 1;

    const response: ConnectivityStatusListResponse = {
      success: true,
      data: serializedConnectivityEntries,
      totalCount,
      page,
      limit,
      totalPages,
      hasNextPage,
      hasPreviousPage,
      message: `Found ${totalCount} connectivity status entries`,
    };

    res.json(response);
  } catch (error) {
    logger.error(
      {
        error,
        requestId,
        userId,
        query: req.query,
      },
      "Failed to fetch connectivity status",
    );

    next(error);
  }
}) as RequestHandler);

/**
 * GET /api/settings/connectivity/summary - Latest status per service (one row each)
 */
router.get("/summary", requirePermission('settings:read') as RequestHandler, (async (
  _req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const services = [
      "docker",
      "cloudflare",
      "storage",
      "github-app",
      "tls",
    ];

    const [results, defaultContainerSetting] = await Promise.all([
      Promise.all(
        services.map((service) =>
          prisma.connectivityStatus.findFirst({
            where: { service },
            orderBy: { checkedAt: "desc" },
          }),
        ),
      ),
      prisma.systemSettings.findFirst({
        where: {
          category: "system",
          key: "default_postgres_backup_container",
          isActive: true,
        },
      }),
    ]);

    const summary: Record<string, { status: string; checkedAt: string; errorMessage: string | null; defaultPostgresContainer?: string | null }> = {};
    for (let i = 0; i < services.length; i++) {
      const entry = results[i];
      if (entry) {
        summary[services[i]] = {
          status: entry.status,
          checkedAt: entry.checkedAt.toISOString(),
          errorMessage: entry.errorMessage,
        };
      } else {
        summary[services[i]] = {
          status: "unknown",
          checkedAt: "",
          errorMessage: "No connectivity check recorded",
        };
      }
    }

    // Add default postgres backup container to the storage entry
    if (summary["storage"]) {
      summary["storage"].defaultPostgresContainer =
        defaultContainerSetting?.value || null;
    }

    res.json({ success: true, data: summary });
  } catch (error) {
    next(error);
  }
}) as RequestHandler);

export default router;
