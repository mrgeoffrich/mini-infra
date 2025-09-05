import express, {
  Request,
  Response,
  NextFunction,
  RequestHandler,
} from "express";
import { z } from "zod";
import NodeCache from "node-cache";
import { appLogger } from "../lib/logger-factory";

const logger = appLogger();
import { requireAuth, getAuthenticatedUser } from "../lib/auth-middleware";
import prisma from "../lib/prisma";
import {
  ConnectivityStatusListResponse,
  ConnectivityStatusResponse,
  ConnectivityStatusFilter,
  ConnectivityStatusSortOptions,
} from "@mini-infra/types";

const router = express.Router();

// Initialize cache for connectivity status responses
// Latest status cache: 30 seconds TTL (to provide fresh status with reasonable caching)
// History cache: 2 minutes TTL (history data changes less frequently)
const latestStatusCache = new NodeCache({ stdTTL: 30, checkperiod: 10 });
const historyCache = new NodeCache({ stdTTL: 120, checkperiod: 30 });

// Request validation schemas
const connectivityHistoryQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  status: z.enum(["connected", "failed", "timeout", "unreachable"]).optional(),
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),
  sortBy: z
    .enum(["checkedAt", "status", "responseTimeMs"])
    .default("checkedAt"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
});

/**
 * GET /api/connectivity/azure - Get latest Azure connectivity status
 */
router.get("/", requireAuth, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const user = getAuthenticatedUser(req);
  const userId = user?.id;

  logger.info(
    {
      requestId,
      userId,
    },
    "Azure connectivity status requested",
  );

  try {
    // Check cache first
    const cacheKey = "azure_latest_status";
    const cachedResponse = latestStatusCache.get(
      cacheKey,
    ) as ConnectivityStatusResponse;

    if (cachedResponse) {
      logger.debug(
        {
          requestId,
          userId,
        },
        "Azure connectivity status returned from cache",
      );

      return res.json(cachedResponse);
    }

    // Get the latest connectivity status for Azure service
    const latestStatus = await prisma.connectivityStatus.findFirst({
      where: {
        service: "azure",
      },
      orderBy: {
        checkedAt: "desc",
      },
    });

    if (!latestStatus) {
      logger.info(
        {
          requestId,
          userId,
        },
        "No Azure connectivity status found",
      );

      return res.status(404).json({
        success: false,
        message: "No Azure connectivity status found",
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    // Convert database response to API response format
    const response: ConnectivityStatusResponse = {
      success: true,
      data: {
        id: latestStatus.id,
        service: latestStatus.service,
        status: latestStatus.status,
        responseTimeMs: latestStatus.responseTimeMs
          ? Number(latestStatus.responseTimeMs)
          : null,
        errorMessage: latestStatus.errorMessage,
        errorCode: latestStatus.errorCode,
        lastSuccessfulAt: latestStatus.lastSuccessfulAt?.toISOString() || null,
        checkedAt: latestStatus.checkedAt.toISOString(),
        checkInitiatedBy: latestStatus.checkInitiatedBy,
        metadata: latestStatus.metadata,
      },
      message: `Azure connectivity status: ${latestStatus.status}`,
    };

    // Cache the response
    latestStatusCache.set(cacheKey, response);

    logger.info(
      {
        requestId,
        userId,
        status: latestStatus.status,
        responseTimeMs: latestStatus.responseTimeMs
          ? Number(latestStatus.responseTimeMs)
          : null,
        checkedAt: latestStatus.checkedAt,
      },
      "Azure connectivity status returned successfully",
    );

    res.json(response);
  } catch (error) {
    logger.error(
      {
        error,
        requestId,
        userId,
      },
      "Failed to fetch Azure connectivity status",
    );

    next(error);
  }
}) as RequestHandler);

/**
 * GET /api/connectivity/azure/history - Get Azure connectivity status history with pagination
 */
router.get("/history", requireAuth, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const user = getAuthenticatedUser(req);
  const userId = user?.id;

  logger.info(
    {
      requestId,
      userId,
      query: req.query,
    },
    "Azure connectivity history requested",
  );

  try {
    // Validate query parameters
    const queryValidation = connectivityHistoryQuerySchema.safeParse(req.query);
    if (!queryValidation.success) {
      logger.warn(
        {
          requestId,
          userId,
          validationErrors: queryValidation.error.issues,
        },
        "Invalid query parameters for Azure connectivity history",
      );

      return res.status(400).json({
        error: "Bad Request",
        message: "Invalid query parameters",
        details: queryValidation.error.issues,
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    const { page, limit, status, startDate, endDate, sortBy, sortOrder } =
      queryValidation.data;

    // Create cache key based on query parameters
    const cacheKey = `azure_history_${page}_${limit}_${status || "all"}_${startDate?.toISOString() || "nostart"}_${endDate?.toISOString() || "noend"}_${sortBy}_${sortOrder}`;

    // Check cache first
    const cachedResponse = historyCache.get(
      cacheKey,
    ) as ConnectivityStatusListResponse;

    if (cachedResponse) {
      logger.debug(
        {
          requestId,
          userId,
          cacheKey,
        },
        "Azure connectivity history returned from cache",
      );

      return res.json(cachedResponse);
    }

    // Build filter conditions
    const whereConditions: any = {
      service: "azure",
    };

    if (status) {
      whereConditions.status = status;
    }

    if (startDate && endDate) {
      whereConditions.checkedAt = {
        gte: startDate,
        lte: endDate,
      };
    } else if (startDate) {
      whereConditions.checkedAt = {
        gte: startDate,
      };
    } else if (endDate) {
      whereConditions.checkedAt = {
        lte: endDate,
      };
    }

    // Calculate pagination
    const skip = (page - 1) * limit;

    // Get total count for pagination metadata
    const totalCount = await prisma.connectivityStatus.count({
      where: whereConditions,
    });

    // Get paginated results
    const connectivityHistory = await prisma.connectivityStatus.findMany({
      where: whereConditions,
      orderBy: {
        [sortBy]: sortOrder,
      },
      skip,
      take: limit,
    });

    // Calculate pagination metadata
    const totalPages = Math.ceil(totalCount / limit);
    const hasNextPage = page < totalPages;
    const hasPreviousPage = page > 1;

    // Convert database responses to API response format
    const historyData = connectivityHistory.map((status) => ({
      id: status.id,
      service: status.service,
      status: status.status,
      responseTimeMs: status.responseTimeMs
        ? Number(status.responseTimeMs)
        : null,
      errorMessage: status.errorMessage,
      errorCode: status.errorCode,
      lastSuccessfulAt: status.lastSuccessfulAt?.toISOString() || null,
      checkedAt: status.checkedAt.toISOString(),
      checkInitiatedBy: status.checkInitiatedBy,
      metadata: status.metadata,
    }));

    const response: ConnectivityStatusListResponse = {
      success: true,
      data: historyData,
      totalCount,
      page,
      limit,
      totalPages,
      hasNextPage,
      hasPreviousPage,
      message: `Found ${historyData.length} Azure connectivity status records`,
    };

    // Cache the response
    historyCache.set(cacheKey, response);

    logger.info(
      {
        requestId,
        userId,
        totalCount,
        page,
        limit,
        status,
        startDate,
        endDate,
        returnedCount: historyData.length,
      },
      "Azure connectivity history returned successfully",
    );

    res.json(response);
  } catch (error) {
    logger.error(
      {
        error,
        requestId,
        userId,
        query: req.query,
      },
      "Failed to fetch Azure connectivity history",
    );

    next(error);
  }
}) as RequestHandler);

export default router;
