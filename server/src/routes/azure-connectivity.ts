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
import { requireSessionOrApiKey, getAuthenticatedUser } from "../middleware/auth";
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
 * @swagger
 * /api/connectivity/azure:
 *   get:
 *     summary: Get latest Azure connectivity status
 *     description: Retrieve the most recent connectivity check result for Azure services
 *     tags:
 *       - Connectivity
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *       - ApiKeyAuthBearer: []
 *     responses:
 *       200:
 *         description: Azure connectivity status retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                       example: "conn_azure_123"
 *                     service:
 *                       type: string
 *                       example: "azure"
 *                     status:
 *                       type: string
 *                       enum: [connected, failed, timeout, unreachable]
 *                       example: "connected"
 *                     responseTimeMs:
 *                       type: number
 *                       nullable: true
 *                       example: 245
 *                     errorMessage:
 *                       type: string
 *                       nullable: true
 *                       example: null
 *                     errorCode:
 *                       type: string
 *                       nullable: true
 *                       example: null
 *                     lastSuccessfulAt:
 *                       type: string
 *                       format: date-time
 *                       nullable: true
 *                       example: "2024-01-15T10:30:00.000Z"
 *                     checkedAt:
 *                       type: string
 *                       format: date-time
 *                       example: "2024-01-15T10:30:00.000Z"
 *                     checkInitiatedBy:
 *                       type: string
 *                       nullable: true
 *                       example: "system"
 *                     metadata:
 *                       type: object
 *                       nullable: true
 *                       example: {"region": "eastus", "endpoint": "storage.azure.com"}
 *                 message:
 *                   type: string
 *                   example: "Azure connectivity status: connected"
 *       401:
 *         description: Authentication required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: No connectivity status found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 message:
 *                   type: string
 *                   example: "No Azure connectivity status found"
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                   example: "2024-01-15T10:30:00.000Z"
 *                 requestId:
 *                   type: string
 *                   example: "req_123"
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *
 * GET /api/connectivity/azure - Get latest Azure connectivity status
 */
router.get("/", requireSessionOrApiKey, (async (
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
      logger.debug(
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

    logger.debug(
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
 * @swagger
 * /api/connectivity/azure/history:
 *   get:
 *     summary: Get Azure connectivity history
 *     description: Retrieve paginated history of Azure connectivity checks with filtering and sorting options
 *     tags:
 *       - Connectivity
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *       - ApiKeyAuthBearer: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           minimum: 1
 *           default: 1
 *         description: Page number for pagination
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 20
 *         description: Number of items per page
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [connected, failed, timeout, unreachable]
 *         description: Filter by connectivity status
 *         example: "connected"
 *       - in: query
 *         name: startDate
 *         schema:
 *           type: string
 *           format: date-time
 *         description: Filter records from this date onwards (ISO 8601)
 *         example: "2024-01-01T00:00:00.000Z"
 *       - in: query
 *         name: endDate
 *         schema:
 *           type: string
 *           format: date-time
 *         description: Filter records up to this date (ISO 8601)
 *         example: "2024-01-31T23:59:59.999Z"
 *       - in: query
 *         name: sortBy
 *         schema:
 *           type: string
 *           enum: [checkedAt, status, responseTimeMs]
 *           default: checkedAt
 *         description: Field to sort by
 *       - in: query
 *         name: sortOrder
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *           default: desc
 *         description: Sort order
 *     responses:
 *       200:
 *         description: Azure connectivity history retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                         example: "conn_azure_123"
 *                       service:
 *                         type: string
 *                         example: "azure"
 *                       status:
 *                         type: string
 *                         enum: [connected, failed, timeout, unreachable]
 *                         example: "connected"
 *                       responseTimeMs:
 *                         type: number
 *                         nullable: true
 *                         example: 245
 *                       errorMessage:
 *                         type: string
 *                         nullable: true
 *                       errorCode:
 *                         type: string
 *                         nullable: true
 *                       lastSuccessfulAt:
 *                         type: string
 *                         format: date-time
 *                         nullable: true
 *                         example: "2024-01-15T10:30:00.000Z"
 *                       checkedAt:
 *                         type: string
 *                         format: date-time
 *                         example: "2024-01-15T10:30:00.000Z"
 *                       checkInitiatedBy:
 *                         type: string
 *                         nullable: true
 *                         example: "system"
 *                       metadata:
 *                         type: object
 *                         nullable: true
 *                 totalCount:
 *                   type: integer
 *                   example: 150
 *                 page:
 *                   type: integer
 *                   example: 1
 *                 limit:
 *                   type: integer
 *                   example: 20
 *                 totalPages:
 *                   type: integer
 *                   example: 8
 *                 hasNextPage:
 *                   type: boolean
 *                   example: true
 *                 hasPreviousPage:
 *                   type: boolean
 *                   example: false
 *                 message:
 *                   type: string
 *                   example: "Found 20 Azure connectivity status records"
 *       400:
 *         description: Bad request - invalid query parameters
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Bad Request"
 *                 message:
 *                   type: string
 *                   example: "Invalid query parameters"
 *                 details:
 *                   type: array
 *                   items:
 *                     type: object
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                   example: "2024-01-15T10:30:00.000Z"
 *                 requestId:
 *                   type: string
 *                   example: "req_456"
 *       401:
 *         description: Authentication required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *
 * GET /api/connectivity/azure/history - Get Azure connectivity status history with pagination
 */
router.get("/history", requireSessionOrApiKey, (async (
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

    logger.debug(
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
