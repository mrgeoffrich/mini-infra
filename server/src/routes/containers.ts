import express, {
  Request,
  Response,
  NextFunction,
  RequestHandler,
} from "express";
import { z } from "zod";
import DockerService from "../services/docker";
import { appLogger } from "../lib/logger-factory";

const logger = appLogger();
import { requireSessionOrApiKey, getAuthenticatedUser } from "../middleware/auth";
import {
  ContainerQueryParams,
  ContainerListResponse,
  ContainerListApiResponse,
  ContainerInfo,
  DockerContainerInfo,
} from "@mini-infra/types/containers";

const router = express.Router();

// Helper function to convert DockerContainerInfo to ContainerInfo for API responses
function serializeContainer(container: DockerContainerInfo): ContainerInfo {
  return {
    ...container,
    createdAt: container.createdAt.toISOString(),
    startedAt: container.startedAt?.toISOString(),
  };
}

// Query parameter validation schema
const containerQuerySchema = z.object({
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
      if (!val) return 50;
      const parsed = parseInt(val);
      if (isNaN(parsed) || parsed < 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Limit must be a positive integer",
        });
        return z.NEVER;
      }
      return Math.min(parsed, 50); // Maximum 50 containers per page
    }),
  sortBy: z.string().optional().default("name"),
  sortOrder: z.enum(["asc", "desc"]).optional().default("asc"),
  status: z.string().optional(),
  name: z.string().optional(),
  image: z.string().optional(),
});

/**
 * GET /api/containers - List containers with pagination and filtering
 */
