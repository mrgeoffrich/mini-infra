import express, {
  Request,
  Response,
  NextFunction,
  RequestHandler,
} from "express";
import { z } from "zod";
import DockerService from "../services/docker";
import { appLogger } from "../lib/logger-factory";
import { trace } from "@opentelemetry/api";

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
 * @swagger
 * /api/containers:
 *   get:
 *     summary: List Docker containers
 *     description: Retrieve a paginated list of Docker containers with optional filtering and sorting
 *     tags:
 *       - Containers
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     parameters:
 *       - name: page
 *         in: query
 *         description: Page number for pagination
 *         required: false
 *         schema:
 *           type: integer
 *           minimum: 1
 *           default: 1
 *       - name: limit
 *         in: query
 *         description: Number of containers per page (max 50)
 *         required: false
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 50
 *           default: 50
 *       - name: sortBy
 *         in: query
 *         description: Field to sort by
 *         required: false
 *         schema:
 *           type: string
 *           default: "name"
 *       - name: sortOrder
 *         in: query
 *         description: Sort order
 *         required: false
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *           default: "asc"
 *       - name: status
 *         in: query
 *         description: Filter by container status
 *         required: false
 *         schema:
 *           type: string
 *       - name: name
 *         in: query
 *         description: Filter by container name
 *         required: false
 *         schema:
 *           type: string
 *       - name: image
 *         in: query
 *         description: Filter by container image
 *         required: false
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Successfully retrieved containers
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
 *                     containers:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/ContainerInfo'
 *                     pagination:
 *                       type: object
 *                       properties:
 *                         page:
 *                           type: integer
 *                         limit:
 *                           type: integer
 *                         total:
 *                           type: integer
 *                         totalPages:
 *                           type: integer
 *       400:
 *         description: Invalid query parameters
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
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

    // Test manual span to verify debug processors
    const tracer = trace.getTracer("test-tracer");
    const testSpan = tracer.startSpan("test.manual.span");
    testSpan.setAttributes({
      "test.manual": true,
      "test.timestamp": Date.now(),
      "test.user": userId || "unknown"
    });
    testSpan.end();

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

    logger.debug(
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
    logger.debug(
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
 * @swagger
 * /api/containers/{id}:
 *   get:
 *     summary: Get specific container details
 *     description: Retrieve detailed information about a specific Docker container by its ID
 *     tags:
 *       - Containers
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *       - ApiKeyAuthBearer: []
 *     parameters:
 *       - $ref: '#/components/parameters/ContainerIdParam'
 *     responses:
 *       200:
 *         description: Container details retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ContainerInfo'
 *             example:
 *               id: 'abc123def456'
 *               name: 'nginx-web-server'
 *               image: 'nginx:latest'
 *               state: 'running'
 *               status: 'Up 2 hours'
 *               createdAt: '2025-09-24T10:00:00.000Z'
 *               startedAt: '2025-09-24T10:00:05.000Z'
 *               ports:
 *                 - privatePort: 80
 *                   publicPort: 8080
 *                   type: 'tcp'
 *               labels:
 *                 'com.docker.compose.service': 'web'
 *               networks:
 *                 - 'bridge'
 *       400:
 *         description: Invalid container ID format
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             example:
 *               success: false
 *               error: 'Bad Request'
 *               message: 'Invalid container ID format'
 *               timestamp: '2025-09-24T12:00:00.000Z'
 *       401:
 *         description: Authentication required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: Container not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             example:
 *               success: false
 *               error: 'Not Found'
 *               message: 'Container with ID abc123 not found'
 *               timestamp: '2025-09-24T12:00:00.000Z'
 *       503:
 *         description: Docker service unavailable
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       504:
 *         description: Docker API timeout
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
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

  logger.debug(
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

    logger.debug(
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
 * @swagger
 * /api/containers/stats/cache:
 *   get:
 *     summary: Get container cache statistics
 *     description: Retrieve debugging information about the Docker container cache, including cache hit rates and entry counts
 *     tags:
 *       - Containers
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *       - ApiKeyAuthBearer: []
 *     responses:
 *       200:
 *         description: Cache statistics retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 cache:
 *                   $ref: '#/components/schemas/ContainerCacheStats'
 *                 dockerConnected:
 *                   type: boolean
 *                   description: Whether Docker service is connected
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                   description: Response timestamp
 *                 requestId:
 *                   type: string
 *                   description: Request correlation ID
 *               required:
 *                 - cache
 *                 - dockerConnected
 *                 - timestamp
 *             example:
 *               cache:
 *                 totalEntries: 25
 *                 activeEntries: 23
 *                 expiredEntries: 2
 *                 oldestEntry: '2025-09-24T10:30:00.000Z'
 *                 newestEntry: '2025-09-24T12:00:00.000Z'
 *               dockerConnected: true
 *               timestamp: '2025-09-24T12:00:00.000Z'
 *               requestId: 'req-abc123'
 *       401:
 *         description: Authentication required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
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
 * @swagger
 * /api/containers/cache/flush:
 *   post:
 *     summary: Flush container cache
 *     description: Clear all cached Docker container data to force fresh retrieval from Docker API on next request. Useful for debugging or when data inconsistency is suspected.
 *     tags:
 *       - Containers
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *       - ApiKeyAuthBearer: []
 *     responses:
 *       200:
 *         description: Cache flushed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: 'Container cache flushed successfully'
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                   description: Response timestamp
 *                 requestId:
 *                   type: string
 *                   description: Request correlation ID
 *               required:
 *                 - message
 *                 - timestamp
 *             example:
 *               message: 'Container cache flushed successfully'
 *               timestamp: '2025-09-24T12:00:00.000Z'
 *               requestId: 'req-abc123'
 *       401:
 *         description: Authentication required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.post("/cache/flush", requireSessionOrApiKey, (async (
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
    "Container cache flush requested",
  );

  const dockerService = DockerService.getInstance();
  dockerService.flushCache();

  logger.debug(
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
