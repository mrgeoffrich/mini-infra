/**
 * Storage Connectivity API Routes (provider-agnostic).
 *
 * Mounted under `/api/connectivity/storage`. Replaces the old
 * `/api/connectivity/azure` surface with rows recorded under
 * `service="storage"`.
 */

import express, {
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from "express";
import { z } from "zod";
import NodeCache from "node-cache";
import { getLogger } from "../lib/logger-factory";
import { requirePermission, getAuthenticatedUser } from "../middleware/auth";
import prisma from "../lib/prisma";
import { Prisma } from "../generated/prisma/client";
import {
  CONNECTIVITY_STATUS_TYPES,
  ConnectivityStatusListResponse,
  ConnectivityStatusResponse,
  SORT_ORDERS,
} from "@mini-infra/types";

const logger = getLogger("integrations", "storage-connectivity");
const router = express.Router();

const latestStatusCache = new NodeCache({ stdTTL: 30, checkperiod: 10 });
const historyCache = new NodeCache({ stdTTL: 120, checkperiod: 30 });

const historyQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  status: z.enum(CONNECTIVITY_STATUS_TYPES).optional(),
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),
  sortBy: z.enum(["checkedAt", "status", "responseTimeMs"]).default("checkedAt"),
  sortOrder: z.enum(SORT_ORDERS).default("desc"),
});

router.get("/", requirePermission("storage:read") as RequestHandler, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const userId = getAuthenticatedUser(req)?.id;
  try {
    const cacheKey = "storage_latest_status";
    const cached = latestStatusCache.get(cacheKey) as
      | ConnectivityStatusResponse
      | undefined;
    if (cached) return res.json(cached);

    const latestStatus = await prisma.connectivityStatus.findFirst({
      where: { service: "storage" },
      orderBy: { checkedAt: "desc" },
    });
    if (!latestStatus) {
      return res.status(404).json({
        success: false,
        message: "No storage connectivity status found",
        timestamp: new Date().toISOString(),
        requestId,
      });
    }
    const response: ConnectivityStatusResponse = {
      success: true,
      data: {
        id: latestStatus.id,
        service: latestStatus.service,
        status: latestStatus.status,
        responseTimeMs:
          latestStatus.responseTimeMs != null
            ? Number(latestStatus.responseTimeMs)
            : null,
        errorMessage: latestStatus.errorMessage,
        errorCode: latestStatus.errorCode,
        lastSuccessfulAt: latestStatus.lastSuccessfulAt?.toISOString() ?? null,
        checkedAt: latestStatus.checkedAt.toISOString(),
        checkInitiatedBy: latestStatus.checkInitiatedBy,
        metadata: latestStatus.metadata,
      },
      message: `Storage connectivity status: ${latestStatus.status}`,
    };
    latestStatusCache.set(cacheKey, response);
    res.json(response);
  } catch (error) {
    logger.error(
      {
        error,
        requestId,
        userId,
      },
      "Failed to fetch storage connectivity status",
    );
    next(error);
  }
}) as RequestHandler);

router.get("/history", requirePermission("storage:read") as RequestHandler, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const userId = getAuthenticatedUser(req)?.id;
  try {
    const queryValidation = historyQuerySchema.safeParse(req.query);
    if (!queryValidation.success) {
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
    const cacheKey = `storage_history_${page}_${limit}_${status ?? "all"}_${
      startDate?.toISOString() ?? "nostart"
    }_${endDate?.toISOString() ?? "noend"}_${sortBy}_${sortOrder}`;
    const cached = historyCache.get(cacheKey) as
      | ConnectivityStatusListResponse
      | undefined;
    if (cached) return res.json(cached);

    const where: Prisma.ConnectivityStatusWhereInput = { service: "storage" };
    if (status) where.status = status;
    if (startDate && endDate) where.checkedAt = { gte: startDate, lte: endDate };
    else if (startDate) where.checkedAt = { gte: startDate };
    else if (endDate) where.checkedAt = { lte: endDate };

    const skip = (page - 1) * limit;
    const totalCount = await prisma.connectivityStatus.count({ where });
    const records = await prisma.connectivityStatus.findMany({
      where,
      orderBy: { [sortBy]: sortOrder },
      skip,
      take: limit,
    });
    const totalPages = Math.ceil(totalCount / limit);
    const response: ConnectivityStatusListResponse = {
      success: true,
      data: records.map((r) => ({
        id: r.id,
        service: r.service,
        status: r.status,
        responseTimeMs:
          r.responseTimeMs != null ? Number(r.responseTimeMs) : null,
        errorMessage: r.errorMessage,
        errorCode: r.errorCode,
        lastSuccessfulAt: r.lastSuccessfulAt?.toISOString() ?? null,
        checkedAt: r.checkedAt.toISOString(),
        checkInitiatedBy: r.checkInitiatedBy,
        metadata: r.metadata,
      })),
      totalCount,
      page,
      limit,
      totalPages,
      hasNextPage: page < totalPages,
      hasPreviousPage: page > 1,
      message: `Found ${records.length} storage connectivity records`,
    };
    historyCache.set(cacheKey, response);
    res.json(response);
  } catch (error) {
    logger.error(
      { error, requestId, userId },
      "Failed to fetch storage connectivity history",
    );
    next(error);
  }
}) as RequestHandler);

export default router;