router.get("/", requireSessionOrApiKey, (async (
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
    "Container list requested",
  );

  try {
    // Validate query parameters
    const queryValidation = containerQuerySchema.safeParse(req.query);
    if (!queryValidation.success) {
      logger.warn(
        {
          requestId,
          userId,
          validationErrors: queryValidation.error.issues,
        },
        "Invalid query parameters for container list",
      );

      return res.status(400).json({
        error: "Bad Request",
        message: "Invalid query parameters",
        details: queryValidation.error.issues,
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    const queryParams: ContainerQueryParams = queryValidation.data;
    const dockerService = DockerService.getInstance();

    // Check Docker service connectivity
    if (!dockerService.isConnected()) {
      logger.error(
        {
          requestId,
          userId,
        },
        "Docker service not connected",
      );

      return res.status(503).json({
        error: "Service Unavailable",
        message: "Docker service is not available. Please try again later.",
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    // Fetch containers from Docker service
    let dockerContainers = await dockerService.listContainers(true);
    let containers = dockerContainers.map(serializeContainer);

    // Apply filtering
    if (queryParams.status) {
      containers = containers.filter(
        (container) => container.status === queryParams.status,
      );
    }

    if (queryParams.name) {
      const nameFilter = queryParams.name.toLowerCase();
      containers = containers.filter((container) =>
        container.name.toLowerCase().includes(nameFilter),
      );
    }

    if (queryParams.image) {
      const imageFilter = queryParams.image.toLowerCase();
      containers = containers.filter((container) =>
        container.image.toLowerCase().includes(imageFilter),
      );
    }

    // Apply sorting
    containers.sort((a, b) => {
      const field = queryParams.sortBy || "name";
      const order = queryParams.sortOrder || "asc";

      let aValue: any = a[field as keyof typeof a];
      let bValue: any = b[field as keyof typeof b];

      // Handle date sorting
      if (aValue instanceof Date && bValue instanceof Date) {
        return order === "asc"
          ? aValue.getTime() - bValue.getTime()
          : bValue.getTime() - aValue.getTime();
      }

      // Handle string sorting
      if (typeof aValue === "string" && typeof bValue === "string") {
        aValue = aValue.toLowerCase();
        bValue = bValue.toLowerCase();
      }

      if (aValue < bValue) return order === "asc" ? -1 : 1;
      if (aValue > bValue) return order === "asc" ? 1 : -1;
      return 0;
    });

    const totalCount = containers.length;

    // Apply pagination
    const page = queryParams.page || 1;
    const limit = queryParams.limit || 50;
    const startIndex = (page - 1) * limit;
    const endIndex = startIndex + limit;
    const paginatedContainers = containers.slice(startIndex, endIndex);

    const response: ContainerListResponse = {
      containers: paginatedContainers,
      totalCount,
      lastUpdated: new Date().toISOString(),
      page,
      limit,
    };

    logger.info(
      {
        requestId,
        userId,
        totalContainers: totalCount,
        returnedContainers: paginatedContainers.length,
        page,
        limit,
        cacheStats: dockerService.getCacheStats(),
      },
      "Container list returned successfully",
    );

    // Log business event
    logger.info(
      {
        event: "container_list_viewed",
        userId,
        requestId,
        containerCount: totalCount,
        filters: {
          status: queryParams.status,
          name: queryParams.name,
          image: queryParams.image,
        },
        sortBy: queryParams.sortBy,
        sortOrder: queryParams.sortOrder,
      },
      "Business event: container list viewed",
    );

    const apiResponse: ContainerListApiResponse = {
      success: true,
      data: response,
    };

    res.json(apiResponse);
  } catch (error) {
    logger.error(
      {
        error,
        requestId,
        userId,
        query: req.query,
      },
      "Failed to fetch container list",
    );

    // Check if it's a Docker connectivity error
    if (
      error instanceof Error &&
      error.message.includes("Docker service not connected")
    ) {
      return res.status(503).json({
        error: "Service Unavailable",
        message:
          "Docker service is temporarily unavailable. Please try again later.",
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    // Handle timeout errors
    if (error instanceof Error && error.message.includes("timeout")) {
      return res.status(504).json({
        error: "Gateway Timeout",
        message: "Docker API request timed out. Please try again.",
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    next(error);
  }
}) as RequestHandler);

/**
 * GET /api/containers/:id - Get specific container details
 */
router.get("/:id", requireSessionOrApiKey, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const user = getAuthenticatedUser(req);
  const userId = user?.id;
  const containerId = req.params.id;

  logger.info(
    {
      requestId,
      userId,
      containerId,
    },
    "Container details requested",
  );

  try {
    // Validate container ID format
    if (!containerId || containerId.length < 12) {
      return res.status(400).json({
        error: "Bad Request",
        message: "Invalid container ID format",
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    const dockerService = DockerService.getInstance();

    // Check Docker service connectivity
    if (!dockerService.isConnected()) {
      logger.error(
        {
          requestId,
          userId,
          containerId,
        },
        "Docker service not connected",
      );

      return res.status(503).json({
        error: "Service Unavailable",
        message: "Docker service is not available. Please try again later.",
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    const dockerContainer = await dockerService.getContainer(containerId);

    if (!dockerContainer) {
      logger.warn(
        {
          requestId,
          userId,
          containerId,
        },
        "Container not found",
      );

      return res.status(404).json({
        error: "Not Found",
        message: `Container with ID '${containerId}' not found`,
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    logger.info(
      {
        requestId,
        userId,
        containerId,
        containerName: dockerContainer.name,
        containerStatus: dockerContainer.status,
      },
      "Container details returned successfully",
    );

    res.json(serializeContainer(dockerContainer));
  } catch (error) {
    logger.error(
      {
        error,
        requestId,
        userId,
        containerId,
      },
      "Failed to fetch container details",
    );

    // Handle specific Docker API errors
    if (error instanceof Error && error.message.includes("timeout")) {
      return res.status(504).json({
        error: "Gateway Timeout",
        message: "Docker API request timed out. Please try again.",
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    next(error);
  }
}) as RequestHandler);

/**
 * GET /api/containers/stats/cache - Get cache statistics (for debugging)
 */
router.get("/stats/cache", requireSessionOrApiKey, (async (
  req: Request,
  res: Response,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const user = getAuthenticatedUser(req);
  const userId = user?.id;

  logger.debug(
    {
      requestId,
      userId,
    },
    "Cache statistics requested",
  );

  const dockerService = DockerService.getInstance();
  const cacheStats = dockerService.getCacheStats();

  res.json({
    cache: cacheStats,
    dockerConnected: dockerService.isConnected(),
    timestamp: new Date().toISOString(),
    requestId,
  });
}) as RequestHandler);

/**
 * POST /api/containers/cache/flush - Flush container cache (for debugging)
 */
router.post("/cache/flush", requireSessionOrApiKey, (async (
  req: Request,
  res: Response,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const user = getAuthenticatedUser(req);
  const userId = user?.id;

  logger.info(
    {
      requestId,
      userId,
    },
    "Container cache flush requested",
  );

  const dockerService = DockerService.getInstance();
  dockerService.flushCache();

  logger.info(
    {
      requestId,
      userId,
    },
    "Container cache flushed successfully",
  );

  res.json({
    message: "Container cache flushed successfully",
    timestamp: new Date().toISOString(),
    requestId,
  });
}) as RequestHandler);

export default router;
